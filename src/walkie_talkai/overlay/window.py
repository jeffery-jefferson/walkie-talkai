"""Overlay window manager using pywebview."""

from __future__ import annotations

import ctypes
import logging
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

from walkie_talkai.config import OverlayConfig

logger = logging.getLogger(__name__)

# ── Overlay geometry constants ──────────────────────────────
TAB_WIDTH = 100      # collapsed tab width (px)
TAB_HEIGHT = 24      # collapsed tab height (px)
ANIM_STEPS = 14      # number of animation frames
ANIM_DURATION = 0.18 # total animation time (seconds)


def _ease_in_out(t: float) -> float:
    """Cubic ease-in-out for t in [0, 1]."""
    return t * t * (3.0 - 2.0 * t)


class OverlayAPI:
    """JS-callable API exposed to the overlay frontend via pywebview."""

    def __init__(self, expanded_w: int, expanded_h: int, max_h: int = 1080):
        self._window: Any = None
        self._expanded = (expanded_w, expanded_h)
        self._collapsed = (TAB_WIDTH, TAB_HEIGHT)
        self._anim_lock = threading.Lock()
        self._anim_thread: threading.Thread | None = None
        self._current_w = TAB_WIDTH
        self._current_h = TAB_HEIGHT
        self._max_h = max_h - 32  # leave margin from screen edge

    def set_window(self, window: Any) -> None:
        self._window = window

    def collapse(self) -> None:
        self._animate(self._current_w, self._current_h, *self._collapsed)

    def expand(self) -> None:
        self._animate(self._current_w, self._current_h, *self._expanded)

    def set_height(self, h: int) -> None:
        """Resize window to a specific height (JS calls this when transcript grows)."""
        h = max(self._expanded[1], min(int(h), self._max_h))
        self._animate(self._current_w, self._current_h, self._current_w, h)

    def _animate(self, from_w: int, from_h: int, to_w: int, to_h: int) -> None:
        """Run an eased resize animation in a background thread."""
        with self._anim_lock:
            if self._anim_thread and self._anim_thread.is_alive():
                self._anim_thread = None  # signal old thread to stop

            thread = threading.Thread(
                target=self._run_anim,
                args=(from_w, from_h, to_w, to_h),
                daemon=True,
            )
            self._anim_thread = thread

        thread.start()

    def _run_anim(self, from_w: int, from_h: int, to_w: int, to_h: int) -> None:
        if not self._window:
            return

        me = threading.current_thread()
        step_delay = ANIM_DURATION / ANIM_STEPS

        for i in range(1, ANIM_STEPS + 1):
            with self._anim_lock:
                if self._anim_thread is not me:
                    return

            t = _ease_in_out(i / ANIM_STEPS)
            w = round(from_w + (to_w - from_w) * t)
            h = round(from_h + (to_h - from_h) * t)

            try:
                self._window.resize(w, h)
            except Exception:
                return

            self._current_w = w
            self._current_h = h
            time.sleep(step_delay)


def _set_aumid() -> None:
    """Set App User Model ID so Windows groups this as its own app (not Python)."""
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("WalkieTalkAI.Overlay")
    except Exception:
        pass


