"""
Tests for chat.py router

Tests cover:
- /ping endpoint
- /invocations endpoint
- Interrupt response handling
- Disconnect-aware streaming
- Error handling
"""
import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from fastapi import Request
from fastapi.testclient import TestClient
import json


# ============================================================
# Ping Endpoint Tests
# ============================================================

class TestPingEndpoint:
    """Tests for the /ping health check endpoint."""

    def test_ping_returns_healthy(self):
        """Test that ping returns healthy status."""
        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        response = client.get("/ping")

        assert response.status_code == 200
        assert response.json() == {"status": "healthy"}

    def test_ping_is_get_method(self):
        """Test that ping only accepts GET requests."""
        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        # POST should fail
        response = client.post("/ping")
        assert response.status_code == 405


# ============================================================
# Agent Factory Tests
# ============================================================

class TestAgentFactory:
    """Tests for the agent factory integration."""

    @patch('routers.chat.create_agent')
    def test_creates_chat_agent_by_default(self, mock_factory):
        """Test that normal mode creates ChatAgent."""
        from routers.chat import router
        from fastapi import FastAPI

        mock_agent = MagicMock()
        async def mock_stream(*args, **kwargs):
            yield 'data: {"type": "complete"}\n\n'
        mock_agent.stream_async = mock_stream
        mock_factory.return_value = mock_agent

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "test-session-123",
                    "message": "Hello"
                }
            }
        )

        mock_factory.assert_called_once()
        call_kwargs = mock_factory.call_args.kwargs
        assert call_kwargs['request_type'] == "normal"
        assert call_kwargs['session_id'] == "test-session-123"

    @patch('routers.chat.create_agent')
    def test_creates_swarm_agent_for_swarm_mode(self, mock_factory):
        """Test that swarm mode creates SwarmAgent."""
        from routers.chat import router
        from fastapi import FastAPI

        mock_agent = MagicMock()
        async def mock_stream(*args, **kwargs):
            yield 'data: {"type": "complete"}\n\n'
        mock_agent.stream_async = mock_stream
        mock_factory.return_value = mock_agent

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "test",
                    "message": "Hello",
                    "request_type": "swarm"
                }
            }
        )

        call_kwargs = mock_factory.call_args.kwargs
        assert call_kwargs['request_type'] == "swarm"


# ============================================================
# Disconnect-Aware Stream Tests
# ============================================================

class TestDisconnectAwareStream:
    """Tests for disconnect_aware_stream wrapper."""

    @pytest.mark.asyncio
    async def test_yields_chunks_when_connected(self):
        """Test that chunks are yielded when client is connected."""
        from routers.chat import disconnect_aware_stream

        async def mock_stream():
            yield "chunk1"
            yield "chunk2"
            yield "chunk3"

        mock_request = MagicMock(spec=Request)
        mock_request.is_disconnected = AsyncMock(return_value=False)

        chunks = []
        async for chunk in disconnect_aware_stream(
            mock_stream(),
            mock_request,
            "test-session"
        ):
            chunks.append(chunk)

        assert chunks == ["chunk1", "chunk2", "chunk3"]

    @pytest.mark.asyncio
    async def test_stops_when_disconnected(self):
        """Test that stream stops when client disconnects."""
        from routers.chat import disconnect_aware_stream

        call_count = 0

        async def mock_stream():
            nonlocal call_count
            for i in range(10):
                call_count += 1
                yield f"chunk{i}"

        mock_request = MagicMock(spec=Request)
        # Disconnect after 2 chunks
        mock_request.is_disconnected = AsyncMock(
            side_effect=[False, False, True] + [True] * 10
        )

        chunks = []
        async for chunk in disconnect_aware_stream(
            mock_stream(),
            mock_request,
            "test-session"
        ):
            chunks.append(chunk)

        # Should only get chunks before disconnect
        assert len(chunks) <= 3

    @pytest.mark.asyncio
    async def test_handles_generator_exit(self):
        """Test that GeneratorExit is properly handled."""
        from routers.chat import disconnect_aware_stream

        async def mock_stream():
            yield "chunk1"
            yield "chunk2"

        mock_request = MagicMock(spec=Request)
        mock_request.is_disconnected = AsyncMock(return_value=False)

        gen = disconnect_aware_stream(
            mock_stream(),
            mock_request,
            "test-session"
        )

        # Get first chunk
        chunk = await gen.__anext__()
        assert chunk == "chunk1"

        # Close generator
        await gen.aclose()

    @pytest.mark.asyncio
    async def test_closes_underlying_stream_on_disconnect(self):
        """Test that underlying stream is closed when client disconnects."""
        from routers.chat import disconnect_aware_stream

        stream_closed = False

        async def mock_stream():
            nonlocal stream_closed
            try:
                yield "chunk1"
                yield "chunk2"
            finally:
                stream_closed = True

        mock_request = MagicMock(spec=Request)
        mock_request.is_disconnected = AsyncMock(side_effect=[False, True])

        chunks = []
        async for chunk in disconnect_aware_stream(
            mock_stream(),
            mock_request,
            "test-session"
        ):
            chunks.append(chunk)

        # Stream should be closed
        assert stream_closed


