"""SwarmAgent - Multi-agent orchestration using Strands Swarm

This module encapsulates swarm creation and execution logic:
- Creates specialist agents with predefined tool sets
- Orchestrates multi-agent collaboration
- Streams swarm events (node start/stop, handoffs, tool execution)
- Saves swarm state to unified storage

Unlike ChatAgent, SwarmAgent:
- Does NOT use session_manager for agent state (to avoid SDK bugs)
- Does NOT filter tools by user preference (each agent has fixed tools)
- DOES save conversation history to unified storage for cross-mode sharing
"""

import logging
import os
import asyncio
import json
import copy
from typing import Dict, List, Optional, AsyncGenerator, Any
from pathlib import Path

from strands import Agent
from strands.models import BedrockModel
from strands.multiagent import Swarm
from botocore.config import Config
from fastapi import Request

from agents.base import BaseAgent
from agent.config.swarm_config import (
    AGENT_TOOL_MAPPING,
    AGENT_DESCRIPTIONS,
    build_agent_system_prompt,
)
from agent.tool_filter import filter_tools
from models.swarm_schemas import (
    SwarmNodeStartEvent,
    SwarmNodeStopEvent,
    SwarmHandoffEvent,
    SwarmCompleteEvent,
)

logger = logging.getLogger(__name__)


