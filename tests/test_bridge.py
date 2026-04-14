"""Tests for the CopilotBridge (parts that don't need actual Node.js sidecar)."""
import asyncio
import pytest
from pathlib import Path
from unittest.mock import MagicMock

from walkie_talkai.bridge.copilot_bridge import CopilotBridge, SidecarEvent


def test_bridge_default_sidecar_path():
    """Test that default sidecar_dir resolves correctly."""
    bridge = CopilotBridge()
    
    # Default path should point to project_root/sidecar
    assert isinstance(bridge.sidecar_dir, Path)
    assert bridge.sidecar_dir.name == "sidecar"
    
    # Should be an absolute path
    assert bridge.sidecar_dir.is_absolute()


def test_bridge_custom_sidecar_path():
    """Test that custom sidecar_dir is stored."""
    custom_path = Path("/custom/sidecar/path")
    bridge = CopilotBridge(sidecar_dir=custom_path)
    
    assert bridge.sidecar_dir == custom_path
    
    # Also test with string
    bridge_str = CopilotBridge(sidecar_dir="/another/path")
    assert bridge_str.sidecar_dir == Path("/another/path")


def test_bridge_not_running_initially():
    """Test that is_running is False before start."""
    bridge = CopilotBridge()
    
    assert bridge.is_running is False
    assert bridge.process is None
    assert bridge.reader_task is None
    assert bridge._running is False


@pytest.mark.asyncio
async def test_send_without_start_raises():
    """Test that calling send() without start() raises RuntimeError."""
    bridge = CopilotBridge()
    
    with pytest.raises(RuntimeError, match="Sidecar is not running"):
        async for token in bridge.send("test prompt"):
            pass
            
    # Also test send_and_collect
    with pytest.raises(RuntimeError, match="Sidecar is not running"):
        await bridge.send_and_collect("test prompt")
        
    # Also test switch_model and reset
    with pytest.raises(RuntimeError, match="Sidecar is not running"):
        await bridge.switch_model("new-model")
        
    with pytest.raises(RuntimeError, match="Sidecar is not running"):
        await bridge.reset()


@pytest.mark.asyncio
async def test_handle_token_event():
    """Test _handle_event with token event puts content in active stream queue."""
    bridge = CopilotBridge()
    
    # Create a mock stream queue
    stream_queue = asyncio.Queue()
    bridge.active_streams["test_stream"] = stream_queue
    
    # Create a token event
    event = SidecarEvent(
        type="token",
        data={"content": "hello"}
    )
    
    # Handle the event
    await bridge._handle_event(event)
    
    # Check that content was put in the stream queue
    content = await stream_queue.get()
    assert content == "hello"


@pytest.mark.asyncio
async def test_handle_done_event():
    """Test _handle_event with done event puts None (end marker) in stream queue."""
    bridge = CopilotBridge()
    
    # Create mock stream queues
    stream_queue1 = asyncio.Queue()
    stream_queue2 = asyncio.Queue()
    bridge.active_streams["stream1"] = stream_queue1
    bridge.active_streams["stream2"] = stream_queue2
    
    # Create a done event
    event = SidecarEvent(
        type="done",
        data={"full_text": "Complete response"}
    )
    
    # Handle the event
    await bridge._handle_event(event)
    
    # Check that None (end marker) was put in all stream queues
    end_marker1 = await stream_queue1.get()
    end_marker2 = await stream_queue2.get()
    assert end_marker1 is None
    assert end_marker2 is None


@pytest.mark.asyncio
async def test_handle_multiple_token_events():
    """Test that multiple token events go to all active streams."""
    bridge = CopilotBridge()
    
    # Create multiple stream queues
    stream_queue1 = asyncio.Queue()
    stream_queue2 = asyncio.Queue()
    bridge.active_streams["stream1"] = stream_queue1
    bridge.active_streams["stream2"] = stream_queue2
    
    # Send multiple token events
    tokens = ["Hello", " ", "world", "!"]
    for token in tokens:
        event = SidecarEvent(type="token", data={"content": token})
        await bridge._handle_event(event)
    
    # Both queues should have received all tokens
    received_tokens1 = []
    received_tokens2 = []
    
    for _ in tokens:
        received_tokens1.append(await stream_queue1.get())
        received_tokens2.append(await stream_queue2.get())
    
    assert received_tokens1 == tokens
    assert received_tokens2 == tokens


