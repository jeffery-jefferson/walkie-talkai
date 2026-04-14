"""System tray icon and menu for walkie-talkai."""

import asyncio
import logging
from typing import TYPE_CHECKING

import PIL.Image
import PIL.ImageDraw
import pystray

if TYPE_CHECKING:
    from walkie_talkai.app import WalkieTalkAI

logger = logging.getLogger(__name__)


class SystemTray:
    """System tray icon and menu for walkie-talkai."""
    
    AVAILABLE_MODELS = [
        "claude-sonnet-4", "claude-sonnet-4.5", "claude-sonnet-4.6",
        "claude-haiku-4.5", "claude-opus-4.5", "claude-opus-4.6",
        "gpt-5-mini", "gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.4-mini",
        "gpt-4.1",
    ]
    
    def __init__(self, app: "WalkieTalkAI", loop: asyncio.AbstractEventLoop):
        """
        Args:
            app: The main WalkieTalkAI instance
            loop: The asyncio event loop for scheduling coroutines
        """
        self.app = app
        self.loop = loop
        self.icon = None
        
    def start(self) -> None:
        """Create and start the system tray icon. This blocks (runs pystray's event loop).
        Call from a thread or as the main blocking call."""
        try:
            self.icon = self._create_icon()
            logger.info("Starting system tray icon")
            self.icon.run()  # This blocks
        except Exception as e:
            logger.error(f"Error running system tray: {e}", exc_info=True)
    
    def stop(self) -> None:
        """Stop the system tray icon."""
        if self.icon:
            logger.info("Stopping system tray icon")
            self.icon.stop()
    
    def _create_icon(self) -> pystray.Icon:
        """Create the system tray icon."""
        image = self._create_tray_image()
        menu = self._create_menu()
        
        icon = pystray.Icon(
            name="walkie-talkai",
            icon=image,
            title="Walkie-TalkAI",
            menu=menu
        )
        
        return icon
    
    def _create_menu(self) -> pystray.Menu:
        """Create the context menu for the tray icon."""
        # Enable/Disable toggle
        enable_item = pystray.MenuItem(
            "Enabled",
            self._toggle_enabled,
            checked=lambda item: self.app.is_running
        )
        
        # Reset conversation
        reset_item = pystray.MenuItem(
            "Reset Conversation",
            self._reset_conversation
        )
        
        # Switch Model submenu
        model_items = []
        for model in self.AVAILABLE_MODELS:
            model_item = pystray.MenuItem(
                model,
                lambda icon, item, model=model: self._switch_model(model),
                checked=lambda item, model=model: getattr(self.app, 'current_model', 'claude-sonnet-4') == model
            )
            model_items.append(model_item)
        
        switch_model_item = pystray.MenuItem(
            "Switch Model",
            pystray.Menu(*model_items)
        )
        
        # Quit
        quit_item = pystray.MenuItem(
            "Quit",
            self._quit
        )
        
        return pystray.Menu(
            enable_item,
            pystray.Menu.SEPARATOR,
            reset_item,
            switch_model_item,
            pystray.Menu.SEPARATOR,
            quit_item
        )
    
    def _create_tray_image(self) -> PIL.Image.Image:
        """Create a simple programmatic icon for the tray."""
        # Create a 64x64 image
        size = 64
        image = PIL.Image.new('RGBA', (size, size), (0, 0, 0, 0))
        draw = PIL.ImageDraw.Draw(image)
        
        # Color based on enabled state
        if self.app.is_running:
            # Green when enabled
            color = (34, 197, 94, 255)  # Green
        else:
            # Gray when disabled
            color = (107, 114, 128, 255)  # Gray
        
        # Draw a simple microphone shape
        # Main body (rounded rectangle)
        margin = 8
        body_width = size - 2 * margin
        body_height = int(body_width * 0.7)
        body_x = margin
        body_y = margin
        
        draw.rounded_rectangle(
            [body_x, body_y, body_x + body_width, body_y + body_height],
            radius=body_width // 4,
            fill=color
        )
        
        # Stand (rectangle at bottom)
        stand_width = body_width // 3
        stand_height = size - body_y - body_height - margin
        stand_x = (size - stand_width) // 2
        stand_y = body_y + body_height
        
        draw.rectangle(
            [stand_x, stand_y, stand_x + stand_width, stand_y + stand_height],
            fill=color
        )
        
        # Small circle in the center (microphone grille)
        center_x, center_y = size // 2, body_y + body_height // 2
        circle_radius = body_width // 6
        draw.ellipse(
            [center_x - circle_radius, center_y - circle_radius,
             center_x + circle_radius, center_y + circle_radius],
            fill=(255, 255, 255, 200)  # Semi-transparent white
        )
        
        return image
    
    def _toggle_enabled(self, icon, item):
        """Toggle the enabled/disabled state of the app."""
        try:
            if self.app.is_running:
                # Disable (stop the app)
                future = asyncio.run_coroutine_threadsafe(
                    self.app.stop(), self.loop
                )
                future.result(timeout=5.0)
                logger.info("App disabled via tray")
            else:
                # Enable (start the app)
                future = asyncio.run_coroutine_threadsafe(
                    self.app.start(), self.loop
                )
                future.result(timeout=5.0)
                logger.info("App enabled via tray")
            
            # Update the icon to reflect the new state
            self.icon.icon = self._create_tray_image()
            
        except Exception as e:
            logger.error(f"Error toggling app state: {e}", exc_info=True)
    
    def _reset_conversation(self, icon, item):
        """Reset the conversation history."""
        try:
            future = asyncio.run_coroutine_threadsafe(
                self.app.reset_conversation(), self.loop
            )
            future.result(timeout=5.0)
            logger.info("Conversation reset via tray")
        except Exception as e:
            logger.error(f"Error resetting conversation: {e}", exc_info=True)
    
    def _switch_model(self, model: str):
        """Switch to a different model."""
        try:
            future = asyncio.run_coroutine_threadsafe(
                self.app.switch_model(model), self.loop
            )
            future.result(timeout=10.0)
            logger.info(f"Switched to model {model} via tray")
        except Exception as e:
            logger.error(f"Error switching to model {model}: {e}", exc_info=True)
    
    def _quit(self, icon, item):
        """Quit the application."""
        logger.info("Quit requested via tray")
        try:
            # Stop the app first
            if self.app.is_running:
                future = asyncio.run_coroutine_threadsafe(
                    self.app.stop(), self.loop
                )
                future.result(timeout=5.0)
            
            # Then stop the tray icon
            self.stop()
            
        except Exception as e:
            logger.error(f"Error during quit: {e}", exc_info=True)
            # Force stop the icon anyway
            self.stop()