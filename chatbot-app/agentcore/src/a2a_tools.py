"""
A2A Agent Tools Module

Integrates AgentCore Runtime A2A agents as direct callable tools.
Uses A2A SDK to communicate with agents deployed on AgentCore Runtime.

Based on: amazon-bedrock-agentcore-samples orchestrator pattern
"""

import boto3
import logging
import os
import asyncio
from typing import Optional
from urllib.parse import quote
from uuid import uuid4
from strands.tools import tool
from strands.types.tools import ToolContext

import httpx
from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
from a2a.types import Message, Part, Role, TextPart

# Import SigV4 auth for IAM authentication
from agent.gateway_auth import get_sigv4_auth

logger = logging.getLogger(__name__)

# ============================================================
# A2A Agent Configuration Registry
# ============================================================

A2A_AGENTS_CONFIG = {
    "agentcore_research-agent": {
        "name": "Research Agent",
        "description": "Web research agent that searches multiple sources and generates structured markdown reports with citations. Clarifies scope if request is too broad.",
        "runtime_arn_ssm": "/strands-agent-chatbot/dev/a2a/research-agent-runtime-arn",
    },
}

# Global cache
_cache = {
    'agent_arns': {},
    'agent_cards': {},
    'http_client': None
}

DEFAULT_TIMEOUT = 1200  # 20 minutes for research tasks
AGENT_TIMEOUT = 1200    # 1200s (20 minutes) per agent call for complex research


# ============================================================
# Helper Functions
# ============================================================

def get_cached_agent_arn(agent_id: str, region: str = "us-west-2") -> Optional[str]:
    """Get and cache agent ARN from SSM"""
    if agent_id not in _cache['agent_arns']:
        if agent_id not in A2A_AGENTS_CONFIG:
            return None

        config = A2A_AGENTS_CONFIG[agent_id]
        ssm_param = config['runtime_arn_ssm']

        try:
            ssm = boto3.client('ssm', region_name=region)
            response = ssm.get_parameter(Name=ssm_param)
            _cache['agent_arns'][agent_id] = response['Parameter']['Value']
            logger.info(f"Cached ARN for {agent_id}: {_cache['agent_arns'][agent_id]}")
        except Exception as e:
            logger.error(f"Failed to get ARN for {agent_id}: {e}")
            return None

    return _cache['agent_arns'][agent_id]


def get_http_client(region: str = "us-west-2"):
    """Reuse HTTP client with SigV4 IAM authentication"""
    if not _cache['http_client']:
        # Create SigV4 auth handler for IAM authentication
        sigv4_auth = get_sigv4_auth(
            service="bedrock-agentcore",
            region=region
        )

        _cache['http_client'] = httpx.AsyncClient(
            timeout=httpx.Timeout(DEFAULT_TIMEOUT, connect=30.0),  # 20 min timeout, 30s connect
            limits=httpx.Limits(max_keepalive_connections=5, max_connections=10),
            auth=sigv4_auth  # Add SigV4 auth
        )
        logger.info(f"Created HTTP client with SigV4 IAM auth (timeout: {DEFAULT_TIMEOUT}s) for region {region}")
    return _cache['http_client']


