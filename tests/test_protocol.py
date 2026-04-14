"""Tests for the bridge protocol module."""
import json
from walkie_talkai.bridge.protocol import (
    StatusEvent,
    TranscriptEvent,
    TokenEvent,
    DoneEvent,
    ErrorEvent,
    HideEvent,
    to_json,
    from_json,
)


def test_status_event_serialization():
    """Test StatusEvent round-trips through to_json/from_json."""
    event = StatusEvent(state="recording")
    
    # Serialize to JSON
    json_str = to_json(event)
    data = json.loads(json_str)
    
    # Verify structure
    assert data["state"] == "recording"
    assert data["type"] == "status"
    
    # Round-trip test
    parsed_data = from_json(json_str)
    assert parsed_data == {"state": "recording", "type": "status"}


def test_transcript_event_serialization():
    """Test TranscriptEvent serialization."""
    event = TranscriptEvent(text="Hello world")
    
    json_str = to_json(event)
    data = json.loads(json_str)
    
    assert data["text"] == "Hello world"
    assert data["type"] == "transcript"
    
    parsed_data = from_json(json_str)
    assert parsed_data == {"text": "Hello world", "type": "transcript"}


def test_token_event_serialization():
    """Test TokenEvent serialization."""
    event = TokenEvent(content="token_content")
    
    json_str = to_json(event)
    data = json.loads(json_str)
    
    assert data["content"] == "token_content"
    assert data["type"] == "token"
    
    parsed_data = from_json(json_str)
    assert parsed_data == {"content": "token_content", "type": "token"}


def test_done_event_serialization():
    """Test DoneEvent serialization (note: field is full_text)."""
    event = DoneEvent(full_text="Complete response text")
    
    json_str = to_json(event)
    data = json.loads(json_str)
    
    assert data["full_text"] == "Complete response text"
    assert data["type"] == "done"
    
    parsed_data = from_json(json_str)
    assert parsed_data == {"full_text": "Complete response text", "type": "done"}


def test_error_event_serialization():
    """Test ErrorEvent serialization."""
    event = ErrorEvent(message="Something went wrong")
    
    json_str = to_json(event)
    data = json.loads(json_str)
    
    assert data["message"] == "Something went wrong"
    assert data["type"] == "error"
    
    parsed_data = from_json(json_str)
    assert parsed_data == {"message": "Something went wrong", "type": "error"}


def test_hide_event_serialization():
    """Test HideEvent serialization."""
    event = HideEvent()
    
    json_str = to_json(event)
    data = json.loads(json_str)
    
    assert data["type"] == "hide"
    assert len(data) == 1  # Only type field
    
    parsed_data = from_json(json_str)
    assert parsed_data == {"type": "hide"}


def test_event_type_field():
    """Test that each event has correct type field value."""
    # Test all event types have correct default type values
    assert StatusEvent(state="idle").type == "status"
    assert TranscriptEvent(text="test").type == "transcript"
    assert TokenEvent(content="test").type == "token"
    assert DoneEvent(full_text="test").type == "done"
    assert ErrorEvent(message="test").type == "error"
    assert HideEvent().type == "hide"


def test_from_json_returns_dict():
    """Test that from_json returns a plain dict."""
    test_json = '{"key": "value", "number": 42, "bool": true}'
    result = from_json(test_json)
    
    assert isinstance(result, dict)
    assert result == {"key": "value", "number": 42, "bool": True}


def test_complex_serialization_with_special_characters():
    """Test serialization handles special characters correctly."""
    event = TranscriptEvent(text='Text with "quotes" and \n newlines \t tabs')
    
    json_str = to_json(event)
    parsed_data = from_json(json_str)
    
    assert parsed_data["text"] == 'Text with "quotes" and \n newlines \t tabs'
    assert parsed_data["type"] == "transcript"


def test_status_event_with_different_states():
    """Test StatusEvent with all valid state values."""
    states = ["recording", "processing", "idle"]
    
    for state in states:
        event = StatusEvent(state=state)
        json_str = to_json(event)
        parsed_data = from_json(json_str)
        
        assert parsed_data["state"] == state
        assert parsed_data["type"] == "status"


def test_empty_string_values():
    """Test events with empty string values serialize correctly."""
    events = [
        TranscriptEvent(text=""),
        TokenEvent(content=""),
        DoneEvent(full_text=""),
        ErrorEvent(message=""),
    ]
    
    for event in events:
        json_str = to_json(event)
        parsed_data = from_json(json_str)
        
        # Verify empty strings are preserved
        for key, value in parsed_data.items():
            if key != "type":  # Skip the type field
                assert value == ""
        assert "type" in parsed_data