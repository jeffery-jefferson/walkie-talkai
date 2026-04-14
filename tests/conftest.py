"""Shared fixtures and configuration for walkie-talkai tests."""
import asyncio
import pytest


@pytest.fixture(scope="session")
def event_loop():
    """Create an instance of the default event loop for the test session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def sample_config_dict():
    """Sample configuration dictionary for testing."""
    return {
        "copilot": {
            "model": "claude-sonnet-4",
            "system_prompt": "You are a test assistant."
        },
        "context": {
            "working_directory": None,
            "include_clipboard": False,
            "custom_instructions": None
        },
        "activation": {
            "hotkey": "ctrl+shift+space",
            "cancel_phrases": ["nevermind", "cancel"]
        },
        "stt": {
            "model_path": "models/test",
            "sample_rate": 16000
        },
        "overlay": {
            "position": "top-left",
            "opacity": 0.8,
            "auto_hide_seconds": 10,
            "max_width": 400,
            "max_height": 300
        },
        "tray": {
            "enabled": True
        }
    }


@pytest.fixture
def available_port():
    """Get an available port for testing WebSocket servers."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        s.listen(1)
        port = s.getsockname()[1]
    return port