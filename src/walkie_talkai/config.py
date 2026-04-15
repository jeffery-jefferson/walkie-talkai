"""Configuration management for walkie-talkai."""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any, get_type_hints

import yaml


@dataclass
class CopilotConfig:
    """Copilot/Claude configuration."""

    model: str = "gpt-4.1"
    system_prompt: str = "You are a helpful voice assistant. Be concise and direct.\nRespond in plain text unless code is specifically requested.\n"


@dataclass
class ContextConfig:
    """Context configuration for conversations."""

    working_directory: str | None = None
    include_clipboard: bool = False
    custom_instructions: str | None = None


@dataclass
class ActivationConfig:
    """Hotkey and activation configuration."""

    hotkey: str = "ctrl+shift+space"
    cancel_phrases: list[str] = field(
        default_factory=lambda: ["scrap that", "nevermind", "never mind", "scratch that"]
    )


@dataclass
class STTConfig:
    """Speech-to-text configuration."""

    model_path: str = "models/vosk/vosk-model-small-en-us"
    sample_rate: int = 16000


@dataclass
class OverlayConfig:
    """Overlay display configuration."""

    position: str = "top-left"
    opacity: float = 0.92
    auto_hide_seconds: int = 15
    max_width: int = 340
    max_height: int = 180


@dataclass
class TrayConfig:
    """System tray configuration."""

    enabled: bool = True


@dataclass
class Config:
    """Root configuration object."""

    copilot: CopilotConfig = field(default_factory=CopilotConfig)
    context: ContextConfig = field(default_factory=ContextConfig)
    activation: ActivationConfig = field(default_factory=ActivationConfig)
    stt: STTConfig = field(default_factory=STTConfig)
    overlay: OverlayConfig = field(default_factory=OverlayConfig)
    tray: TrayConfig = field(default_factory=TrayConfig)


AVAILABLE_MODELS: list[str] = [
    "claude-sonnet-4", "claude-sonnet-4.5", "claude-sonnet-4.6",
    "claude-haiku-4.5", "claude-opus-4.5", "claude-opus-4.6",
    "gpt-5-mini", "gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.4-mini",
    "gpt-4.1",
]


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """
    Deep merge override dict into base dict.
    
    Lists and non-dict values are replaced, not merged.
    """
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _dict_to_dataclass(data: dict[str, Any], dataclass_type: type) -> Any:
    """Recursively convert a dict to a dataclass instance."""
    if not isinstance(data, dict):
        return data

    resolved_hints = get_type_hints(dataclass_type)
    field_values = {}
    for f in fields(dataclass_type):
        if f.name in data:
            value = data[f.name]
            field_type = resolved_hints.get(f.name, f.type)

            if is_dataclass(field_type) and isinstance(value, dict):
                field_values[f.name] = _dict_to_dataclass(value, field_type)
            else:
                field_values[f.name] = value

    return dataclass_type(**field_values)


def _validate(cfg: Config) -> None:
    """Validate configuration values."""
    # copilot.model must be non-empty
    if not cfg.copilot.model or not isinstance(cfg.copilot.model, str):
        raise ValueError("copilot.model must be a non-empty string")

    # stt.sample_rate must be positive
    if cfg.stt.sample_rate <= 0:
        raise ValueError("stt.sample_rate must be a positive integer")

    # overlay.opacity must be between 0.0 and 1.0
    if not (0.0 <= cfg.overlay.opacity <= 1.0):
        raise ValueError("overlay.opacity must be between 0.0 and 1.0")

    # overlay.position must be valid
    valid_positions = {"top-left", "top-right", "bottom-left", "bottom-right", "top-center", "bottom-center"}
    if cfg.overlay.position not in valid_positions:
        raise ValueError(f"overlay.position must be one of: {', '.join(sorted(valid_positions))}")

    # overlay.auto_hide_seconds must be positive
    if cfg.overlay.auto_hide_seconds <= 0:
        raise ValueError("overlay.auto_hide_seconds must be a positive integer")

    # overlay.max_width and max_height must be positive
    if cfg.overlay.max_width <= 0:
        raise ValueError("overlay.max_width must be a positive integer")
    if cfg.overlay.max_height <= 0:
        raise ValueError("overlay.max_height must be a positive integer")

    # context.custom_instructions file must exist if provided
    if cfg.context.custom_instructions:
        if not Path(cfg.context.custom_instructions).exists():
            raise ValueError(f"custom_instructions file not found: {cfg.context.custom_instructions}")


def _get_default_config_path() -> Path:
    """Get path to config.default.yaml using fallback logic."""
    # Try importlib.resources first (Python 3.9+)
    try:
        from importlib.resources import files
        try:
            config_file = files("walkie_talkai") / ".." / ".." / ".." / "config.default.yaml"
            # This may not work reliably, fall back to __file__
        except (TypeError, AttributeError):
            pass
    except ImportError:
        pass

    # Fallback: navigate from __file__
    current_file = Path(__file__)
    package_dir = current_file.parent
    src_dir = package_dir.parent
    project_root = src_dir.parent

    default_path = project_root / "config.default.yaml"
    if default_path.exists():
        return default_path

    raise FileNotFoundError(f"config.default.yaml not found at {default_path}")


def load_config(path: str | None = None) -> Config:
    """
    Load configuration with resolution order:
    1. config.default.yaml (project root)
    2. config.yaml (project root)
    3. explicit path if provided
    
    Later files override earlier ones via deep merge.
    """
    config_data = {}

    # Load config.default.yaml
    default_path = _get_default_config_path()
    if default_path.exists():
        with open(default_path, "r") as f:
            default_data = yaml.safe_load(f) or {}
            config_data = _deep_merge(config_data, default_data)

    # Load config.yaml (project root)
    project_root = default_path.parent
    user_config_path = project_root / "config.yaml"
    if user_config_path.exists():
        with open(user_config_path, "r") as f:
            user_data = yaml.safe_load(f) or {}
            config_data = _deep_merge(config_data, user_data)

    # Load explicit path if provided
    if path:
        explicit_path = Path(path)
        if explicit_path.exists():
            with open(explicit_path, "r") as f:
                explicit_data = yaml.safe_load(f) or {}
                config_data = _deep_merge(config_data, explicit_data)
        else:
            raise FileNotFoundError(f"Config file not found: {path}")

    # Convert to dataclass
    cfg = _dict_to_dataclass(config_data, Config)

    # Validate
    _validate(cfg)

    return cfg


def save_config(cfg: Config, path: str) -> None:
    """Save configuration to YAML file."""
    # Convert dataclass to dict
    def dataclass_to_dict(obj: Any) -> Any:
        if is_dataclass(obj):
            return {f.name: dataclass_to_dict(getattr(obj, f.name)) for f in fields(obj)}
        elif isinstance(obj, list):
            return [dataclass_to_dict(item) for item in obj]
        else:
            return obj

    config_dict = dataclass_to_dict(cfg)

    # Ensure parent directory exists
    config_path = Path(path)
    config_path.parent.mkdir(parents=True, exist_ok=True)

    # Write to file
    with open(config_path, "w") as f:
        yaml.safe_dump(config_dict, f, default_flow_style=False, sort_keys=False)