class SwarmAgent(BaseAgent):
    """
    Multi-agent orchestration agent using Strands Swarm pattern.

    Swarm mode features:
    - Coordinator routes tasks to specialist agents
    - Specialists hand off to each other autonomously
    - Responder generates final user-facing response
    - All agents share context via SDK's shared_context
    - No session manager for agent state (SDK limitation)
    - Conversation history saved to unified storage
    """

    def __init__(
        self,
        session_id: str,
        user_id: Optional[str] = None,
        model_id: Optional[str] = None,
        coordinator_model_id: Optional[str] = None,
        max_handoffs: int = 15,
        max_iterations: int = 15,
        execution_timeout: float = 600.0,
        node_timeout: float = 180.0,
    ):
        """
        Initialize SwarmAgent with swarm configuration

        Args:
            session_id: Session identifier for message persistence
            user_id: User identifier (defaults to session_id)
            model_id: Model ID for specialist agents
            coordinator_model_id: Model ID for coordinator agent
            max_handoffs: Maximum agent handoffs allowed
            max_iterations: Maximum node executions
            execution_timeout: Total execution timeout in seconds
            node_timeout: Individual node timeout in seconds
        """
        # Store swarm-specific parameters before calling super().__init__
        self.coordinator_model_id = coordinator_model_id or "us.anthropic.claude-haiku-4-5-20251001-v1:0"
        self.max_handoffs = max_handoffs
        self.max_iterations = max_iterations
        self.execution_timeout = execution_timeout
        self.node_timeout = node_timeout

        # Initialize base class (will call _load_tools, _build_system_prompt, _create_session_manager)
        # Note: enabled_tools is None - swarm agents use predefined tool sets
        super().__init__(
            session_id=session_id,
            user_id=user_id,
            enabled_tools=None,  # Swarm agents use AGENT_TOOL_MAPPING
            model_id=model_id,
            temperature=0.7,
            system_prompt=None,  # Not used by swarm
            caching_enabled=False,  # Not used by swarm
            compaction_enabled=False,  # Not used by swarm
        )

        # Create swarm with specialist agents
        self.swarm = self._create_swarm()

        # Message store for unified storage (same format as normal agent)
        self.message_store = self._create_message_store()

        logger.debug(
            f"[SwarmAgent] Initialized: session={session_id}, "
            f"max_handoffs={max_handoffs}, timeout={execution_timeout}s"
        )

    def _get_default_model_id(self) -> str:
        """Get default model ID for specialist agents"""
        return "us.anthropic.claude-sonnet-4-20250514-v1:0"

    def _load_tools(self) -> List:
        """
        Skip tool loading in base class.

        Swarm agents load their own tools based on AGENT_TOOL_MAPPING.
        This prevents the base class from loading tools.
        """
        return []

    def _build_system_prompt(self) -> str:
        """
        Skip system prompt building in base class.

        Swarm agents build their own prompts using build_agent_system_prompt().
        """
        return ""

    def _create_session_manager(self) -> Any:
        """
        Return None for swarm mode.

        SDK Swarm has bugs with session_manager state persistence:
        - FileSessionManager causes 'NoneType' has no attribute 'node_id' error
        - State deserialization fails when resuming completed state

        Instead, we use UnifiedFileSessionManager via message_store for history.
        """
        return None

    def _create_message_store(self) -> Any:
        """Create message store for conversation history"""
        from agent.session.swarm_message_store import get_swarm_message_store

        return get_swarm_message_store(
            session_id=self.session_id,
            user_id=self.user_id
        )

    def _create_swarm_agents(self) -> Dict[str, Agent]:
        """
        Create all specialist agents for the Swarm.

        Each agent gets:
        - Predefined tool set from AGENT_TOOL_MAPPING
        - Role-specific system prompt
        - Appropriate model (coordinator uses Haiku, others use Sonnet)

        Returns:
            Dictionary mapping agent name to Agent instance
        """
        region = os.environ.get("AWS_REGION", "us-west-2")

        # Retry configuration
        retry_config = Config(
            retries={"max_attempts": 5, "mode": "adaptive"},
            connect_timeout=30,
            read_timeout=180,
        )

        # Create models
        main_model = BedrockModel(
            model_id=self.model_id,
            temperature=0.7,
            boto_client_config=retry_config,
        )

        coordinator_model = BedrockModel(
            model_id=self.coordinator_model_id,
            temperature=0.3,  # Lower temperature for routing decisions
            boto_client_config=retry_config,
        )

        # Responder needs higher max_tokens to handle large context + tool results
        responder_model = BedrockModel(
            model_id=self.model_id,
            temperature=0.7,
            max_tokens=4096,
            boto_client_config=retry_config,
        )

        agents: Dict[str, Agent] = {}

        # Agent configurations: (name, model, use_tools)
        agent_configs = [
            ("coordinator", coordinator_model, False),
            ("web_researcher", main_model, True),
            ("academic_researcher", main_model, True),
            ("word_agent", main_model, True),
            ("excel_agent", main_model, True),
            ("powerpoint_agent", main_model, True),
            ("data_analyst", main_model, True),
            ("browser_agent", main_model, True),
            ("weather_agent", main_model, True),
            ("finance_agent", main_model, True),
            ("maps_agent", main_model, True),
            ("responder", responder_model, True),  # Higher max_tokens for final response
        ]

        for agent_name, model, use_tools in agent_configs:
            # Get tools if this agent uses them
            tools = []
            if use_tools:
                tools = get_tools_for_agent(agent_name)
                # Log tool loading details for debugging
                expected_tools = AGENT_TOOL_MAPPING.get(agent_name, [])
                if expected_tools and not tools:
                    logger.warning(
                        f"[SwarmAgent] Agent '{agent_name}' expected tools {expected_tools} "
                        f"but got 0 tools. Check if gateway tools are connected."
                    )

            # Build system prompt
            system_prompt = build_agent_system_prompt(agent_name)

            # Create agent
            agents[agent_name] = Agent(
                name=agent_name,
                description=AGENT_DESCRIPTIONS.get(agent_name, ""),
                model=model,
                system_prompt=system_prompt,
                tools=tools,
            )

            tool_count = len(tools) if tools else 0
            logger.debug(f"[SwarmAgent] Created agent '{agent_name}' with {tool_count} tools")

        logger.info(f"[SwarmAgent] Created {len(agents)} agents for session {self.session_id}")

        return agents

    def _create_swarm(self) -> Swarm:
        """
        Create a configured Swarm instance.

        Swarm configuration:
        - Entry point: coordinator (analyzes and routes tasks)
        - Session manager: None (to avoid SDK bugs)
        - Handoff detection: prevents ping-pong patterns
        - Responder: Final agent with handoff_to_agent removed

        Returns:
            Configured Swarm instance
        """
        # Create all agents
        agents = self._create_swarm_agents()

        # Create Swarm with coordinator as entry point
        swarm = Swarm(
            nodes=list(agents.values()),
            entry_point=agents["coordinator"],
            session_manager=None,  # Disabled to avoid state persistence bugs
            max_handoffs=self.max_handoffs,
            max_iterations=self.max_iterations,
            execution_timeout=self.execution_timeout,
            node_timeout=self.node_timeout,
            # Detect ping-pong patterns (same agents passing back and forth)
            repetitive_handoff_detection_window=6,
            repetitive_handoff_min_unique_agents=2,
        )

        # Remove handoff_to_agent from responder - it should NEVER hand off
        # Responder is the final agent that generates user-facing response
        responder_node = swarm.nodes.get("responder")
        if responder_node and hasattr(responder_node, "executor"):
            tool_registry = responder_node.executor.tool_registry
            if hasattr(tool_registry, "registry") and "handoff_to_agent" in tool_registry.registry:
                del tool_registry.registry["handoff_to_agent"]
                logger.debug("[SwarmAgent] Removed handoff_to_agent from responder")

        logger.debug(
            f"[SwarmAgent] Created Swarm: "
            f"max_handoffs={self.max_handoffs}, timeout={self.execution_timeout}s"
        )

        return swarm

    async def stream_async(
        self,
        message: str,
        http_request: Optional[Request] = None,
        **kwargs
    ) -> AsyncGenerator[str, None]:
        """
        Stream swarm execution with multi-agent orchestration.

        Flow:
        1. Inject conversation history into coordinator
        2. Execute swarm.stream_async with user query
        3. Stream events: node start/stop, handoffs, tool execution, text
        4. Save turn to unified storage

        Args:
            message: User message
            http_request: FastAPI Request for disconnect detection
            **kwargs: Additional parameters (unused)

        Yields:
            SSE-formatted strings with swarm events
        """
        from agent.stop_signal import get_stop_signal_provider

        user_query = message
        stop_signal_provider = get_stop_signal_provider()

        logger.info(f"[SwarmAgent] Starting for session {self.session_id}: {user_query[:50]}...")

        # Inject conversation history into coordinator
        # SDK SwarmNode captures _initial_messages at creation time and resets to it before each execution.
        # To inject history, we must update BOTH executor.messages AND _initial_messages.
        history_messages = self.message_store.get_history_messages()
        coordinator_node = self.swarm.nodes.get("coordinator")

        if history_messages and coordinator_node:
            # Update executor.messages (current state)
            coordinator_node.executor.messages = history_messages
            # Update _initial_messages (reset state) - this is what gets restored on reset_executor_state()
            coordinator_node._initial_messages = copy.deepcopy(history_messages)
            logger.info(f"[SwarmAgent] Injected {len(history_messages)} history messages into coordinator")
        else:
            logger.info(f"[SwarmAgent] No history (new session or first turn)")

        # Prepare invocation_state for tool context access
        invocation_state = {
            'user_id': self.user_id,
            'session_id': self.session_id,
            'model_id': self.model_id,
        }
        logger.info(f"[SwarmAgent] Prepared invocation_state: user_id={self.user_id}, session_id={self.session_id}")

        # Yield start event
        yield f"data: {json.dumps({'type': 'start'})}\n\n"

        # Token usage accumulator
        total_usage = {
            "inputTokens": 0,
            "outputTokens": 0,
            "totalTokens": 0,
        }

        node_history = []
        current_node_id = None
        responder_tool_ids: set = set()  # Track sent tool_use events for responder (avoid duplicates)
        # Track accumulated text for each node (for fallback when non-responder ends without handoff)
        node_text_accumulator: Dict[str, str] = {}
        # Track swarm state for session storage
        swarm_shared_context = {}
        # Track responder's content blocks in order: [text, toolUse, toolResult, text, ...]
        responder_content_blocks: List[Dict] = []
        responder_current_text: str = ""  # Current text segment (before tool or between tools)
        responder_pending_tools: Dict[str, Dict] = {}  # toolUseId -> toolUse block

        try:
            # Execute Swarm with streaming
            last_event_time = asyncio.get_event_loop().time()
            event_count = 0

            async for event in self.swarm.stream_async(user_query, invocation_state=invocation_state):
                event_count += 1
                current_time = asyncio.get_event_loop().time()
                time_since_last = current_time - last_event_time
                last_event_time = current_time

                # Check for client disconnect
                if http_request and await http_request.is_disconnected():
                    logger.info(f"[SwarmAgent] Client disconnected")
                    break

                # Check for stop signal (user requested stop)
                if stop_signal_provider.is_stop_requested(self.user_id, self.session_id):
                    logger.info(f"[SwarmAgent] Stop signal received for {self.session_id}")
                    stop_signal_provider.clear_stop_signal(self.user_id, self.session_id)
                    # Send stop complete event (don't save incomplete turn)
                    yield f"data: {json.dumps({'type': 'complete', 'message': 'Stream stopped by user'})}\n\n"
                    break

                event_type = event.get("type")

                # Log event timing only for long gaps (debugging)
                if time_since_last > 10.0:
                    logger.warning(f"[SwarmAgent] Long gap: {time_since_last:.1f}s since last event")

                # Node start
                if event_type == "multiagent_node_start":
                    node_id = event.get("node_id")
                    current_node_id = node_id
                    node_history.append(node_id)

                    start_event = SwarmNodeStartEvent(
                        node_id=node_id,
                        node_description=AGENT_DESCRIPTIONS.get(node_id, "")
                    )
                    yield f"data: {json.dumps(start_event.model_dump())}\n\n"
                    logger.debug(f"[SwarmAgent] Node started: {node_id}")

                # Node stream (agent output)
                elif event_type == "multiagent_node_stream":
                    inner_event = event.get("event", {})
                    node_id = event.get("node_id", current_node_id)

                    # Reasoning event - SDK emits {"reasoningText": str, "reasoning": True}
                    if "reasoningText" in inner_event:
                        reasoning_text = inner_event["reasoningText"]
                        if reasoning_text:
                            yield f"data: {json.dumps({'type': 'reasoning', 'text': reasoning_text, 'node_id': node_id})}\n\n"

                    # Text output - SDK emits {"data": str}
                    elif "data" in inner_event:
                        text_data = inner_event["data"]
                        # Accumulate text for fallback (when non-responder ends without handoff)
                        if node_id not in node_text_accumulator:
                            node_text_accumulator[node_id] = ""
                        node_text_accumulator[node_id] += text_data

                        if node_id == "responder":
                            # Final response - displayed as chat message
                            responder_current_text += text_data
                            yield f"data: {json.dumps({'type': 'response', 'text': text_data, 'node_id': node_id})}\n\n"
                        else:
                            # Intermediate agent text - for SwarmProgress display only
                            yield f"data: {json.dumps({'type': 'text', 'content': text_data, 'node_id': node_id})}\n\n"

                    # Tool events - only responder's tools are sent to frontend for real-time rendering
                    elif inner_event.get("type") == "tool_use_stream" and node_id == "responder":
                        # Send first tool_use event only (not streaming deltas)
                        current_tool = inner_event.get("current_tool_use", {})
                        tool_id = current_tool.get("toolUseId")
                        if current_tool and tool_id and tool_id not in responder_tool_ids:
                            responder_tool_ids.add(tool_id)
                            tool_event = {
                                "type": "tool_use",
                                "toolUseId": tool_id,
                                "name": current_tool.get("name"),
                                "input": {}
                            }
                            logger.debug(f"[SwarmAgent] Responder tool use: {tool_event.get('name')}")
                            yield f"data: {json.dumps(tool_event)}\n\n"

                            # Save current text segment before tool (if any)
                            if responder_current_text.strip():
                                responder_content_blocks.append({"text": responder_current_text})
                                responder_current_text = ""

                            # Store toolUse block for session storage
                            # Ensure input is a dict (Bedrock API rejects empty string)
                            tool_input = current_tool.get("input")
                            if not isinstance(tool_input, dict):
                                tool_input = {}
                            tool_use_block = {
                                "toolUse": {
                                    "toolUseId": tool_id,
                                    "name": current_tool.get("name"),
                                    "input": tool_input
                                }
                            }
                            responder_pending_tools[tool_id] = tool_use_block

                    # Tool result comes via 'message' event with role='user' containing toolResult blocks
                    elif "message" in inner_event and node_id == "responder":
                        msg = inner_event.get("message", {})
                        if msg.get("role") == "user" and msg.get("content"):
                            for content_block in msg["content"]:
                                if isinstance(content_block, dict) and "toolResult" in content_block:
                                    tool_result = content_block["toolResult"]
                                    tool_use_id = tool_result.get("toolUseId")
                                    # Only send if we haven't already sent this tool result
                                    if tool_use_id and tool_use_id in responder_tool_ids:
                                        result_event = {
                                            "type": "tool_result",
                                            "toolUseId": tool_use_id,
                                            "status": tool_result.get("status", "success")
                                        }
                                        # Extract text from content
                                        if tool_result.get("content"):
                                            for result_content in tool_result["content"]:
                                                if isinstance(result_content, dict) and "text" in result_content:
                                                    result_event["result"] = result_content["text"]
                                        logger.info(f"[SwarmAgent] Responder tool result: {tool_use_id}")
                                        yield f"data: {json.dumps(result_event)}\n\n"

                                        # Store toolUse + toolResult blocks in content order
                                        if tool_use_id in responder_pending_tools:
                                            responder_content_blocks.append(responder_pending_tools.pop(tool_use_id))
                                            responder_content_blocks.append({"toolResult": tool_result})

                                        # Remove from set to prevent duplicate sends
                                        responder_tool_ids.discard(tool_use_id)

                # Node stop
                elif event_type == "multiagent_node_stop":
                    node_id = event.get("node_id")
                    node_result = event.get("node_result", {})

                    # Accumulate usage
                    if hasattr(node_result, "accumulated_usage"):
                        usage = node_result.accumulated_usage
                        total_usage["inputTokens"] += usage.get("inputTokens", 0)
                        total_usage["outputTokens"] += usage.get("outputTokens", 0)
                        total_usage["totalTokens"] += usage.get("totalTokens", 0)
                    elif isinstance(node_result, dict) and "accumulated_usage" in node_result:
                        usage = node_result["accumulated_usage"]
                        total_usage["inputTokens"] += usage.get("inputTokens", 0)
                        total_usage["outputTokens"] += usage.get("outputTokens", 0)
                        total_usage["totalTokens"] += usage.get("totalTokens", 0)

                    status = "completed"
                    if hasattr(node_result, "status"):
                        status = node_result.status.value if hasattr(node_result.status, "value") else str(node_result.status)
                    elif isinstance(node_result, dict):
                        status = node_result.get("status", "completed")

                    stop_event = SwarmNodeStopEvent(
                        node_id=node_id,
                        status=status
                    )
                    yield f"data: {json.dumps(stop_event.model_dump())}\n\n"
                    logger.debug(f"[SwarmAgent] Node stopped: {node_id}")

                # Handoff
                elif event_type == "multiagent_handoff":
                    from_nodes = event.get("from_node_ids", [])
                    to_nodes = event.get("to_node_ids", [])
                    handoff_message = event.get("message")

                    # Get context from the handing-off agent's shared_context
                    from_node = from_nodes[0] if from_nodes else ""
                    agent_context = None
                    if from_node and hasattr(self.swarm, 'shared_context'):
                        agent_context = self.swarm.shared_context.context.get(from_node)
                        # Capture shared context for session storage
                        if agent_context:
                            swarm_shared_context[from_node] = agent_context
                            logger.info(f"[SwarmAgent] Captured context from {from_node}: {agent_context}")

                    handoff_event = SwarmHandoffEvent(
                        from_node=from_node,
                        to_node=to_nodes[0] if to_nodes else "",
                        message=handoff_message,
                        context=agent_context
                    )
                    yield f"data: {json.dumps(handoff_event.model_dump())}\n\n"
                    logger.info(f"[SwarmAgent] Handoff: {from_node or '?'} → {to_nodes[0] if to_nodes else '?'}")

                # Final result
                elif event_type == "multiagent_result":
                    result = event.get("result", {})

                    status = "completed"
                    if hasattr(result, "status"):
                        status = result.status.value if hasattr(result.status, "value") else str(result.status)
                    elif isinstance(result, dict):
                        status = result.get("status", "completed")

                    # Check if last node was NOT responder (fallback case)
                    final_response = None
                    final_node_id = None
                    if node_history:
                        last_node = node_history[-1]
                        if last_node != "responder":
                            # Fallback: non-responder ended without handoff
                            accumulated_text = node_text_accumulator.get(last_node, "")
                            if accumulated_text.strip():
                                final_response = accumulated_text
                                final_node_id = last_node
                                logger.info(f"[SwarmAgent] Fallback response from {last_node} ({len(accumulated_text)} chars)")

                    # Add any remaining text segment after the last tool
                    if responder_current_text.strip():
                        responder_content_blocks.append({"text": responder_current_text})

                    # Fallback: if no content blocks but have fallback response
                    if not responder_content_blocks and final_response:
                        responder_content_blocks.append({"text": final_response})

                    # Save turn to unified storage (same format as normal agent)
                    if responder_content_blocks:
                        swarm_state = {
                            "node_history": node_history,
                            "shared_context": swarm_shared_context,
                        }
                        self.message_store.save_turn(
                            user_message=user_query,
                            content_blocks=responder_content_blocks,
                            swarm_state=swarm_state
                        )

                    complete_event = SwarmCompleteEvent(
                        total_nodes=len(node_history),
                        node_history=node_history,
                        status=status,
                        final_response=final_response,
                        final_node_id=final_node_id,
                        shared_context=swarm_shared_context
                    )
                    yield f"data: {json.dumps(complete_event.model_dump())}\n\n"

                    # Final complete event with usage
                    final_usage = {k: v for k, v in total_usage.items() if v > 0}
                    yield f"data: {json.dumps({'type': 'complete', 'usage': final_usage if final_usage else None})}\n\n"

                    logger.info(f"[SwarmAgent] Complete: {len(node_history)} nodes, tokens={total_usage['inputTokens']+total_usage['outputTokens']}")

        except Exception as e:
            logger.error(f"[SwarmAgent] Error: {e}")
            import traceback
            traceback.print_exc()
            # Error occurred - don't save incomplete turn
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"

        finally:
            yield f"data: {json.dumps({'type': 'end'})}\n\n"


def get_tools_for_agent(agent_name: str) -> List:
    """
    Get all tools assigned to a specific agent.

    Swarm mode uses ALL tools assigned to each agent without user filtering.
    Each agent has a predefined set of tools based on their specialty.

    Args:
        agent_name: Name of the agent (must be in AGENT_TOOL_MAPPING)

    Returns:
        List of tool objects for the agent
    """
    # Get tools assigned to this agent
    agent_tool_ids = AGENT_TOOL_MAPPING.get(agent_name, [])

    if not agent_tool_ids:
        return []

    # Use the unified tool filter to get actual tool objects
    # No user filtering - Swarm agents get ALL their assigned tools
    result = filter_tools(
        enabled_tool_ids=agent_tool_ids,
        log_prefix=f"[Swarm:{agent_name}]"
    )

    return result.tools