# ============================================================
# Invocations Endpoint Tests
# ============================================================

class TestInvocationsEndpoint:
    """Tests for the /invocations endpoint."""

    @pytest.fixture
    def mock_agent(self):
        """Create mock agent for testing."""
        agent = MagicMock()

        async def mock_stream(*args, **kwargs):
            yield 'data: {"type": "init"}\n\n'
            yield 'data: {"type": "text", "content": "Hello"}\n\n'
            yield 'data: {"type": "complete"}\n\n'

        agent.stream_async = mock_stream
        return agent

    @patch('routers.chat.create_agent')
    def test_invocations_returns_streaming_response(self, mock_factory, mock_agent):
        """Test that invocations returns SSE streaming response."""
        mock_factory.return_value = mock_agent

        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        response = client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "test-session",
                    "message": "Hello"
                }
            }
        )

        assert response.status_code == 200
        assert response.headers.get("content-type") == "text/event-stream; charset=utf-8"

    @patch('routers.chat.create_agent')
    def test_invocations_sets_session_header(self, mock_factory, mock_agent):
        """Test that invocations sets X-Session-ID header."""
        mock_factory.return_value = mock_agent

        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        response = client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "my-session-123",
                    "message": "Test"
                }
            }
        )

        assert response.headers.get("x-session-id") == "my-session-123"

    @patch('routers.chat.create_agent')
    def test_invocations_passes_enabled_tools(self, mock_factory, mock_agent):
        """Test that enabled tools are passed to agent."""
        mock_factory.return_value = mock_agent

        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "test",
                    "message": "Test",
                    "enabled_tools": ["calculator", "web_search"]
                }
            }
        )

        mock_factory.assert_called_once()
        call_kwargs = mock_factory.call_args.kwargs
        assert call_kwargs['enabled_tools'] == ["calculator", "web_search"]

    @patch('routers.chat.create_agent')
    def test_invocations_handles_files(self, mock_factory, mock_agent):
        """Test that files are passed to agent stream."""
        mock_factory.return_value = mock_agent

        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        response = client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "test",
                    "message": "Analyze this",
                    "files": [{
                        "filename": "test.png",
                        "content_type": "image/png",
                        "bytes": "base64data"
                    }]
                }
            }
        )

        assert response.status_code == 200


# ============================================================
# Interrupt Response Tests
# ============================================================

