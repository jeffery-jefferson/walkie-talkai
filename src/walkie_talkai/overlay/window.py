"""Overlay window manager using pywebview."""

from __future__ import annotations

import ctypes
import logging
import threading
from pathlib import Path
from typing import Any

from walkie_talkai.config import OverlayConfig

logger = logging.getLogger(__name__)


def _get_screen_dimensions() -> tuple[int, int]:
    """Get screen dimensions using ctypes on Windows.
    
    Returns:
        Tuple of (width, height) in pixels. Defaults to (1920, 1080) if detection fails.
    """
    try:
        # Windows: Use ctypes to get screen dimensions
        user32 = ctypes.windll.user32
        width = user32.GetSystemMetrics(0)  # SM_CXSCREEN
        height = user32.GetSystemMetrics(1)  # SM_CYSCREEN
        if width > 0 and height > 0:
            return (width, height)
    except (AttributeError, OSError):
        pass
    
    # Fallback to default
    return (1920, 1080)


def _calculate_position(
    position: str,
    max_width: int,
    max_height: int,
    screen_width: int,
    screen_height: int,
) -> tuple[int, int]:
    """Calculate window position based on config position string.
    
    Args:
        position: Position identifier (top-left, top-right, bottom-left, etc.)
        max_width: Window width
        max_height: Window height
        screen_width: Screen width in pixels
        screen_height: Screen height in pixels
    
    Returns:
        Tuple of (x, y) coordinates.
    """
    margin = 16
    
    match position:
        case "top-left":
            return (margin, margin)
        case "top-right":
            return (screen_width - max_width - margin, margin)
        case "bottom-left":
            return (margin, screen_height - max_height - margin)
        case "bottom-right":
            return (screen_width - max_width - margin, screen_height - max_height - margin)
        case "top-center":
            return ((screen_width - max_width) // 2, margin)
        case "bottom-center":
            return ((screen_width - max_width) // 2, screen_height - max_height - margin)
        case _:
            # Fallback to top-left
            return (margin, margin)


class OverlayWindow:
    """Manages a frameless, always-on-top, transparent pywebview window for the overlay."""
    
    def __init__(self, config: OverlayConfig) -> None:
        """Initialize the overlay window manager.
        
        Args:
            config: Overlay configuration (position, opacity, max_width, max_height)
        """
        self.config = config
        self._window: Any = None
        self._thread: threading.Thread | None = None
        self._should_run = False
        self._html_path = Path(__file__).parent / "web" / "index.html"
        
        if not self._html_path.exists():
            logger.error(f"Overlay HTML file not found at {self._html_path}")
    
    def start(self) -> None:
        """Start the overlay window in a background thread.
        
        Creates a pywebview window that is:
        - Frameless (no title bar, no borders)
        - Always on top
        - Has a transparent background
        - Loads the overlay HTML file
        - Is positioned according to config
        - Has configured max width/height
        """
        if self._thread is not None and self._thread.is_alive():
            logger.warning("Overlay window already running")
            return
        
        self._should_run = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        logger.info("Overlay window started in background thread")
    
    def _run(self) -> None:
        """Internal method that runs in the background thread."""
        try:
            import webview
        except ImportError:
            logger.warning(
                "pywebview not installed. Overlay window will not be available. "
                "Install with: pip install pywebview"
            )
            return
        
        try:
            if not self._html_path.exists():
                logger.error(f"Overlay HTML file not found at {self._html_path}")
                return
            
            # Get screen dimensions for positioning
            screen_width, screen_height = _get_screen_dimensions()
            
            # Calculate window position
            x, y = _calculate_position(
                self.config.position,
                self.config.max_width,
                self.config.max_height,
                screen_width,
                screen_height,
            )
            
            # Create the pywebview window
            self._window = webview.create_window(
                title="WalkieTalkAI",
                url=str(self._html_path),
                width=self.config.max_width,
                height=self.config.max_height,
                x=x,
                y=y,
                frameless=True,
                on_top=True,
                transparent=True,
                resizable=False,
            )
            
            # Start the webview event loop (blocks until window is closed)
            webview.start()
            
        except Exception as e:
            logger.error(f"Error running overlay window: {e}", exc_info=True)
        finally:
            self._window = None
            self._should_run = False
    
    def stop(self) -> None:
        """Close the overlay window and stop the thread."""
        if self._window is None:
            logger.debug("Overlay window not running")
            return
        
        try:
            self._should_run = False
            if self._window:
                self._window.destroy()
                self._window = None
            logger.info("Overlay window stopped")
        except Exception as e:
            logger.error(f"Error stopping overlay window: {e}", exc_info=True)
    
    def show(self) -> None:
        """Show the overlay window."""
        if self._window is None:
            logger.debug("Overlay window not initialized")
            return
        
        try:
            self._window.show()
            logger.debug("Overlay window shown")
        except Exception as e:
            logger.error(f"Error showing overlay window: {e}", exc_info=True)
    
    def hide(self) -> None:
        """Hide the overlay window."""
        if self._window is None:
            logger.debug("Overlay window not initialized")
            return
        
        try:
            self._window.hide()
            logger.debug("Overlay window hidden")
        except Exception as e:
            logger.error(f"Error hiding overlay window: {e}", exc_info=True)
