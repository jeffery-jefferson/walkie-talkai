"""Settings window for walkie-talkai — tkinter-based, launched from the system tray."""

from __future__ import annotations

import asyncio
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from walkie_talkai.config import Config

# Singleton guard
_settings_open = False
_settings_lock = threading.Lock()


def open_settings(cfg: Config, app: Any = None, loop: Any = None) -> None:
    """Spawn the settings window in a background thread (one instance at a time).

    Saves changes to config.yaml; the existing ConfigWatcher picks them up.
    If app and loop are provided, model changes are applied instantly.
    """
    global _settings_open
    with _settings_lock:
        if _settings_open:
            return
        _settings_open = True

    t = threading.Thread(target=_run, args=(cfg, app, loop), daemon=True, name="settings-ui")
    t.start()


# ---------------------------------------------------------------------------
# Theme constants
# ---------------------------------------------------------------------------
_BG = "#ffffff"
_FG = "#111827"
_MUTED = "#6b7280"
_ACCENT = "#1e5b8a"
_ENTRY_BG = "#f3f4f6"
_BTN_CANCEL = "#6b7280"
_FONT = ("Segoe UI", 10)
_FONT_BOLD = ("Segoe UI", 10, "bold")
_FONT_HEAD = ("Segoe UI", 11, "bold")

# Available models for the dropdown
_MODELS = [
    "claude-sonnet-4", "claude-sonnet-4.5", "claude-sonnet-4.6",
    "claude-haiku-4.5", "claude-opus-4.5", "claude-opus-4.6",
    "gpt-5-mini", "gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.4-mini",
    "gpt-4.1",
]

_POSITIONS = [
    "top-left", "top-center", "top-right",
    "bottom-left", "bottom-center", "bottom-right",
]


def _build_copilot_tab(nb, root, cfg):
    """Build the Copilot settings tab. Returns (model_var, prompt_text_widget)."""
    v_model = tk.StringVar(root, value=cfg.copilot.model)
    t_copilot = _scrollable_tab(nb, "Copilot")
    _heading(t_copilot, "Model")
    _row(t_copilot, "Model", lambda f: _combo(f, v_model, _MODELS))
    _heading(t_copilot, "System Prompt")
    _hint(t_copilot, "The system prompt sent with every request.")
    prompt_text = _multiline(t_copilot, cfg.copilot.system_prompt, height=6)
    return v_model, prompt_text


def _build_context_tab(nb, root, cfg):
    """Build the Context settings tab. Returns (working_dir_var, clipboard_var, custom_instr_var)."""
    v_working_dir = tk.StringVar(root, value=cfg.context.working_directory or "")
    v_clipboard = tk.BooleanVar(root, value=cfg.context.include_clipboard)
    v_custom_instr = tk.StringVar(root, value=cfg.context.custom_instructions or "")
    t_context = _scrollable_tab(nb, "Context")
    _heading(t_context, "Working Directory")
    _hint(t_context, "Prepended as context to every prompt. Leave blank to skip.")
    _row_with_browse(t_context, "Directory", v_working_dir, root, mode="directory")
    _heading(t_context, "Custom Instructions")
    _hint(t_context, "Path to a text file with additional instructions.")
    _row_with_browse(t_context, "File path", v_custom_instr, root, mode="file")
    _heading(t_context, "Clipboard")
    _row(t_context, "Include clipboard", lambda f: _check(f, v_clipboard))
    return v_working_dir, v_clipboard, v_custom_instr


def _build_activation_tab(nb, root, cfg):
    """Build the Activation settings tab. Returns (hotkey_var, cancel_editor)."""
    v_hotkey = tk.StringVar(root, value=cfg.activation.hotkey)
    t_activation = _scrollable_tab(nb, "Activation")
    _heading(t_activation, "Push-to-Talk")
    _row(t_activation, "Hotkey", lambda f: _entry(f, v_hotkey))
    _hint(t_activation, "Requires restart to take effect.")
    _heading(t_activation, "Cancel Phrases")
    _hint(t_activation, "Speaking any of these wipes the transcript and cancels.")
    cancel_editor = _PhraseListEditor(t_activation, root, list(cfg.activation.cancel_phrases))
    return v_hotkey, cancel_editor


def _build_speech_tab(nb, root, cfg):
    """Build the Speech settings tab. Returns (model_path_var, sample_rate_var)."""
    v_model_path = tk.StringVar(root, value=cfg.stt.model_path)
    v_sample_rate = tk.StringVar(root, value=str(cfg.stt.sample_rate))
    t_speech = _scrollable_tab(nb, "Speech")
    _heading(t_speech, "Speech Recognition (STT)")
    _hint(t_speech, "Changes require restart.")
    _row_with_browse(t_speech, "Model path", v_model_path, root, mode="directory")
    _row(t_speech, "Sample rate (Hz)", lambda f: _spinbox(f, v_sample_rate, 8000, 48000, 100))
    return v_model_path, v_sample_rate