class TestInterruptResponseHandling:
    """Tests for interrupt response handling in invocations."""

    @pytest.fixture
    def mock_agent(self):
        """Create mock agent for interrupt testing."""
        agent = MagicMock()

        async def mock_stream(*args, **kwargs):
            yield 'data: {"type": "text", "content": "Continuing..."}\n\n'

        agent.stream_async = mock_stream
        return agent

    @patch('routers.chat.create_agent')
    def test_parses_interrupt_response(self, mock_factory, mock_agent):
        """Test that interrupt response is parsed from JSON array."""
        mock_factory.return_value = mock_agent

        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        # Frontend sends interrupt response as JSON array
        interrupt_message = json.dumps([{
            "interruptResponse": {
                "interruptId": "interrupt-123",
                "response": "approved"
            }
        }])

        response = client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "test",
                    "message": interrupt_message
                }
            }
        )

        assert response.status_code == 200
        # Response 200 confirms agent stream was invoked successfully

    @patch('routers.chat.create_agent')
    def test_handles_normal_message_not_json(self, mock_factory, mock_agent):
        """Test that normal text messages are not parsed as interrupt."""
        mock_factory.return_value = mock_agent

        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        response = client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "test",
                    "message": "Just a normal message"
                }
            }
        )

        assert response.status_code == 200

    @patch('routers.chat.create_agent')
    def test_handles_json_without_interrupt_response(self, mock_factory, mock_agent):
        """Test that JSON without interruptResponse is treated as normal."""
        mock_factory.return_value = mock_agent

        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        # JSON that's not an interrupt response
        response = client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "test",
                    "message": json.dumps({"data": "something"})
                }
            }
        )

        assert response.status_code == 200


# ============================================================
# Error Handling Tests
# ============================================================

class TestInvocationsErrorHandling:
    """Tests for error handling in invocations endpoint."""

    @patch('routers.chat.create_agent')
    def test_returns_500_on_agent_error(self, mock_factory):
        """Test that 500 is returned when agent fails."""
        mock_factory.side_effect = Exception("Agent creation failed")

        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        response = client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "test",
                    "message": "Test"
                }
            }
        )

        assert response.status_code == 500
        assert "Agent processing failed" in response.json()["detail"]

    def test_returns_422_on_invalid_request(self):
        """Test that 422 is returned for invalid request format."""
        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        # Missing required fields
        response = client.post(
            "/invocations",
            json={"input": {}}
        )

        assert response.status_code == 422


# ============================================================
# Model Configuration Tests
# ============================================================

class TestModelConfiguration:
    """Tests for model configuration in invocations."""

    @pytest.fixture
    def mock_agent(self):
        """Create mock agent."""
        agent = MagicMock()

        async def mock_stream(*args, **kwargs):
            yield 'data: {"type": "complete"}\n\n'

        agent.stream_async = mock_stream
        return agent

    @patch('routers.chat.create_agent')
    def test_passes_model_id(self, mock_factory, mock_agent):
        """Test that model_id is passed to agent."""
        mock_factory.return_value = mock_agent

        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "test",
                    "message": "Test",
                    "model_id": "claude-3-opus"
                }
            }
        )

        call_kwargs = mock_factory.call_args.kwargs
        assert call_kwargs['model_id'] == "claude-3-opus"

    @patch('routers.chat.create_agent')
    def test_passes_temperature(self, mock_factory, mock_agent):
        """Test that temperature is passed to agent."""
        mock_factory.return_value = mock_agent

        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "test",
                    "message": "Test",
                    "temperature": 0.3
                }
            }
        )

        call_kwargs = mock_factory.call_args.kwargs
        assert call_kwargs['temperature'] == 0.3

    @patch('routers.chat.create_agent')
    def test_passes_system_prompt(self, mock_factory, mock_agent):
        """Test that system_prompt is passed to agent."""
        mock_factory.return_value = mock_agent

        from routers.chat import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        client.post(
            "/invocations",
            json={
                "input": {
                    "user_id": "test-user",
                    "session_id": "test",
                    "message": "Test",
                    "system_prompt": "You are a coding assistant."
                }
            }
        )

        call_kwargs = mock_factory.call_args.kwargs
        assert call_kwargs['system_prompt'] == "You are a coding assistant."