async def send_a2a_message(
    agent_id: str,
    message: str,
    session_id: Optional[str] = None,
    region: str = "us-west-2",
    metadata: Optional[dict] = None
) -> Optional[str]:
    """
    Send message to A2A agent on AgentCore Runtime

    Args:
        agent_id: Agent identifier (e.g., "agentcore_research-agent")
        message: User message to send
        session_id: Session ID from BFF (optional, will generate if not provided)
        region: AWS region
        metadata: Additional payload to send (user_id, preferences, context, etc.)

    Returns:
        Agent response text

    Example metadata:
        {
            "user_id": "user123",
            "language": "ko",
            "max_sources": 5,
            "depth": "detailed",
            "format_preference": "markdown"
        }
    """
    try:
        # Check for local testing mode
        local_runtime_url = os.environ.get('LOCAL_RESEARCH_AGENT_URL')

        if local_runtime_url:
            # Local testing: use localhost URL
            runtime_url = local_runtime_url
            logger.info(f"🧪 LOCAL TEST MODE: Using local Research Agent at {runtime_url}")
        else:
            # Production: use AgentCore Runtime
            agent_arn = get_cached_agent_arn(agent_id, region)
            if not agent_arn:
                return f"Error: Could not find agent ARN for {agent_id}"

            escaped_arn = quote(agent_arn, safe='')
            runtime_url = f"https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{escaped_arn}/invocations/"

        logger.info(f"Invoking A2A agent {agent_id}")
        logger.info(f"  Runtime URL: {runtime_url}")
        logger.info(f"  Message: {message[:100]}...")

        # Get HTTP client with SigV4 IAM auth
        httpx_client = get_http_client(region)

        # Add session ID header (must be >= 33 characters)
        if not session_id:
            session_id = str(uuid4()) + "-" + str(uuid4())[:8]  # UUID (36) + dash + 8 chars = 45 chars

        # Ensure session ID meets minimum length requirement
        if len(session_id) < 33:
            session_id = session_id + "-" + str(uuid4())[:max(0, 33 - len(session_id) - 1)]

        headers = {
            'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': session_id
        }
        httpx_client.headers.update(headers)
        logger.info(f"  Session ID: {session_id}")

        # Get or cache agent card
        if agent_arn not in _cache['agent_cards']:
            logger.info(f"Fetching runtime URL and agent card for ARN: {agent_arn}")

            try:
                # Step 1: Use boto3 SDK to get actual runtime URL from agent card
                bedrock_agentcore = boto3.client('bedrock-agentcore', region_name=region)
                response = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: bedrock_agentcore.get_agent_card(agentRuntimeArn=agent_arn)
                )

                # Extract actual runtime URL from agent card response
                agent_card_data = response.get('agentCard', {})
                actual_runtime_url = agent_card_data.get('url')

                if actual_runtime_url:
                    # Remove trailing slash
                    if actual_runtime_url.endswith('/'):
                        actual_runtime_url = actual_runtime_url[:-1]
                    runtime_url = actual_runtime_url
                    logger.info(f"Got runtime URL from boto3: {runtime_url}")
                else:
                    logger.warning(f"No URL in boto3 agent card response, using constructed URL: {runtime_url}")

                # Step 2: Use A2ACardResolver to get proper agent card object
                # Now we use the correct runtime URL (not the ARN-encoded one)
                logger.info(f"Fetching agent card via A2ACardResolver from: {runtime_url}")
                resolver = A2ACardResolver(httpx_client=httpx_client, base_url=runtime_url)

                _cache['agent_cards'][agent_arn] = await asyncio.wait_for(
                    resolver.get_agent_card(),
                    timeout=60.0  # 60 second timeout for agent card fetch
                )
                logger.info(f"✅ Retrieved agent card for {agent_id}")

            except asyncio.TimeoutError:
                logger.error(f"Timeout fetching agent card after 60s")
                raise
            except Exception as e:
                logger.error(f"Error fetching agent card: {e}")
                raise

        agent_card = _cache['agent_cards'][agent_arn]

        # Create A2A client with streaming enabled
        config = ClientConfig(httpx_client=httpx_client, streaming=True)
        factory = ClientFactory(config)
        client = factory.create(agent_card)

        # Create message with metadata in Message.metadata
        # Note: Streaming client expects Message directly, not SendMessageRequest
        # The streaming client interface wraps it internally
        msg = Message(
            kind="message",
            role=Role.user,
            parts=[Part(TextPart(kind="text", text=message))],
            message_id=uuid4().hex,
            metadata=metadata  # Put metadata here for streaming client
        )

        if metadata:
            logger.info(f"  Message metadata: {metadata}")

        response_text = ""
        async with asyncio.timeout(AGENT_TIMEOUT):
            async for event in client.send_message(msg):
                logger.debug(f"Received A2A event type: {type(event).__name__}")

                if isinstance(event, Message):
                    # Extract text and images from Message response (multimodal support)
                    response_text = ""
                    response_images = []

                    if event.parts and len(event.parts) > 0:
                        for part in event.parts:
                            # Extract text
                            if hasattr(part, 'text'):
                                response_text += part.text
                            elif hasattr(part, 'root') and hasattr(part.root, 'text'):
                                response_text += part.root.text
                            # Extract images (if A2A supports image content)
                            elif hasattr(part, 'image'):
                                response_images.append(part.image)
                            elif hasattr(part, 'root') and hasattr(part.root, 'image'):
                                response_images.append(part.root.image)

                    logger.info(f"✅ A2A Message received ({len(response_text)} chars, {len(response_images)} images)")

                    # TODO: Handle images - for now just return text
                    # In future, could return structured format: {"text": ..., "images": [...]}
                    return response_text

                elif isinstance(event, tuple) and len(event) == 2:
                    # (Task, UpdateEvent) tuple - streaming mode
                    task, update_event = event

                    # Extract task status
                    task_status = task.status if hasattr(task, 'status') else task
                    state = task_status.state if hasattr(task_status, 'state') else 'unknown'
                    logger.debug(f"Task state: {state}")

                    # Extract message from TaskStatus
                    if hasattr(task_status, 'message') and task_status.message:
                        message = task_status.message
                        if hasattr(message, 'parts') and message.parts and len(message.parts) > 0:
                            text_part = message.parts[0]

                            # Extract text from part
                            chunk_text = ""
                            if hasattr(text_part, 'root') and hasattr(text_part.root, 'text'):
                                chunk_text = text_part.root.text
                            elif hasattr(text_part, 'text'):
                                chunk_text = text_part.text
                            else:
                                chunk_text = str(text_part)

                            # Accumulate text chunks (silent)
                            if chunk_text:
                                response_text += chunk_text

                    # Check if task completed
                    if str(state) == 'TaskState.completed' or state == 'completed':
                        logger.info(f"✅ Task completed, extracting artifacts...")

                        # Extract all artifacts from completed task
                        if hasattr(task, 'artifacts') and task.artifacts:
                            logger.info(f"Found {len(task.artifacts)} artifact(s)")
                            for artifact in task.artifacts:
                                artifact_name = artifact.name if hasattr(artifact, 'name') else 'unnamed'
                                logger.info(f"Processing artifact: {artifact_name}")

                                if hasattr(artifact, 'parts') and artifact.parts:
                                    for part in artifact.parts:
                                        artifact_text = ""
                                        if hasattr(part, 'root') and hasattr(part.root, 'text'):
                                            artifact_text = part.root.text
                                        elif hasattr(part, 'text'):
                                            artifact_text = part.text

                                        if artifact_text:
                                            response_text += artifact_text
                                            logger.info(f"Added {len(artifact_text)} chars from artifact '{artifact_name}'")
                        else:
                            logger.warning("No artifacts found in completed task")

                        logger.info(f"✅ Total response with artifacts: {len(response_text)} chars")
                        # Don't return yet, continue to process any remaining events

                    # Log update events for progress tracking
                    if update_event and hasattr(update_event, 'final') and update_event.final:
                        logger.debug(f"Final update event received")

                else:
                    logger.debug(f"Unexpected event type: {type(event)}, content: {str(event)[:200]}")

        # Return accumulated response or timeout message
        if response_text:
            logger.info(f"✅ Final A2A response: {len(response_text)} chars")
            return response_text

        return "Timeout: No response received"

    except asyncio.TimeoutError:
        logger.warning(f"Timeout calling {agent_id} agent")
        return f"Agent {agent_id} timed out after {AGENT_TIMEOUT}s"
    except Exception as e:
        logger.error(f"Error calling {agent_id}: {e}")
        logger.exception(e)
        return f"Error: {str(e)}"