def _build_overlay_tab(nb, root, cfg):
    """Build the Overlay settings tab. Returns (position_var, opacity_var, auto_hide_var, max_width_var, max_height_var)."""
    v_position = tk.StringVar(root, value=cfg.overlay.position)
    v_opacity = tk.DoubleVar(root, value=cfg.overlay.opacity)
    v_auto_hide = tk.StringVar(root, value=str(cfg.overlay.auto_hide_seconds))
    v_max_width = tk.StringVar(root, value=str(cfg.overlay.max_width))
    v_max_height = tk.StringVar(root, value=str(cfg.overlay.max_height))
    t_overlay = _scrollable_tab(nb, "Overlay")
    _heading(t_overlay, "Overlay Window")
    _hint(t_overlay, "Changes require restart.")
    _row(t_overlay, "Position", lambda f: _combo(f, v_position, _POSITIONS))
    _row(t_overlay, "Opacity", lambda f: _slider(f, v_opacity, 0.1, 1.0))
    _row(t_overlay, "Auto-hide (sec)", lambda f: _spinbox(f, v_auto_hide, 1, 120, 1))
    _row(t_overlay, "Max width (px)", lambda f: _spinbox(f, v_max_width, 200, 2000, 50))
    _row(t_overlay, "Max height (px)", lambda f: _spinbox(f, v_max_height, 200, 2000, 50))
    return v_position, v_opacity, v_auto_hide, v_max_width, v_max_height


def _run(cfg: Config, app: Any, loop: Any) -> None:
    global _settings_open

    from walkie_talkai.config import (
        ActivationConfig,
        Config,
        ContextConfig,
        CopilotConfig,
        OverlayConfig,
        STTConfig,
        TrayConfig,
        _validate,
        save_config,
    )

    try:
        root = tk.Tk()
        root.title("Walkie-TalkAI Settings")
        root.configure(bg=_BG)
        root.resizable(True, True)
        root.wm_attributes("-topmost", True)
        root.minsize(620, 520)

        _apply_style(root)

        # Button bar (packed first so notebook gets expand=True)
        btn_bar = tk.Frame(root, bg=_BG)
        btn_bar.pack(fill="x", padx=10, pady=8, side="bottom")

        nb = ttk.Notebook(root)
        nb.pack(fill="both", expand=True, padx=10, pady=(10, 0))

        # Build tabs
        v_model, prompt_text = _build_copilot_tab(nb, root, cfg)
        v_working_dir, v_clipboard, v_custom_instr = _build_context_tab(nb, root, cfg)
        v_hotkey, cancel_editor = _build_activation_tab(nb, root, cfg)
        v_model_path, v_sample_rate = _build_speech_tab(nb, root, cfg)
        v_position, v_opacity, v_auto_hide, v_max_width, v_max_height = _build_overlay_tab(nb, root, cfg)

        # ── OK / Apply / Cancel ──────────────────────────────────────

        def _get_config_path() -> Path:
            """Get the config.yaml path (same location as config.default.yaml)."""
            from walkie_talkai.config import _get_default_config_path
            return _get_default_config_path().parent / "config.yaml"

        def _build_config() -> Config | None:
            try:
                new_cfg = Config(
                    copilot=CopilotConfig(
                        model=v_model.get(),
                        system_prompt=prompt_text.get("1.0", "end-1c"),
                    ),
                    context=ContextConfig(
                        working_directory=v_working_dir.get() or None,
                        include_clipboard=v_clipboard.get(),
                        custom_instructions=v_custom_instr.get() or None,
                    ),
                    activation=ActivationConfig(
                        hotkey=v_hotkey.get(),
                        cancel_phrases=cancel_editor.get_phrases(),
                    ),
                    stt=STTConfig(
                        model_path=v_model_path.get(),
                        sample_rate=int(v_sample_rate.get()),
                    ),
                    overlay=OverlayConfig(
                        position=v_position.get(),
                        opacity=round(v_opacity.get(), 2),
                        auto_hide_seconds=int(v_auto_hide.get()),
                        max_width=int(v_max_width.get()),
                        max_height=int(v_max_height.get()),
                    ),
                    tray=TrayConfig(enabled=cfg.tray.enabled),
                )
                _validate(new_cfg)
                return new_cfg
            except (ValueError, TypeError) as exc:
                messagebox.showerror("Invalid configuration", str(exc), parent=root)
                return None

        def _apply_instant_changes(new_cfg: Config) -> None:
            """Apply changes that can take effect immediately (e.g. model switch)."""
            if app and loop and loop.is_running():
                if new_cfg.copilot.model != cfg.copilot.model:
                    asyncio.run_coroutine_threadsafe(
                        app.switch_model(new_cfg.copilot.model), loop
                    )

        def _apply() -> None:
            new_cfg = _build_config()
            if new_cfg is not None:
                save_config(new_cfg, str(_get_config_path()))
                _apply_instant_changes(new_cfg)
                messagebox.showinfo(
                    "Applied",
                    "Settings saved. Some changes require a restart.",
                    parent=root,
                )

        def _ok() -> None:
            new_cfg = _build_config()
            if new_cfg is not None:
                save_config(new_cfg, str(_get_config_path()))
                _apply_instant_changes(new_cfg)
                root.destroy()

        _button(btn_bar, "Cancel", root.destroy, _BTN_CANCEL).pack(side="right", padx=(4, 0))
        _button(btn_bar, "Apply", _apply, _BTN_CANCEL).pack(side="right", padx=(4, 0))
        _button(btn_bar, "OK", _ok, _ACCENT).pack(side="right")

        # Center on screen
        root.update_idletasks()
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        w, h = 820, 680
        root.geometry(f"{w}x{h}+{(sw - w) // 2}+{(sh - h) // 2}")

        root.mainloop()

    finally:
        with _settings_lock:
            _settings_open = False


