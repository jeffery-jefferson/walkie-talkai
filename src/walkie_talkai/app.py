"""Main application orchestrator for walkie-talkai."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from walkie_talkai.bridge.copilot_bridge import CopilotBridge
from walkie_talkai.config import Config
from walkie_talkai.config_watcher import ConfigWatcher
from walkie_talkai.overlay.server import OverlayServer
from walkie_talkai.stt_pipeline import STTPipeline

logger = logging.getLogger(__name__)


def _read_custom_instructions(path: str) -> str | None:
    """Read custom instructions from a file, returning None on failure or empty content."""
    instructions_path = Path(path)
    if not instructions_path.exists():
        return None
    try:
        content = instructions_path.read_text(encoding="utf-8").strip()
        return content or None
    except Exception as e:
        logger.warning(f"Error reading custom instructions: {e}")
        return None


class WalkieTalkAI:
    """Main application orchestrator that connects STT pipeline → Copilot bridge → overlay."""
    
    def __init__(self, config: Config):
        """Initialize all components but don't start them yet."""
        self.config = config
        self._loop: asyncio.AbstractEventLoop | None = None
        
        # Components (initialized but not started)
        self.overlay_server = OverlayServer()
        self.copilot_bridge = CopilotBridge()
        self.stt_pipeline: STTPipeline | None = None
        self.config_watcher = ConfigWatcher(on_config_changed=self._on_config_changed)
        
        # Runtime state
        self._running = False
        self._startup_errors: list[str] = []   # filled during start()
        
    async def start(self) -> None:
        """Start all components in order:
        1. Start overlay WebSocket server
        2. Start Copilot bridge (sidecar)
        3. Start STT pipeline (hotkey listener)
        """
        if self._running:
            logger.warning("WalkieTalkAI is already running")
            return
            
        logger.info("Starting WalkieTalkAI...")
        self._loop = asyncio.get_running_loop()
        self._startup_errors = []

        try:
            # 1. Start overlay WebSocket server
            logger.info("Starting overlay server...")
            try:
                await self.overlay_server.start()
            except Exception as e:
                self._startup_errors.append(f"Overlay server: {e}")
                logger.error(f"Failed to start overlay server: {e}")
                raise  # overlay server is critical — can't continue without it

            # 2. Start Copilot bridge (sidecar)
            logger.info("Starting Copilot bridge...")
            system_prompt = self._build_system_prompt()
            try:
                await self.copilot_bridge.start(
                    model=self.config.copilot.model,
                    system_prompt=system_prompt
                )
            except Exception as e:
                self._startup_errors.append(f"Copilot/Node sidecar: {e}")
                logger.error(f"Failed to start Copilot bridge: {e}")
                await self.overlay_server.send_error(f"Copilot unavailable: {e}")
                # Continue — STT can still work without the bridge

            # 3. Start STT pipeline (hotkey listener)
            logger.info("Starting STT pipeline...")
            try:
                self.stt_pipeline = STTPipeline(
                    config=self.config,
                    on_recording_start=lambda: self._schedule(self._on_recording_start()),
                    on_partial_text=lambda text: self._schedule(self._on_partial_text(text)),
                    on_final_text=lambda text: self._schedule(self._on_final_text(text)),
                    on_recording_stop=lambda: self._schedule(self._on_recording_stop()),
                    on_cancelled=lambda phrase, full_text: self._schedule(self._on_cancelled(phrase, full_text)),
                )
                self.stt_pipeline.start()
            except Exception as e:
                self._startup_errors.append(f"Speech recognition (Vosk): {e}")
                logger.error(f"Failed to start STT pipeline: {e}")
                await self.overlay_server.send_error(f"Speech recognition unavailable: {e}")
                # Continue running even without STT

            # 4. Start config watcher
            self.config_watcher.start()

            self._running = True
            logger.info("WalkieTalkAI started successfully")

            # Send initial idle state to overlay
            await self.overlay_server.send_status("idle")
            
        except Exception as e:
            logger.error(f"Failed to start WalkieTalkAI: {e}")
            await self._cleanup()
            raise
    
    async def stop(self) -> None:
        """Stop all components in reverse order."""
        if not self._running:
            return
            
        logger.info("Stopping WalkieTalkAI...")
        await self._cleanup()
        self._running = False
        logger.info("WalkieTalkAI stopped")
        
    async def _cleanup(self) -> None:
        """Stop all components in reverse order."""
        # 4. Stop config watcher first
        logger.info("Stopping config watcher...")
        try:
            self.config_watcher.stop()
        except Exception as e:
            logger.error(f"Error stopping config watcher: {e}")
        
        # 3. Stop STT pipeline (stop accepting new inputs)
        if self.stt_pipeline:
            logger.info("Stopping STT pipeline...")
            try:
                self.stt_pipeline.stop()
            except Exception as e:
                logger.error(f"Error stopping STT pipeline: {e}")
        
        # 2. Stop Copilot bridge
        logger.info("Stopping Copilot bridge...")
        try:
            await self.copilot_bridge.stop()
        except Exception as e:
            logger.error(f"Error stopping Copilot bridge: {e}")
        
        # 1. Stop overlay server last (keep UI responsive until the end)
        logger.info("Stopping overlay server...")
        try:
            await self.overlay_server.stop()
        except Exception as e:
            logger.error(f"Error stopping overlay server: {e}")
    
    def _schedule(self, coro) -> None:
        """Schedule a coroutine from a non-async context (thread-safe)."""
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(coro, self._loop)
        else:
            logger.warning("Cannot schedule coroutine: event loop not running")
    
    async def _on_recording_start(self) -> None:
        """STT callback: user pressed hotkey.
        Send status=recording to overlay.
        """
        logger.debug("Recording started")
        try:
            await self.overlay_server.send_status("recording")
        except Exception as e:
            logger.error(f"Error sending recording status: {e}")
    
    async def _on_partial_text(self, text: str) -> None:
        """STT callback: partial transcription available.
        Send transcript to overlay.
        """
        logger.debug(f"Partial text: {text}")
        try:
            await self.overlay_server.send_transcript(text)
        except Exception as e:
            logger.error(f"Error sending partial transcript: {e}")
    
    async def _on_final_text(self, text: str) -> None:
        """STT callback: user released hotkey, final text ready.
        1. Send status=processing to overlay
        2. Send transcript (final) to overlay
        3. Build full prompt with context
        4. Send to Copilot bridge
        5. Stream tokens to overlay
        6. Send done event to overlay
        7. Send status=idle to overlay
        """
        logger.info(f"Final text received: {text}")
        
        try:
            # 1. Send status=processing to overlay
            await self.overlay_server.send_status("processing")
            
            # 2. Send final transcript to overlay
            await self.overlay_server.send_transcript(text)
            
            # 3. Build full prompt with context
            prompt = self._build_prompt(text)
            
            # 4. Check if bridge is still running, attempt restart if needed
            if not self.copilot_bridge.is_running:
                logger.error("Copilot bridge is not running, attempting restart...")
                try:
                    system_prompt = self._build_system_prompt()
                    await self.copilot_bridge.start(
                        model=self.config.copilot.model,
                        system_prompt=system_prompt
                    )
                    logger.info("Bridge restarted successfully")
                except Exception as e:
                    logger.error(f"Failed to restart Copilot bridge: {e}")
                    await self.overlay_server.send_error("Copilot is unavailable, restart failed")
                    await self.overlay_server.send_status("idle")
                    return
            
            # 5. Send to Copilot bridge and stream tokens to overlay
            response_parts = []
            try:
                async for token in self.copilot_bridge.send(prompt):
                    response_parts.append(token)
                    await self.overlay_server.send_token(token)
            except RuntimeError as e:
                if "not running" in str(e):
                    logger.error("Bridge crashed during streaming")
                    await self.overlay_server.send_error("Copilot connection lost")
                else:
                    logger.error(f"Streaming error: {e}")
                    await self.overlay_server.send_error(f"Error: {str(e)}")
                await self.overlay_server.send_status("idle")
                return
            
            # 6. Send done event with full response
            full_response = "".join(response_parts)
            await self.overlay_server.send_done(full_response)
            
            # 7. Send status=idle to overlay
            await self.overlay_server.send_status("idle")
            
        except Exception as e:
            logger.error(f"Error processing final text: {e}")
            await self.overlay_server.send_error(f"Processing error: {str(e)}")
            await self.overlay_server.send_status("idle")
    
    async def _on_recording_stop(self) -> None:
        """STT callback: recording stopped (before final text)."""
        logger.debug("Recording stopped")
        # This happens between recording ending and final text being ready
        # We could show a brief "processing transcription" state here
        try:
            await self.overlay_server.send_status("processing")
        except Exception as e:
            logger.error(f"Error sending processing status: {e}")
    
    async def _on_cancelled(self, phrase: str = "scratch that", full_text: str = "") -> None:
        """STT callback: cancel phrase detected.
        Show brief cancellation feedback on overlay then collapse.
        """
        logger.debug(f"Cancelled by user: '{phrase}' (full: '{full_text}')")
        try:
            await self.overlay_server.send_cancelled(phrase, full_text=full_text)
            await self.overlay_server.send_status("idle")
        except Exception as e:
            logger.error(f"Error sending cancel event: {e}")
    
    def _build_prompt(self, spoken_text: str) -> str:
        """Build the full prompt with context.
        If context.working_directory is set, prepend it.
        If context.custom_instructions is set, include it.
        """
        prompt_parts = []
        
        # Add working directory context
        if self.config.context.working_directory:
            prompt_parts.append(f"Working directory: {self.config.context.working_directory}")
        
        # TODO: clipboard injection not yet implemented
        # if self.config.context.include_clipboard:
        #     ...

        # Add custom instructions from file
        if self.config.context.custom_instructions:
            instructions = _read_custom_instructions(self.config.context.custom_instructions)
            if instructions:
                prompt_parts.append(f"Custom instructions: {instructions}")
        
        # Add the spoken text (this is the main user request)
        prompt_parts.append(spoken_text)
        
        return "\n\n".join(prompt_parts)
    
    def _build_system_prompt(self) -> str:
        """Build the system prompt.
        Start with config.copilot.system_prompt.
        If context.working_directory is set, add it as context.
        If context.custom_instructions file exists, append its contents.
        """
        system_parts = []
        
        # Start with base system prompt
        if self.config.copilot.system_prompt:
            system_parts.append(self.config.copilot.system_prompt)
        
        # Add working directory context to system prompt
        if self.config.context.working_directory:
            system_parts.append(
                f"The user is working in directory: {self.config.context.working_directory}"
            )
        
        # Add custom instructions from file to system prompt
        if self.config.context.custom_instructions:
            instructions = _read_custom_instructions(self.config.context.custom_instructions)
            if instructions:
                system_parts.append(f"Additional user instructions:\n{instructions}")
        
        return "\n\n".join(system_parts)
    
    async def switch_model(self, model: str) -> None:
        """Switch the Copilot model."""
        if not self.copilot_bridge.is_running:
            logger.error("Cannot switch model: Copilot bridge is not running")
            return
            
        try:
            await self.copilot_bridge.switch_model(model)
            self.config.copilot.model = model
            logger.info(f"Switched to model: {model}")
        except Exception as e:
            logger.error(f"Error switching model: {e}")
            raise
    
    @property
    def current_model(self) -> str:
        """The currently active model."""
        return self.config.copilot.model
    
    async def reset_conversation(self) -> None:
        """Reset the Copilot conversation."""
        if not self.copilot_bridge.is_running:
            logger.error("Cannot reset conversation: Copilot bridge is not running")
            return
            
        try:
            await self.copilot_bridge.reset()
            logger.info("Conversation reset")
        except Exception as e:
            logger.error(f"Error resetting conversation: {e}")
            raise
    
    def _on_config_changed(self, new_config: Config) -> None:
        """Handle config file changes at runtime."""
        logger.info("Applying new configuration...")
        old_config = self.config
        self.config = new_config
        
        # Check if model changed
        if new_config.copilot.model != old_config.copilot.model:
            if self._loop:
                asyncio.run_coroutine_threadsafe(
                    self.switch_model(new_config.copilot.model), self._loop
                )
        
        logger.info("Configuration updated")
    
    @property
    def is_running(self) -> bool:
        """Check if the application is running."""
        return self._running

    @property
    def startup_summary(self) -> str:
        """Human-readable startup status for the tray notification."""
        if not self._startup_errors:
            return "✅ WalkieTalkAI started successfully"
        lines = ["⚠️ Started with errors:"]
        for err in self._startup_errors:
            lines.append(f"  • {err}")
        return "\n".join(lines)
    
    @property 
    def client_count(self) -> int:
        """Number of connected overlay clients."""
        return self.overlay_server.client_count