"""Entry point for walkie-talkai."""

import asyncio
import atexit
import logging
import signal
import subprocess
import sys
import threading
from pathlib import Path

from walkie_talkai.app import WalkieTalkAI
from walkie_talkai.config import Config, load_config
from walkie_talkai.overlay.window import OverlayWindow
from walkie_talkai.tray import SystemTray


class ApplicationRunner:
    """Manages the full application lifecycle: async loop, overlay, tray, shutdown."""

    def __init__(self, config: Config):
        self._config = config
        self._app: WalkieTalkAI | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._async_thread: threading.Thread | None = None
        self._shutdown_event: asyncio.Event | None = None
        self._restart_flag = threading.Event()
        self._logger = logging.getLogger("walkie_talkai")

    def run(self) -> None:
        """Run the application. Blocks until the overlay window closes."""
        # Create the app
        app = WalkieTalkAI(self._config)
        self._app = app

        # Create the overlay window (will run on main thread)
        overlay = OverlayWindow(self._config.overlay)

        # Create event loop
        loop = asyncio.new_event_loop()
        self._loop = loop

        # Register signal handlers
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)

        # Register atexit handler
        atexit.register(self._atexit_handler)

        # Start async components in a thread
        self._shutdown_event = asyncio.Event()
        startup_done = threading.Event()

        async def run_app():
            await app.start()
            startup_done.set()
            try:
                await self._shutdown_event.wait()
            except asyncio.CancelledError:
                pass
            finally:
                await app.stop()

        def run_async_loop():
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(run_app())
            except RuntimeError:
                pass  # Loop was stopped externally during shutdown
            finally:
                startup_done.set()  # unblock main thread even if run_app raised

        # Start async loop in background thread
        async_thread = threading.Thread(target=run_async_loop, daemon=True)
        async_thread.start()
        self._async_thread = async_thread

        # Wait for app.start() to fully complete (or fail) before reading status.
        # Timeout of 20s covers port-retry wait (up to 12s) + sidecar init (~2s).
        startup_done.wait(timeout=20)

        startup_msg = app.startup_summary
        self._logger.info(f"Startup status: {startup_msg}")

        # Start system tray in a background thread (doesn't need main thread)
        tray = None
        if hasattr(self._config, 'tray') and self._config.tray.enabled:
            def _quit_app():
                """Destroy the overlay window — main thread cleanup handles the rest."""
                overlay.stop()

            def _restart_app():
                """Signal that a restart is wanted; run() spawns after cleanup."""
                self._restart_flag.set()
                overlay.stop()

            tray = SystemTray(app, loop, on_quit=_quit_app, on_restart=_restart_app,
                              startup_message=startup_msg)
            tray_thread = threading.Thread(target=tray.start, daemon=True)
            tray_thread.start()
            self._logger.info("System tray started in background thread")

        # Start overlay window on main thread (pywebview requires this)
        try:
            overlay.start()  # Blocks until window is closed
        except Exception as e:
            self._logger.error(f"Failed to start overlay window: {e}")
            self._logger.info("Continuing without overlay window...")
            # No overlay, just wait for interrupt
            try:
                async_thread.join()
            except KeyboardInterrupt:
                self._logger.info("Keyboard interrupt received")

        # Cleanup
        self._logger.info("Shutting down...")

        # Stop tray
        if tray:
            try:
                tray.stop()
            except Exception as e:
                self._logger.error(f"Error stopping tray: {e}")

        # Signal the async app to stop gracefully
        self._request_shutdown()

        # Wait for async thread to finish (app.stop() runs inside run_app)
        async_thread.join(timeout=15)

        # Force-stop the loop if the thread is still alive
        if async_thread.is_alive() and loop.is_running():
            loop.call_soon_threadsafe(loop.stop)
            async_thread.join(timeout=5)

        # Spawn fresh instance AFTER all resources (port 8765, sidecar) are released
        if self._restart_flag.is_set():
            self._spawn_restart()

        self._logger.info("Goodbye!")

    def _start_async_loop(self) -> None:
        """Target for the async background thread."""
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._run_app())
        except RuntimeError:
            pass

    def _request_shutdown(self) -> None:
        """Thread-safe shutdown signal."""
        if self._loop and self._shutdown_event:
            self._loop.call_soon_threadsafe(self._shutdown_event.set)

    def _signal_handler(self, signum, frame) -> None:
        """Handle SIGINT/SIGTERM for graceful shutdown."""
        self._logger.info(f"Received signal {signum}, shutting down...")
        self._request_shutdown()
        sys.exit(0)

    def _atexit_handler(self) -> None:
        """Clean up resources on exit."""
        try:
            self._request_shutdown()
        except Exception as e:
            self._logger.error(f"Error in atexit handler: {e}")

    @staticmethod
    def _resolve_restart_cmd() -> list[str]:
        """Return the command to re-launch this application.

        Search order:
        1. <argv[0]>.exe  — works when launched via the installed entry-point .exe
           (sys.argv[0] is the script path in Scripts/, .exe is right beside it)
        2. <pythonw_dir>/Scripts/walkie-talkai-tray.exe  — standard venv layout
        3. <pythonw_dir>/walkie-talkai-tray.exe  — flat install layout
        4. [sys.executable] + sys.argv  — dev / editable install fallback
        """
        candidates = [
            Path(sys.argv[0]).with_suffix(".exe"),
            Path(sys.executable).parent / "Scripts" / "walkie-talkai-tray.exe",
            Path(sys.executable).parent / "walkie-talkai-tray.exe",
        ]
        for candidate in candidates:
            if candidate.exists():
                return [str(candidate)]
        return [sys.executable] + sys.argv

    def _spawn_restart(self) -> None:
        """Spawn a new instance after cleanup."""
        cmd = self._resolve_restart_cmd()
        self._logger.info(f"Restarting: {' '.join(cmd)}")
        kwargs: dict = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        subprocess.Popen(cmd, **kwargs)


def main():
    """Main entry point."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        handlers=[
            logging.StreamHandler(sys.stderr),
            logging.FileHandler("walkie-talkai.log", encoding="utf-8"),
        ],
    )

    try:
        config = load_config()
        logging.getLogger("walkie_talkai").info("Configuration loaded")
        ApplicationRunner(config).run()
    except KeyboardInterrupt:
        logging.getLogger("walkie_talkai").info("Interrupted, shutting down...")
    except Exception as e:
        logging.getLogger("walkie_talkai").error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()