def _configure_window(ico_path: Path) -> None:
    """Hide overlay from taskbar and apply icon. Called from pywebview start func thread."""
    if sys.platform != "win32":
        return

    time.sleep(0.6)  # wait for window to fully initialise

    try:
        from ctypes import wintypes

        pid = os.getpid()
        found: list[int] = []

        def _enum_cb(hwnd: int, _lparam: int) -> bool:
            proc_id = wintypes.DWORD()
            ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(proc_id))
            if proc_id.value == pid and ctypes.windll.user32.IsWindowVisible(hwnd):
                found.append(hwnd)
            return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        ctypes.windll.user32.EnumWindows(WNDENUMPROC(_enum_cb), 0)

        GWL_EXSTYLE      = -20
        WS_EX_TOOLWINDOW = 0x00000080  # hides from taskbar + Alt+Tab
        WS_EX_APPWINDOW  = 0x00040000  # forces into taskbar — we remove this
        SWP_NOMOVE       = 0x0002
        SWP_NOSIZE       = 0x0001
        SWP_NOZORDER     = 0x0004
        SWP_FRAMECHANGED = 0x0020

        LR_LOADFROMFILE = 0x0010
        IMAGE_ICON      = 1
        WM_SETICON      = 0x0080
        ICON_SMALL      = 0
        ICON_BIG        = 1

        hicon_big   = ctypes.windll.user32.LoadImageW(None, str(ico_path), IMAGE_ICON, 256, 256, LR_LOADFROMFILE)
        hicon_small = ctypes.windll.user32.LoadImageW(None, str(ico_path), IMAGE_ICON, 16, 16, LR_LOADFROMFILE)

        for hwnd in found:
            # Remove from taskbar
            ex_style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            ex_style = (ex_style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW
            ctypes.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style)
            ctypes.windll.user32.SetWindowPos(
                hwnd, None, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
            )
            # Apply icon (shows in Alt+Tab)
            if hicon_big:
                ctypes.windll.user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, hicon_big)
            if hicon_small:
                ctypes.windll.user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, hicon_small)

        logger.debug("Overlay window configured: hidden from taskbar (%d hwnd(s))", len(found))

    except Exception as e:
        logger.warning("Failed to configure overlay window: %s", e)


def _get_screen_dimensions() -> tuple[int, int]:
    """Get screen dimensions using ctypes on Windows."""
    try:
        user32 = ctypes.windll.user32
        width = user32.GetSystemMetrics(0)   # SM_CXSCREEN
        height = user32.GetSystemMetrics(1)  # SM_CYSCREEN
        if width > 0 and height > 0:
            return (width, height)
    except (AttributeError, OSError):
        pass
    return (1920, 1080)


def _calculate_position(
    position: str,
    max_width: int,
    max_height: int,
    screen_width: int,
    screen_height: int,
) -> tuple[int, int]:
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
            return (margin, margin)


class OverlayWindow:
    """Manages a frameless, always-on-top pywebview window for the overlay."""

    def __init__(self, config: OverlayConfig) -> None:
        self.config = config
        self._window: Any = None
        self._should_run = False
        self._html_path = Path(__file__).parent / "web" / "index.html"

        if not self._html_path.exists():
            logger.error(f"Overlay HTML file not found at {self._html_path}")

    def start(self) -> None:
        """Start the overlay window on the main thread. Blocks until the window closes."""
        try:
            import webview
        except ImportError:
            logger.warning("pywebview not installed. Overlay window unavailable.")
            return

        try:
            if not self._html_path.exists():
                logger.error(f"Overlay HTML file not found at {self._html_path}")
                return

            _set_aumid()

            from walkie_talkai.icon import get_ico_path
            ico_path = get_ico_path()

            screen_width, screen_height = _get_screen_dimensions()
            x, y = _calculate_position(
                self.config.position,
                self.config.max_width,
                self.config.max_height,
                screen_width,
                screen_height,
            )

            api = OverlayAPI(self.config.max_width, self.config.max_height, screen_height)

            self._window = webview.create_window(
                title="WalkieTalkAI",
                url=str(self._html_path),
                width=TAB_WIDTH,
                height=TAB_HEIGHT,
                x=x,
                y=y,
                frameless=True,
                on_top=True,
                resizable=False,
                background_color='#14141e',
                js_api=api,
            )
            api.set_window(self._window)

            logger.info("Starting overlay window on main thread")
            webview.start(func=lambda: _configure_window(ico_path))

        except Exception as e:
            logger.error(f"Error running overlay window: {e}", exc_info=True)
        finally:
            self._window = None
            self._should_run = False

    def stop(self) -> None:
        """Close the overlay window."""
        if self._window is None:
            logger.debug("Overlay window not running")
            return
        try:
            self._should_run = False
            self._window.destroy()
            self._window = None
            logger.info("Overlay window stopped")
        except Exception as e:
            logger.error(f"Error stopping overlay window: {e}", exc_info=True)

    def show(self) -> None:
        if self._window:
            try:
                self._window.show()
            except Exception as e:
                logger.error(f"Error showing overlay window: {e}", exc_info=True)

    def hide(self) -> None:
        if self._window:
            try:
                self._window.hide()
            except Exception as e:
                logger.error(f"Error hiding overlay window: {e}", exc_info=True)