# ---------------------------------------------------------------------------
# Widget helpers
# ---------------------------------------------------------------------------

def _scrollable_tab(nb, label: str):
    outer = ttk.Frame(nb)
    nb.add(outer, text=f"  {label}  ")
    canvas = tk.Canvas(outer, bg=_BG, highlightthickness=0)
    vsb = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
    canvas.configure(yscrollcommand=vsb.set)
    vsb.pack(side="right", fill="y")
    canvas.pack(side="left", fill="both", expand=True)
    inner = ttk.Frame(canvas)
    win_id = canvas.create_window((0, 0), window=inner, anchor="nw")

    def _on_configure(event):
        canvas.configure(scrollregion=canvas.bbox("all"))
        canvas.itemconfigure(win_id, width=canvas.winfo_width())

    inner.bind("<Configure>", _on_configure)
    canvas.bind("<Configure>", lambda e: canvas.itemconfigure(win_id, width=e.width))

    def _on_mousewheel(event):
        canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

    canvas.bind("<Enter>", lambda e: canvas.bind_all("<MouseWheel>", _on_mousewheel))
    canvas.bind("<Leave>", lambda e: canvas.unbind_all("<MouseWheel>"))

    return inner


def _heading(parent, text: str) -> None:
    tk.Label(parent, text=text, bg=_BG, fg=_ACCENT, font=_FONT_HEAD).pack(
        anchor="w", padx=16, pady=(12, 2)
    )


def _hint(parent, text: str) -> None:
    lbl = tk.Label(parent, text=text, bg=_BG, fg=_MUTED, font=("Segoe UI", 9),
                   anchor="w", justify="left")
    lbl.pack(anchor="w", padx=16, pady=(0, 4), fill="x")

    def _wrap(e):
        lbl.configure(wraplength=e.width - 32)
    lbl.bind("<Configure>", _wrap)


def _row(parent, label: str, widget_factory) -> None:
    frame = tk.Frame(parent, bg=_BG)
    frame.pack(fill="x", padx=16, pady=3)
    ttk.Label(frame, text=label, width=22, anchor="w").pack(side="left")
    w = widget_factory(frame)
    w.pack(side="left", fill="x", expand=True)


def _row_with_browse(parent, label: str, var, root, mode: str = "file") -> None:
    """Row with a text entry and Browse… button."""
    frame = tk.Frame(parent, bg=_BG)
    frame.pack(fill="x", padx=16, pady=3)
    ttk.Label(frame, text=label, width=22, anchor="w").pack(side="left")
    ttk.Entry(frame, textvariable=var).pack(side="left", fill="x", expand=True)

    def _browse():
        if mode == "directory":
            path = filedialog.askdirectory(parent=root, title=f"Select {label}")
        else:
            path = filedialog.askopenfilename(parent=root, title=f"Select {label}")
        if path:
            var.set(path)

    _button(frame, "Browse…", _browse, _ACCENT).pack(side="left", padx=(4, 0))


def _entry(parent, var):
    return ttk.Entry(parent, textvariable=var)


def _combo(parent, var, values: list[str]):
    return ttk.Combobox(parent, textvariable=var, values=values, state="readonly", width=20)


def _check(parent, var):
    return tk.Checkbutton(
        parent, variable=var, bg=_BG, activebackground=_BG,
        fg=_FG, selectcolor=_ACCENT, relief="flat", bd=0,
        font=_FONT, cursor="hand2",
    )


def _spinbox(parent, var, from_: float, to: float, increment: float):
    return ttk.Spinbox(parent, textvariable=var, from_=from_, to=to,
                       increment=increment, width=10)


