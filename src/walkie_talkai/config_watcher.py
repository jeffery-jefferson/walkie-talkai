"""Watches config.yaml for changes and triggers reload."""

import logging
import threading
import time
from pathlib import Path
from typing import Callable

from walkie_talkai.config import load_config, Config

logger = logging.getLogger(__name__)


class ConfigWatcher:
    """Watches config.yaml for changes and calls a callback when it changes."""
    
    def __init__(self, config_path: Path | None = None, 
                 on_config_changed: Callable[[Config], None] | None = None,
                 poll_interval: float = 2.0):
        """
        Args:
            config_path: Path to watch. Defaults to config.yaml in project root.
            on_config_changed: Callback with the new Config when file changes.
            poll_interval: How often to check for changes (seconds).
        """
        if config_path is None:
            # Default: config.yaml in project root
            config_path = Path(__file__).resolve().parent.parent.parent / "config.yaml"
        
        self.config_path = Path(config_path)
        self.on_config_changed = on_config_changed
        self.poll_interval = poll_interval
        self._last_mtime: float = 0.0
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
    
    def start(self) -> None:
        """Start watching for config changes in a background thread."""
        if self.config_path.exists():
            self._last_mtime = self.config_path.stat().st_mtime
        
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._watch_loop, daemon=True)
        self._thread.start()
        logger.info(f"Config watcher started, watching: {self.config_path}")
    
    def stop(self) -> None:
        """Stop watching."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
        logger.info("Config watcher stopped")
    
    def _watch_loop(self) -> None:
        """Poll loop that checks for file modifications."""
        while not self._stop_event.is_set():
            try:
                if self.config_path.exists():
                    current_mtime = self.config_path.stat().st_mtime
                    if current_mtime > self._last_mtime:
                        self._last_mtime = current_mtime
                        logger.info("Config file changed, reloading...")
                        self._reload()
            except Exception as e:
                logger.error(f"Error checking config file: {e}")
            
            self._stop_event.wait(self.poll_interval)
    
    def _reload(self) -> None:
        """Reload config and fire callback."""
        try:
            new_config = load_config(str(self.config_path))
            logger.info("Config reloaded successfully")
            if self.on_config_changed:
                self.on_config_changed(new_config)
        except Exception as e:
            logger.error(f"Failed to reload config: {e}")
