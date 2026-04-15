"""Tests for the config module."""
import pytest
import yaml
from pathlib import Path

from walkie_talkai.config import (
    Config,
    CopilotConfig,
    ContextConfig,
    ActivationConfig,
    STTConfig,
    OverlayConfig,
    TrayConfig,
    load_config,
    save_config,
    _deep_merge,
    _validate,
)


def test_default_config_loads():
    """Test that load_config() returns a valid Config with defaults."""
    cfg = load_config()
    
    assert isinstance(cfg, Config)
    assert isinstance(cfg.copilot, CopilotConfig)
    assert isinstance(cfg.context, ContextConfig)
    assert isinstance(cfg.activation, ActivationConfig)
    assert isinstance(cfg.stt, STTConfig)
    assert isinstance(cfg.overlay, OverlayConfig)
    assert isinstance(cfg.tray, TrayConfig)
    
    # Verify some key defaults
    assert cfg.copilot.model == "gpt-4.1"


def test_deep_merge_basic():
    """Test merging two flat dicts."""
    base = {"a": 1, "b": 2}
    override = {"b": 3, "c": 4}
    result = _deep_merge(base, override)
    
    assert result == {"a": 1, "b": 3, "c": 4}


def test_deep_merge_nested():
    """Test merging nested dicts preserves deep keys."""
    base = {
        "outer": {
            "inner1": "value1",
            "inner2": "value2"
        },
        "other": "unchanged"
    }
    override = {
        "outer": {
            "inner2": "new_value2",
            "inner3": "value3"
        }
    }
    result = _deep_merge(base, override)
    
    expected = {
        "outer": {
            "inner1": "value1",  # preserved
            "inner2": "new_value2",  # overridden
            "inner3": "value3"  # added
        },
        "other": "unchanged"  # preserved
    }
    assert result == expected


def test_deep_merge_override():
    """Test that override replaces non-dict values."""
    base = {"key": ["list", "value"]}
    override = {"key": "string_value"}
    result = _deep_merge(base, override)
    
    assert result == {"key": "string_value"}
    
    # Test the reverse too
    base = {"key": "string_value"}
    override = {"key": ["new", "list"]}
    result = _deep_merge(base, override)
    
    assert result == {"key": ["new", "list"]}


def test_config_defaults():
    """Test that Config() has correct default values for all fields."""
    cfg = Config()
    
    # CopilotConfig defaults
    assert cfg.copilot.model == "gpt-4.1"
    
    # ContextConfig defaults
    assert cfg.context.working_directory is None
    assert cfg.context.include_clipboard is False
    assert cfg.context.custom_instructions is None
    
    # ActivationConfig defaults
    assert cfg.activation.hotkey == "ctrl+shift+space"
    assert "scrap that" in cfg.activation.cancel_phrases
    assert "nevermind" in cfg.activation.cancel_phrases
    
    # STTConfig defaults
    assert cfg.stt.model_path == "models/vosk/vosk-model-small-en-us"
    assert cfg.stt.sample_rate == 16000
    
    # OverlayConfig defaults
    assert cfg.overlay.position == "top-left"
    assert cfg.overlay.opacity == 0.92
    assert cfg.overlay.auto_hide_seconds == 15
    assert cfg.overlay.max_width == 340
    assert cfg.overlay.max_height == 180
    
    # TrayConfig defaults
    assert cfg.tray.enabled is True


def test_validation_valid_config():
    """Test that valid config passes validation."""
    cfg = Config()
    # Should not raise any exception
    _validate(cfg)


def test_validation_invalid_opacity():
    """Test that opacity > 1.0 raises ValueError."""
    cfg = Config()
    cfg.overlay.opacity = 1.5
    
    with pytest.raises(ValueError, match="opacity must be between 0.0 and 1.0"):
        _validate(cfg)
        
    cfg.overlay.opacity = -0.1
    with pytest.raises(ValueError, match="opacity must be between 0.0 and 1.0"):
        _validate(cfg)


def test_validation_invalid_position():
    """Test that invalid position raises ValueError."""
    cfg = Config()
    cfg.overlay.position = "invalid-position"
    
    with pytest.raises(ValueError, match="overlay.position must be one of"):
        _validate(cfg)


def test_validation_empty_model():
    """Test that empty model string raises ValueError."""
    cfg = Config()
    cfg.copilot.model = ""
    
    with pytest.raises(ValueError, match="copilot.model must be a non-empty string"):
        _validate(cfg)
        
    cfg.copilot.model = None
    with pytest.raises(ValueError, match="copilot.model must be a non-empty string"):
        _validate(cfg)


def test_validation_negative_sample_rate():
    """Test that negative sample_rate raises ValueError."""
    cfg = Config()
    cfg.stt.sample_rate = -1000
    
    with pytest.raises(ValueError, match="stt.sample_rate must be a positive integer"):
        _validate(cfg)
        
    cfg.stt.sample_rate = 0
    with pytest.raises(ValueError, match="stt.sample_rate must be a positive integer"):
        _validate(cfg)


def test_save_and_load_roundtrip(tmp_path):
    """Test that save then load produces equivalent config."""
    # Create a config with some custom values
    cfg = Config()
    cfg.copilot.model = "test-model"
    cfg.overlay.opacity = 0.5
    cfg.stt.sample_rate = 22050
    cfg.activation.cancel_phrases = ["stop", "cancel"]
    
    # Save to temporary file
    config_path = tmp_path / "test_config.yaml"
    save_config(cfg, str(config_path))
    
    # Load it back
    loaded_cfg = load_config(str(config_path))
    
    # Verify key values match
    assert loaded_cfg.copilot.model == "test-model"
    assert loaded_cfg.overlay.opacity == 0.5
    assert loaded_cfg.stt.sample_rate == 22050
    assert loaded_cfg.activation.cancel_phrases == ["stop", "cancel"]


def test_load_with_override_file(tmp_path):
    """Test loading with explicit path overrides defaults."""
    # Create an override config file
    override_config = {
        "copilot": {
            "model": "override-model"
        },
        "overlay": {
            "opacity": 0.3,
            "position": "bottom-right"
        }
    }
    
    override_path = tmp_path / "override.yaml"
    with open(override_path, "w") as f:
        yaml.safe_dump(override_config, f)
    
    # Load with override
    cfg = load_config(str(override_path))
    
    # Override values should be applied
    assert cfg.copilot.model == "override-model"
    assert cfg.overlay.opacity == 0.3
    assert cfg.overlay.position == "bottom-right"
    
    # Non-overridden values should remain as defaults
    assert cfg.stt.sample_rate == 16000  # default
    assert cfg.tray.enabled is True  # default


def test_validation_custom_instructions_file_not_found():
    """Test that validation fails when custom_instructions file doesn't exist."""
    cfg = Config()
    cfg.context.custom_instructions = "/nonexistent/path/file.txt"
    
    with pytest.raises(ValueError, match="custom_instructions file not found"):
        _validate(cfg)


def test_validation_overlay_dimensions():
    """Test validation of overlay max_width and max_height."""
    cfg = Config()
    
    cfg.overlay.max_width = 0
    with pytest.raises(ValueError, match="overlay.max_width must be a positive integer"):
        _validate(cfg)
        
    cfg.overlay.max_width = 500  # reset to valid
    cfg.overlay.max_height = -10
    with pytest.raises(ValueError, match="overlay.max_height must be a positive integer"):
        _validate(cfg)
        
    cfg.overlay.max_height = 400  # reset to valid
    cfg.overlay.auto_hide_seconds = 0
    with pytest.raises(ValueError, match="overlay.auto_hide_seconds must be a positive integer"):
        _validate(cfg)