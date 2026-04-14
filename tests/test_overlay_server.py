"""Tests for the WebSocket overlay server."""
import asyncio
import json
import pytest
import websockets

from walkie_talkai.overlay.server import OverlayServer
from walkie_talkai.bridge.protocol import StatusEvent, TokenEvent, DoneEvent


@pytest.mark.asyncio
async def test_server_starts_and_stops(available_port):
    """Test that server starts on port, accepts connection, stops cleanly."""
    server = OverlayServer(port=available_port)
    
    # Start server
    await server.start()
    
    # Try to connect
    uri = f"ws://127.0.0.1:{available_port}"
    async with websockets.connect(uri) as websocket:
        # Connection successful - just verify we can connect without errors
        pass
    
    # Stop server
    await server.stop()


@pytest.mark.asyncio
async def test_broadcast_to_connected_client(available_port):
    """Test connect a client, broadcast event, client receives it."""
    server = OverlayServer(port=available_port)
    await server.start()
    
    try:
        uri = f"ws://127.0.0.1:{available_port}"
        async with websockets.connect(uri) as websocket:
            # Wait a moment for connection to be registered
            await asyncio.sleep(0.1)
            
            # Broadcast a status event
            event = StatusEvent(state="recording")
            await server.broadcast(event)
            
            # Client should receive the message
            message = await asyncio.wait_for(websocket.recv(), timeout=2.0)
            data = json.loads(message)
            
            assert data["type"] == "status"
            assert data["state"] == "recording"
            
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_broadcast_to_multiple_clients(available_port):
    """Test connect 2 clients, both receive broadcast."""
    server = OverlayServer(port=available_port)
    await server.start()
    
    try:
        uri = f"ws://127.0.0.1:{available_port}"
        
        async with websockets.connect(uri) as client1, \
                   websockets.connect(uri) as client2:
            
            # Wait for connections to be registered
            await asyncio.sleep(0.1)
            
            # Broadcast a token event
            event = TokenEvent(content="hello")
            await server.broadcast(event)
            
            # Both clients should receive the message
            msg1 = await asyncio.wait_for(client1.recv(), timeout=2.0)
            msg2 = await asyncio.wait_for(client2.recv(), timeout=2.0)
            
            data1 = json.loads(msg1)
            data2 = json.loads(msg2)
            
            assert data1 == data2
            assert data1["type"] == "token"
            assert data1["content"] == "hello"
            
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_client_count(available_port):
    """Test that client_count reflects connected clients."""
    server = OverlayServer(port=available_port)
    await server.start()
    
    try:
        # Initially no clients
        assert server.client_count == 0
        
        uri = f"ws://127.0.0.1:{available_port}"
        
        # Connect first client
        async with websockets.connect(uri) as client1:
            await asyncio.sleep(0.1)  # Let connection register
            assert server.client_count == 1
            
            # Connect second client
            async with websockets.connect(uri) as client2:
                await asyncio.sleep(0.1)
                assert server.client_count == 2
            
            # Second client disconnected
            await asyncio.sleep(0.1)
            assert server.client_count == 1
        
        # Both clients disconnected
        await asyncio.sleep(0.1)
        assert server.client_count == 0
        
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_disconnected_client_removed(available_port):
    """Test disconnect a client, broadcast doesn't fail, client_count decreases."""
    server = OverlayServer(port=available_port)
    await server.start()
    
    try:
        uri = f"ws://127.0.0.1:{available_port}"
        
        # Connect and immediately disconnect
        websocket = await websockets.connect(uri)
        await asyncio.sleep(0.1)
        assert server.client_count == 1
        
        await websocket.close()
        await asyncio.sleep(0.1)
        
        # Broadcasting should not fail even with disconnected client
        event = StatusEvent(state="idle")
        await server.broadcast(event)
        
        # Client count should reflect disconnection
        assert server.client_count == 0
        
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_send_status_event(available_port):
    """Test send_status sends correct JSON."""
    server = OverlayServer(port=available_port)
    await server.start()
    
    try:
        uri = f"ws://127.0.0.1:{available_port}"
        async with websockets.connect(uri) as websocket:
            await asyncio.sleep(0.1)
            
            # Send status via convenience method
            await server.send_status("processing")
            
            # Verify received message
            message = await asyncio.wait_for(websocket.recv(), timeout=2.0)
            data = json.loads(message)
            
            assert data["type"] == "status"
            assert data["state"] == "processing"
            
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_send_token_event(available_port):
    """Test send_token sends correct JSON."""
    server = OverlayServer(port=available_port)
    await server.start()
    
    try:
        uri = f"ws://127.0.0.1:{available_port}"
        async with websockets.connect(uri) as websocket:
            await asyncio.sleep(0.1)
            
            # Send token via convenience method
            await server.send_token("test_token")
            
            # Verify received message
            message = await asyncio.wait_for(websocket.recv(), timeout=2.0)
            data = json.loads(message)
            
            assert data["type"] == "token"
            assert data["content"] == "test_token"
            
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_send_done_event(available_port):
    """Test send_done sends correct JSON."""
    server = OverlayServer(port=available_port)
    await server.start()
    
    try:
        uri = f"ws://127.0.0.1:{available_port}"
        async with websockets.connect(uri) as websocket:
            await asyncio.sleep(0.1)
            
            # Send done via convenience method
            await server.send_done("Complete final response")
            
            # Verify received message
            message = await asyncio.wait_for(websocket.recv(), timeout=2.0)
            data = json.loads(message)
            
            assert data["type"] == "done"
            assert data["full_text"] == "Complete final response"
            
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_send_error_and_hide_events(available_port):
    """Test send_error and send_hide convenience methods."""
    server = OverlayServer(port=available_port)
    await server.start()
    
    try:
        uri = f"ws://127.0.0.1:{available_port}"
        async with websockets.connect(uri) as websocket:
            await asyncio.sleep(0.1)
            
            # Send error
            await server.send_error("Test error message")
            
            message = await asyncio.wait_for(websocket.recv(), timeout=2.0)
            data = json.loads(message)
            
            assert data["type"] == "error"
            assert data["message"] == "Test error message"
            
            # Send hide
            await server.send_hide()
            
            message = await asyncio.wait_for(websocket.recv(), timeout=2.0)
            data = json.loads(message)
            
            assert data["type"] == "hide"
            
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_send_transcript_event(available_port):
    """Test send_transcript convenience method."""
    server = OverlayServer(port=available_port)
    await server.start()
    
    try:
        uri = f"ws://127.0.0.1:{available_port}"
        async with websockets.connect(uri) as websocket:
            await asyncio.sleep(0.1)
            
            # Send transcript
            await server.send_transcript("This is a test transcript")
            
            message = await asyncio.wait_for(websocket.recv(), timeout=2.0)
            data = json.loads(message)
            
            assert data["type"] == "transcript"
            assert data["text"] == "This is a test transcript"
            
    finally:
        await server.stop()


@pytest.mark.asyncio 
async def test_broadcast_with_no_clients(available_port):
    """Test that broadcast works when no clients are connected."""
    server = OverlayServer(port=available_port)
    await server.start()
    
    try:
        # No clients connected
        assert server.client_count == 0
        
        # Should not raise any exception
        event = StatusEvent(state="idle")
        await server.broadcast(event)
        
    finally:
        await server.stop()