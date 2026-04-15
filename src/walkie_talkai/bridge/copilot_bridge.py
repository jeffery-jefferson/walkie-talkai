"""
Python-side bridge that manages the Node.js Copilot SDK sidecar subprocess.

Communicates via JSON-line IPC over stdin/stdout with the sidecar process.
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import AsyncIterator
from dataclasses import dataclass
import sys

logger = logging.getLogger(__name__)


@dataclass
class SidecarEvent:
    """Represents an event from the sidecar."""
    type: str
    data: dict


class CopilotBridge:
    """Manages the Node.js Copilot SDK sidecar subprocess."""
    
    def __init__(self, sidecar_dir: str | Path | None = None):
        """
        Args:
            sidecar_dir: Path to the sidecar/ directory. 
                         Defaults to {project_root}/sidecar/
        """
        if sidecar_dir is None:
            # Navigate from bridge/ → walkie_talkai/ → src/ → project_root/ → sidecar/
            sidecar_dir = Path(__file__).resolve().parent.parent.parent.parent / "sidecar"
        
        self.sidecar_dir = Path(sidecar_dir)
        self.process: asyncio.subprocess.Process | None = None
        self.reader_task: asyncio.Task | None = None
        self.event_queue: asyncio.Queue[SidecarEvent] = asyncio.Queue()
        self.active_streams: dict[str, asyncio.Queue[str]] = {}
        self.stream_counter = 0
        self._running = False
        self._model: str | None = None
        self._system_prompt: str | None = None
        
    async def start(self, model: str, system_prompt: str) -> None:
        """Start the sidecar subprocess and initialize a Copilot session.
        
        1. Spawns `node index.mjs` in the sidecar directory
        2. Starts a background reader task for stdout
        3. Sends the init command
        4. Waits for the "ready" event
        """
        if self._running:
            logger.warning("Sidecar is already running")
            return
        
        self._model = model
        self._system_prompt = system_prompt
            
        logger.info(f"Starting sidecar in directory: {self.sidecar_dir}")
        
        # Verify sidecar directory and index.mjs exist
        if not self.sidecar_dir.exists():
            raise FileNotFoundError(f"Sidecar directory not found: {self.sidecar_dir}")
        
        index_mjs = self.sidecar_dir / "index.mjs"
        if not index_mjs.exists():
            raise FileNotFoundError(f"Sidecar index.mjs not found: {index_mjs}")
        
        try:
            # Start the Node.js sidecar process
            kwargs = {}
            if sys.platform == "win32":
                import subprocess as _sp
                kwargs["creationflags"] = _sp.CREATE_NO_WINDOW
            self.process = await asyncio.create_subprocess_exec(
                "node", "index.mjs",
                cwd=str(self.sidecar_dir),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                **kwargs
            )
            
            logger.info(f"Sidecar process started with PID: {self.process.pid}")
            
            # Start background reader for stdout
            self.reader_task = asyncio.create_task(self._read_stdout())
            
            # Also start stderr reader to capture debug info
            asyncio.create_task(self._read_stderr())
            
            # Send init command
            init_command = {
                "type": "init",
                "model": model,
                "systemPrompt": system_prompt
            }
            await self._send_command(init_command)
            
            # Wait for ready event with timeout
            try:
                ready_event = await asyncio.wait_for(
                    self._wait_for_event("ready"),
                    timeout=30.0
                )
                logger.info("Sidecar initialized successfully")
                self._running = True
                
            except asyncio.TimeoutError:
                await self.stop()
                raise RuntimeError("Timeout waiting for sidecar to initialize (30s)")
                
        except Exception as e:
            logger.error(f"Failed to start sidecar: {e}")
            if self.process:
                await self._cleanup_process()
            raise
    
    async def send(self, prompt: str) -> AsyncIterator[str]:
        """Send a prompt and yield streaming tokens.
        
        Usage:
            async for token in bridge.send("Hello"):
                print(token, end="", flush=True)
        """
        if not self._running:
            raise RuntimeError("Sidecar is not running")
        
        # Create a unique stream ID and queue for this request
        stream_id = f"stream_{self.stream_counter}"
        self.stream_counter += 1
        stream_queue: asyncio.Queue[str] = asyncio.Queue()
        self.active_streams[stream_id] = stream_queue
        
        try:
            # Send the prompt command
            send_command = {
                "type": "send",
                "prompt": prompt
            }
            await self._send_command(send_command)
            
            # Yield tokens as they arrive
            while True:
                try:
                    token = await stream_queue.get()
                    if token is None:  # End-of-stream marker
                        break
                    yield token
                except Exception as e:
                    logger.error(f"Error reading token from stream: {e}")
                    break
                    
        finally:
            # Clean up the stream
            self.active_streams.pop(stream_id, None)
    
    async def send_and_collect(self, prompt: str) -> str:
        """Send a prompt and return the full response text."""
        tokens = []
        async for token in self.send(prompt):
            tokens.append(token)
        return "".join(tokens)
    
    async def switch_model(self, model: str) -> None:
        """Switch the Copilot model (preserves conversation)."""
        if not self._running:
            raise RuntimeError("Sidecar is not running")
        
        switch_command = {
            "type": "switch_model",
            "model": model
        }
        await self._send_command(switch_command)
        
        # Wait for confirmation
        await self._wait_for_event("model_switched")
        logger.info(f"Model switched to: {model}")
    
    async def reset(self) -> None:
        """Reset the conversation (destroy and recreate session)."""
        if not self._running:
            raise RuntimeError("Sidecar is not running")
        
        reset_command = {"type": "reset"}
        await self._send_command(reset_command)
        
        # Wait for confirmation
        await self._wait_for_event("session_reset")
        logger.info("Conversation reset")
    
    async def stop(self) -> None:
        """Stop the sidecar subprocess and clean up."""
        if not self._running:
            logger.warning("Sidecar is not running")
            return
        
        logger.info("Stopping sidecar...")
        self._running = False
        
        # Send stop command if process is still running
        if self.process and self.process.returncode is None:
            try:
                stop_command = {"type": "stop"}
                await self._send_command(stop_command)
                
                # Wait briefly for clean exit
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=5.0)
                    logger.info("Sidecar exited cleanly")
                except asyncio.TimeoutError:
                    logger.warning("Sidecar didn't exit cleanly, force killing...")
                    self.process.kill()
                    await self.process.wait()
                    
            except Exception as e:
                logger.error(f"Error during graceful stop: {e}")
                if self.process:
                    self.process.kill()
                    await self.process.wait()
        
        # Cancel reader task
        if self.reader_task:
            self.reader_task.cancel()
            try:
                await self.reader_task
            except asyncio.CancelledError:
                pass
        
        await self._cleanup_process()
        logger.info("Sidecar stopped")
    
    @property
    def is_running(self) -> bool:
        """Whether the sidecar process is running."""
        return self._running and self.process is not None and self.process.returncode is None
    
    async def _auto_restart(self) -> None:
        """Attempt to restart the sidecar after a crash."""
        max_retries = 3
        for attempt in range(max_retries):
            logger.warning(f"Attempting sidecar restart ({attempt + 1}/{max_retries})...")
            try:
                await asyncio.sleep(2 * (attempt + 1))  # backoff
                await self._cleanup_process()
                if self._model and self._system_prompt:
                    await self.start(self._model, self._system_prompt)
                logger.info("Sidecar restarted successfully")
                return
            except Exception as e:
                logger.error(f"Restart attempt {attempt + 1} failed: {e}")
        logger.error("All restart attempts failed")
        self._running = False
    
    async def _send_command(self, command: dict) -> None:
        """Send a command to the sidecar via stdin."""
        if not self.process or not self.process.stdin:
            raise RuntimeError("Sidecar process not available")
        
        try:
            command_line = json.dumps(command) + "\n"
            self.process.stdin.write(command_line.encode())
            await self.process.stdin.drain()
            logger.debug(f"Sent command: {command['type']}")
        except Exception as e:
            logger.error(f"Failed to send command: {e}")
            raise
    
    async def _read_stdout(self) -> None:
        """Background task that reads and processes stdout from the sidecar."""
        if not self.process or not self.process.stdout:
            return
        
        try:
            while True:
                line = await self.process.stdout.readline()
                if not line:  # EOF
                    if self._running:
                        logger.error("Sidecar crashed (unexpected EOF)")
                        await self._auto_restart()
                    break
                
                try:
                    line_str = line.decode().strip()
                    if not line_str:
                        continue
                    
                    event_data = json.loads(line_str)
                    event = SidecarEvent(type=event_data["type"], data=event_data)
                    
                    logger.debug(f"Received event: {event.type}")
                    
                    # Route the event
                    await self._handle_event(event)
                    
                except json.JSONDecodeError as e:
                    logger.error(f"Invalid JSON from sidecar: {line_str} - {e}")
                except Exception as e:
                    logger.error(f"Error processing event: {e}")
                    
        except asyncio.CancelledError:
            logger.debug("Stdout reader cancelled")
        except Exception as e:
            logger.error(f"Error in stdout reader: {e}")
            self._running = False
    
    async def _read_stderr(self) -> None:
        """Background task that reads stderr from the sidecar for debugging."""
        if not self.process or not self.process.stderr:
            return
        
        try:
            while True:
                line = await self.process.stderr.readline()
                if not line:  # EOF
                    break
                
                line_str = line.decode().strip()
                if line_str:
                    logger.debug(f"Sidecar stderr: {line_str}")
                    
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Error reading stderr: {e}")
    
    async def _handle_event(self, event: SidecarEvent) -> None:
        """Handle an event from the sidecar."""
        if event.type == "token":
            # Send token to all active streams
            content = event.data.get("content", "")
            for stream_queue in self.active_streams.values():
                await stream_queue.put(content)
                
        elif event.type == "done":
            # Signal end of stream to all active streams
            for stream_queue in self.active_streams.values():
                await stream_queue.put(None)  # End-of-stream marker
                
        elif event.type == "error":
            error_msg = event.data.get("message", "Unknown error")
            logger.error(f"Sidecar error: {error_msg}")
            # TODO: Could raise exception or handle differently based on error type
            
        # Always add to event queue for _wait_for_event
        await self.event_queue.put(event)
    
    async def _wait_for_event(self, event_type: str) -> SidecarEvent:
        """Wait for a specific event type from the sidecar."""
        while True:
            event = await self.event_queue.get()
            if event.type == event_type:
                return event
            elif event.type == "error":
                error_msg = event.data.get("message", "Unknown error")
                raise RuntimeError(f"Sidecar error while waiting for {event_type}: {error_msg}")
    
    async def _cleanup_process(self) -> None:
        """Clean up process resources."""
        if self.process:
            if self.process.stdin:
                self.process.stdin.close()
            self.process = None
        
        # Clear any remaining active streams
        for stream_queue in self.active_streams.values():
            await stream_queue.put(None)
        self.active_streams.clear()
        
        # Clear event queue
        while not self.event_queue.empty():
            try:
                self.event_queue.get_nowait()
            except asyncio.QueueEmpty:
                break