@pytest.mark.asyncio
async def test_handle_error_event():
    """Test _handle_event with error event (should log but not crash)."""
    bridge = CopilotBridge()
    
    # Create an error event
    event = SidecarEvent(
        type="error",
        data={"message": "Something went wrong"}
    )
    
    # Should not raise an exception
    await bridge._handle_event(event)
    
    # Event should still be added to event queue for _wait_for_event
    queued_event = await bridge.event_queue.get()
    assert queued_event.type == "error"
    assert queued_event.data["message"] == "Something went wrong"


@pytest.mark.asyncio
async def test_event_queue_population():
    """Test that all events are added to event_queue for _wait_for_event."""
    bridge = CopilotBridge()
    
    events = [
        SidecarEvent(type="ready", data={}),
        SidecarEvent(type="token", data={"content": "test"}),
        SidecarEvent(type="done", data={"full_text": "complete"}),
        SidecarEvent(type="error", data={"message": "error"}),
    ]
    
    # Handle all events
    for event in events:
        await bridge._handle_event(event)
    
    # All events should be in the queue
    received_events = []
    while not bridge.event_queue.empty():
        received_events.append(await bridge.event_queue.get())
    
    assert len(received_events) == len(events)
    for original, received in zip(events, received_events):
        assert original.type == received.type
        assert original.data == received.data


def test_stream_counter_initialization():
    """Test that stream_counter starts at 0 and can be incremented."""
    bridge = CopilotBridge()
    
    assert bridge.stream_counter == 0
    
    # Simulate stream creation (without actually calling send)
    bridge.stream_counter += 1
    assert bridge.stream_counter == 1


def test_sidecar_event_dataclass():
    """Test SidecarEvent dataclass functionality."""
    event = SidecarEvent(type="test", data={"key": "value"})
    
    assert event.type == "test"
    assert event.data == {"key": "value"}
    
    # Test that it's a proper dataclass
    assert hasattr(event, '__dataclass_fields__')


@pytest.mark.asyncio
async def test_cleanup_process_clears_streams():
    """Test that _cleanup_process clears active streams."""
    bridge = CopilotBridge()
    
    # Add some mock streams
    stream1 = asyncio.Queue()
    stream2 = asyncio.Queue()
    bridge.active_streams["stream1"] = stream1
    bridge.active_streams["stream2"] = stream2
    
    # Add some items to the streams
    await stream1.put("token1")
    await stream2.put("token2")
    
    # Cleanup should clear streams and put None end markers
    await bridge._cleanup_process()
    
    assert len(bridge.active_streams) == 0
    
    # The queues should have received None end markers after the existing tokens
    # Get the existing token first
    existing_token1 = await stream1.get()
    existing_token2 = await stream2.get()
    assert existing_token1 == "token1"
    assert existing_token2 == "token2"
    
    # Then get the None end markers
    end_marker1 = await stream1.get()
    end_marker2 = await stream2.get()
    assert end_marker1 is None
    assert end_marker2 is None


@pytest.mark.asyncio
async def test_cleanup_process_clears_event_queue():
    """Test that _cleanup_process clears the event queue."""
    bridge = CopilotBridge()
    
    # Add some events to the queue
    await bridge.event_queue.put(SidecarEvent(type="test1", data={}))
    await bridge.event_queue.put(SidecarEvent(type="test2", data={}))
    
    assert not bridge.event_queue.empty()
    
    # Cleanup should clear the queue
    await bridge._cleanup_process()
    
    assert bridge.event_queue.empty()