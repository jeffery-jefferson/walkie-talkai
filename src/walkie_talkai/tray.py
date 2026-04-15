"""System tray icon and menu for walkie-talkai."""

import asyncio
import logging
import threading
import time
from typing import TYPE_CHECKING, Callable

import PIL.Image
import PIL.ImageDraw
import pystray

from walkie_talkai.config import AVAILABLE_MODELS

if TYPE_CHECKING:
    from walkie_talkai.app import WalkieTalkAI

logger = logging.getLogger(__name__)


class SystemTray:
    """System tray icon and menu for walkie-talkai."""
    
    def__init__(self, app: "WalkieTalkAI", loop: asyncio.AbstractEventLoop,
                 on_quit: "Callable[[], None] | None" = None,
                 on_restart: "Callable[[], None] | None" = None,
                 startup_message: str | None = None):
        """
        Args:
            app: The main WalkieTalkAI instance
            loop: The asyncio event loop for scheduling coroutines
            on_quit: Called when the user requests quit (should destroy the overlay)
            on_restart: Called when the user requests restart
            startup_message: If set, shown as a toast notification once the icon appears
        """
        self.app = app
        self.loop = loop
        self.icon = None
        self._on_quit = on_quit
        self._on_restart = on_restart
        self._startup_message = startup_message

    def start(self) -> None:
        """Create and start the system tray icon. This blocks (runs pystray's event loop).
        Call from a thread or as the main blocking call."""
        try:
            self.icon = self._create_icon()
            logger.info("Starting system tray icon")

            # Show startup notification after a short delay so the icon is fully
            # visible before notify() is called.  Using setup= on pystray can
            # interfere with the Win32 message loop, so we use a daemon thread.
            if self._startup_message:
                msg = self._startup_message

                def _notify_later():
                    time.sleep(1.0)  # wait for icon to appear in tray
                    try:
                        if self.icon:
                            self.icon.notify(msg, "WalkieTalkAI")
                    except Exception:
                        pass

                threading.Thread(target=_notify_later, daemon=True).start()

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
        
        # Settings
        settings_item = pystray.MenuItem(
            "Settings\u2026",
            self._open_settings
        )
        
        # Reset conversation
        reset_item = pystray.MenuItem(
            "Reset Conversation",
            self._reset_conversation
        )
        
        # Switch Model submenu
        model_items = []
        for model in AVAILABLE_MODELS:
            model_item = pystray.MenuItem(
                model,
                self._make_switch_action(model),
                checked=self._make_checked(model),
            )
            model_items.append(model_item)
        
        switch_model_item = pystray.MenuItem(
            "Switch Model",
            pystray.Menu(*model_items)
        )
        
        # Quit / Restart
        restart_item = pystray.MenuItem(
            "Restart",
            self._restart
        )

        quit_item = pystray.MenuItem(
            "Quit",
            self._quit
        )
        
        return pystray.Menu(
            enable_item,
            pystray.Menu.SEPARATOR,
            settings_item,
            reset_item,
            switch_model_item,
            pystray.Menu.SEPARATOR,
            restart_item,
            quit_item
        )
    
    def _create_tray_image(self) -> PIL.Image.Image:
        """Create the tray icon using the shared app icon."""
        from walkie_talkai.icon import create_icon_image
        return create_icon_image(64)
    
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
    
    def _open_settings(self, icon, item):
        """Open the settings window."""
        from walkie_talkai.settings import open_settings
        open_settings(self.app.config, app=self.app, loop=self.loop)

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

    def _make_switch_action(self, model: str):
        """Create a tray action callback for switching to a specific model."""
        def action(icon, item):
            self._switch_model(model)
        return action

    def _make_checked(self, model: str):
        """Create a checked callback for a specific model."""
        def checked(item):
            return getattr(self.app, 'current_model', 'claude-sonnet-4') == model
        return checked
    
    def _restart(self, icon, item):
        """Restart the application."""
        logger.info("Restart requested via tray")
        try:
            icon.notify("Restarting WalkieTalkAI...", "WalkieTalkAI")
        except Exception:
            pass
        self.stop()
        if self._on_restart:
            self._on_restart()

    def _quit(self, icon, item):
        """Quit the application."""
        logger.info("Quit requested via tray")
        self.stop()
        if self._on_quit:
            self._on_quit()