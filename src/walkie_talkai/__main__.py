"""Entry point for walkie-talkai."""

import asyncio
import atexit
import logging
import signal
import sys
import threading
import time

from walkie_talkai.app import WalkieTalkAI
from walkie_talkai.config import load_config
from walkie_talkai.overlay.window import OverlayWindow
from walkie_talkai.tray import SystemTray


# Global state for signal handlers
_app = None
_loop = None
_async_thread = None


def _shutdown_handler(signum, frame):
    """Handle SIGINT/SIGTERM for graceful shutdown."""
    logger = logging.getLogger("walkie_talkai")
    logger.info(f"Received signal {signum}, shutting down...")
    if _app and _app.is_running:
        asyncio.run_coroutine_threadsafe(_app.stop(), _loop)
    sys.exit(0)


def _atexit_handler():
    """Clean up resources on exit."""
    logger = logging.getLogger("walkie_talkai")
    try:
        if _app and _app.is_running:
            asyncio.run_coroutine_threadsafe(_app.stop(), _loop)
        if _loop and _loop.is_running():
            _loop.call_soon_threadsafe(_loop.stop)
    except Exception as e:
        logger.error(f"Error in atexit handler: {e}")


def main():
    """Main entry point."""
    global _app, _loop, _async_thread
    
    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        handlers=[
            logging.StreamHandler(sys.stderr),
            logging.FileHandler("walkie-talkai.log", encoding="utf-8"),
        ],
    )
    logger = logging.getLogger("walkie_talkai")
    
    try:
        # Load config
        config = load_config()
        logger.info("Configuration loaded")
        
        # Create the app
        app = WalkieTalkAI(config)
        _app = app
        
        # Create the overlay window (runs in background thread)
        overlay = OverlayWindow(config.overlay)
        
        # Create event loop
        loop = asyncio.new_event_loop()
        _loop = loop
        
        # Register signal handlers
        signal.signal(signal.SIGINT, _shutdown_handler)
        signal.signal(signal.SIGTERM, _shutdown_handler)
        
        # Register atexit handler
        atexit.register(_atexit_handler)
        
        # Start async components in a thread
        async def run_app():
            await app.start()
            # Keep running until stopped
            try:
                while app.is_running:
                    await asyncio.sleep(1)
            except asyncio.CancelledError:
                pass
            finally:
                await app.stop()
        
        def run_async_loop():
            asyncio.set_event_loop(loop)
            loop.run_until_complete(run_app())
        
        # Start async loop in background thread
        async_thread = threading.Thread(target=run_async_loop, daemon=True)
        async_thread.start()
        _async_thread = async_thread
        
        # Wait briefly for app to start
        time.sleep(2)
        
        # Start overlay window (background thread) with error handling
        try:
            overlay.start()
        except Exception as e:
            logger.error(f"Failed to start overlay window: {e}")
            logger.info("Continuing without overlay window...")
        
        # Create and run system tray (blocks on main thread)
        tray = None
        if hasattr(config, 'tray') and config.tray.enabled:
            tray = SystemTray(app, loop)
            logger.info("Starting system tray")
            tray.start()  # This blocks until quit
        else:
            logger.info("System tray disabled, waiting for interrupt")
            # No tray, just wait
            try:
                async_thread.join()
            except KeyboardInterrupt:
                logger.info("Keyboard interrupt received")
        
        # Cleanup
        logger.info("Shutting down...")
        
        # Stop overlay
        try:
            overlay.stop()
        except Exception as e:
            logger.error(f"Error stopping overlay: {e}")
        
        # Stop the async loop
        if loop.is_running():
            loop.call_soon_threadsafe(loop.stop)
        
        # Wait for async thread to finish
        async_thread.join(timeout=10)
        
        logger.info("Goodbye!")
        
    except KeyboardInterrupt:
        logger.info("Interrupted, shutting down...")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()