def _slider(parent, var, from_: float, to: float):
    frame = tk.Frame(parent, bg=_BG)
    scale = ttk.Scale(frame, variable=var, from_=from_, to=to, orient="horizontal")
    scale.pack(side="left", fill="x", expand=True)
    lbl = tk.Label(frame, width=5, bg=_BG, fg=_FG, font=_FONT, anchor="e")
    lbl.pack(side="left")

    def _update(*_):
        lbl.config(text=f"{var.get():.2f}")

    var.trace_add("write", _update)
    _update()
    return frame


def _multiline(parent, initial_text: str, height: int = 6):
    """Create a multiline Text widget inside parent and return it."""
    frame = tk.Frame(parent, bg=_BG)
    frame.pack(fill="x", padx=16, pady=(2, 8))
    text = tk.Text(
        frame, height=height, bg=_ENTRY_BG, fg=_FG, font=_FONT,
        relief="flat", bd=2, wrap="word", insertbackground=_FG,
    )
    text.insert("1.0", initial_text)
    text.pack(fill="x", expand=True)
    return text


def _button(parent, text: str, cmd, bg_color: str):
    return tk.Button(
        parent, text=text, command=cmd,
        bg=bg_color, fg="#ffffff", activebackground=bg_color,
        relief="flat", padx=18, pady=6, font=_FONT_BOLD, cursor="hand2", bd=0,
    )


class _PhraseListEditor:
    """A listbox + add/remove controls for editing a list of phrases."""

    def __init__(self, parent, root, phrases: list[str]) -> None:
        self._frame = tk.Frame(parent, bg=_BG)
        self._frame.pack(fill="x", padx=16, pady=(2, 8))

        list_frame = tk.Frame(self._frame, bg=_BG)
        list_frame.pack(fill="x")

        self._lb = tk.Listbox(
            list_frame, height=6, bg=_ENTRY_BG, fg=_FG, font=_FONT,
            selectbackground=_ACCENT, selectforeground="#ffffff",
            relief="flat", bd=0, activestyle="none",
        )
        sb = ttk.Scrollbar(list_frame, orient="vertical", command=self._lb.yview)
        self._lb.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self._lb.pack(side="left", fill="x", expand=True)

        for phrase in phrases:
            self._lb.insert("end", phrase)

        add_frame = tk.Frame(self._frame, bg=_BG)
        add_frame.pack(fill="x", pady=(4, 0))
        self._new_var = tk.StringVar(root)
        ttk.Entry(add_frame, textvariable=self._new_var).pack(
            side="left", fill="x", expand=True
        )

        def _add():
            phrase = self._new_var.get().strip().lower()
            if phrase and phrase not in self._lb.get(0, "end"):
                self._lb.insert("end", phrase)
                self._new_var.set("")

        def _remove():
            for idx in reversed(self._lb.curselection()):
                self._lb.delete(idx)

        tk.Button(
            add_frame, text="Add", command=_add,
            bg=_ACCENT, fg="#ffffff", activebackground=_ACCENT,
            relief="flat", padx=10, pady=4, font=_FONT_BOLD, cursor="hand2", bd=0,
        ).pack(side="left", padx=(4, 0))
        tk.Button(
            add_frame, text="Remove", command=_remove,
            bg=_BTN_CANCEL, fg="#ffffff", activebackground=_BTN_CANCEL,
            relief="flat", padx=10, pady=4, font=_FONT_BOLD, cursor="hand2", bd=0,
        ).pack(side="left", padx=(4, 0))

    def get_phrases(self) -> list[str]:
        return list(self._lb.get(0, "end"))


def _apply_style(root) -> None:
    s = ttk.Style(root)
    s.theme_use("clam")
    s.configure("TNotebook", background=_BG, borderwidth=0)
    s.configure("TNotebook.Tab", background=_ENTRY_BG, foreground=_FG,
                padding=[10, 5], font=_FONT)
    s.map("TNotebook.Tab",
          background=[("selected", _ACCENT)],
          foreground=[("selected", "#ffffff")])
    s.configure("TFrame", background=_BG)
    s.configure("TLabel", background=_BG, foreground=_FG, font=_FONT)
    s.configure("TEntry", fieldbackground=_ENTRY_BG, foreground=_FG,
                insertcolor=_FG, font=_FONT)
    s.configure("TCombobox", fieldbackground=_ENTRY_BG, foreground=_FG, font=_FONT)
    s.map("TCombobox",
          fieldbackground=[("readonly", _ENTRY_BG)],
          foreground=[("readonly", _FG)])
    s.configure("TCheckbutton", background=_BG, foreground=_FG, font=_FONT)
    s.configure("TScale", background=_BG, troughcolor=_ENTRY_BG)
    s.configure("TSpinbox", fieldbackground=_ENTRY_BG, foreground=_FG,
                insertcolor=_FG, font=_FONT)