# ============================================================
# Factory Function - Creates Direct A2A Agent Tool
# ============================================================

def create_a2a_tool(agent_id: str):
    """
    Create a direct callable tool for the A2A agent

    Args:
        agent_id: Tool ID (e.g., "agentcore_research-agent")

    Returns:
        Strands tool function, or None if not found
    """
    if agent_id not in A2A_AGENTS_CONFIG:
        logger.warning(f"Unknown A2A agent: {agent_id}")
        return None

    config = A2A_AGENTS_CONFIG[agent_id]
    agent_name = config['name']
    agent_description = config['description']

    logger.info(f"Creating A2A tool: {agent_id}")
    logger.info(f"  Name: {agent_name}")
    logger.info(f"  Description: {agent_description}")

    # Preload ARN into cache
    region = os.environ.get('AWS_REGION', 'us-west-2')
    agent_arn = get_cached_agent_arn(agent_id, region)
    if not agent_arn:
        logger.error(f"Failed to get ARN for {agent_id}")
        return None

    # Create Strands tool function dynamically
    @tool(context=True)
    async def research_agent(plan: str, tool_context: ToolContext = None) -> str:
        """
        Comprehensive web research agent that searches multiple sources, analyzes information,
        and generates structured markdown reports with proper citations.

        Before using this tool:
        - If the user's request is too broad or unclear (e.g., "research AI"), clarify the scope first
        - Ask about: depth level (quick/detailed/deep-dive), target audience, specific focus areas
        - Create a clear, specific research plan based on user's clarification

        If the user declines the research:
        - Acknowledge: "I understand you've declined the research."
        - Ask: "Would you like me to adjust the scope, or provide a simpler answer?"
        - Offer alternatives: Modify the plan or use a different approach
        - NEVER repeat the exact same research plan that was just declined

        Args:
            plan: Research plan with objectives, topics, and expected report structure.

        Returns:
            Detailed research report in markdown format with citations

        Example plan:
            "Research Plan: AI Market Analysis 2024

            Objectives:
            - Analyze current AI market size and growth trends
            - Identify key players and their market share

            Topics to investigate:
            1. Global AI market statistics (2023-2024)
            2. Leading AI companies and their products
            3. Investment trends and funding

            Report structure:
            - Executive Summary
            - Market Overview
            - Key Players Analysis
            - Future Outlook"
        """
        # Get session ID, user_id, and model_id from tool context
        session_id = None
        user_id = None
        model_id = None

        if tool_context:
            # Try to get from invocation_state first
            session_id = tool_context.invocation_state.get("session_id")
            user_id = tool_context.invocation_state.get("user_id")
            model_id = tool_context.invocation_state.get("model_id")

            # Fallback to agent's session_manager
            if not session_id and hasattr(tool_context.agent, '_session_manager'):
                session_id = tool_context.agent._session_manager.session_id

            # Get user_id from agent if not in invocation_state
            if not user_id and hasattr(tool_context.agent, 'user_id'):
                user_id = tool_context.agent.user_id

            # Get model_id from agent if not in invocation_state
            if not model_id:
                if hasattr(tool_context.agent, 'model_id'):
                    model_id = tool_context.agent.model_id
                elif hasattr(tool_context.agent, 'model') and hasattr(tool_context.agent.model, 'model_id'):
                    model_id = tool_context.agent.model.model_id

        # Fallback to environment variable
        if not session_id:
            session_id = os.environ.get('SESSION_ID')
        if not user_id:
            user_id = os.environ.get('USER_ID')

        # Prepare metadata to send to research agent
        metadata = {
            "session_id": session_id,
            "user_id": user_id,
            "source": "main_agent",
            "model_id": model_id,  # Pass the model_id being used by main agent
            "language": "en",  # Can be dynamic based on user preference
        }

        logger.info(f"[research_agent] Sending to A2A with metadata: {metadata}")

        return await send_a2a_message(agent_id, plan, session_id, region, metadata=metadata)

    # Set function name dynamically
    research_agent.__name__ = agent_id.replace("agentcore_", "").replace("-", "_")
    research_agent.__doc__ = agent_description

    logger.info(f"✅ A2A tool created: {research_agent.__name__}")
    return research_agent


# Cleanup on shutdown
async def cleanup():
    if _cache['http_client']:
        await _cache['http_client'].aclose()
