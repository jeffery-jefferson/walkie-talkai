"""WebSocket server for the walkie-talkai overlay."""
from __future__ import annotations

import asyncio
import errno
import logging
import time
from typing import Set

import websockets
from websockets.asyncio.server import serve, ServerConnection

from walkie_talkai.bridge.protocol import (
    CancelledEvent,
    DoneEvent,
    ErrorEvent,
    HideEvent,
    StatusEvent,
    TokenEvent,
    TranscriptEvent,
    to_json,
)

logger = logging.getLogger(__name__)


class OverlayServer:
    """WebSocket server for pushing real-time events to the overlay UI."""

    def __init__(self, host: str = "127.0.0.1", port: int = 8765):
        """Initialize the overlay server.

        Args:
            host: Host to bind to (default: localhost only for security).
            port: Port to bind to.
        """
        self.host = host
        self.port = port
        self._clients: Set[ServerConnection] = set()
        self._server = None

    async def start(self) -> None:
        """Start the WebSocket server, retrying if the port is still held by a dying instance."""
        deadline = time.monotonic() + 12  # wait up to 12 s for port to free up
        delay = 0.5
        while True:
            try:
                self._server = await serve(self._handle_client, self.host, self.port)
                logger.info(f"Overlay WebSocket server started on ws://{self.host}:{self.port}")
                return
            except OSError as exc:
                if exc.errno not in (errno.EADDRINUSE, 10048):
                    raise  # unexpected error — propagate immediately
                if time.monotonic() >= deadline:
                    raise  # still blocked after 12 s — give up
                logger.warning(
                    f"Port {self.port} still in use (previous instance shutting down?), "
                    f"retrying in {delay:.1f}s…"
                )
                await asyncio.sleep(delay)
                delay = min(delay * 1.5, 3.0)

    async def stop(self) -> None:
        """Stop the WebSocket server and close all connections."""
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            logger.info("Overlay WebSocket server stopped")

    async def _handle_client(self, websocket: ServerConnection) -> None:
        """Handle a client connection."""
        self._clients.add(websocket)
        logger.debug(f"Overlay client connected. Total: {len(self._clients)}")

        try:
            async for message in websocket:
                # Currently the server doesn't expect messages from clients,
                # but we consume them to keep the connection alive
                pass
        except websockets.ConnectionClosed:
            pass
        finally:
            self._clients.discard(websocket)
            logger.debug(f"Overlay client disconnected. Total: {len(self._clients)}")

    async def broadcast(self, event) -> None:
        """Send an event (protocol dataclass) to all connected overlay clients.

        Args:
            event: A protocol dataclass instance (StatusEvent, TranscriptEvent, etc.).
        """
        if not self._clients:
            return

        message = to_json(event)
        # Collect disconnected clients to remove them
        disconnected = set()

        for client in self._clients:
            try:
                await client.send(message)
            except websockets.ConnectionClosed:
                disconnected.add(client)

        # Remove any clients that have disconnected
        self._clients.difference_update(disconnected)

    async def send_status(self, state: str) -> None:
        """Convenience: broadcast a StatusEvent.

        Args:
            state: One of "recording", "processing", or "idle".
        """
        event = StatusEvent(state=state)
        await self.broadcast(event)

    async def send_transcript(self, text: str) -> None:
        """Convenience: broadcast a TranscriptEvent.

        Args:
            text: The transcript text.
        """
        event = TranscriptEvent(text=text)
        await self.broadcast(event)

    async def send_token(self, content: str) -> None:
        """Convenience: broadcast a TokenEvent.

        Args:
            content: The token content.
        """
        event = TokenEvent(content=content)
        await self.broadcast(event)

    async def send_done(self, full_text: str) -> None:
        """Convenience: broadcast a DoneEvent.

        Args:
            full_text: The complete final text.
        """
        event = DoneEvent(full_text=full_text)
        await self.broadcast(event)

    async def send_error(self, message: str) -> None:
        """Convenience: broadcast an ErrorEvent.

        Args:
            message: The error message.
        """
        event = ErrorEvent(message=message)
        await self.broadcast(event)

    async def send_cancelled(self, phrase: str = "scratch that", full_text: str = "") -> None:
        """Convenience: broadcast a CancelledEvent."""
        event = CancelledEvent(phrase=phrase, full_text=full_text)
        await self.broadcast(event)

    async def send_hide(self) -> None:
        """Convenience: broadcast a HideEvent."""
        event = HideEvent()
        await self.broadcast(event)

    @property
    def client_count(self) -> int:
        """Number of connected overlay clients."""
        return len(self._clients)
