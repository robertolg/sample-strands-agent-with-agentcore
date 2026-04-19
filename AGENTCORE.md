# AgentCore Integration Guide

This document explains how AWS Bedrock AgentCore is used in this chatbot platform.

## What is AgentCore?

AWS Bedrock AgentCore is a managed service for deploying containerized AI agents:
- **Runtime**: Managed container execution environment 
- **Memory**: Short/Long term conversation memory persistence
- **Gateway**: Transforming existing APIs into managed MCP servers
- **Identity**: End-user authentication and 3LO OAuth delegation
- **Registry**: Central catalog for discovering agent skills, MCP servers, and A2A agents
- **Observability**: Trace collection and agent execution monitoring

**Key Documentation**:
- Runtime: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html
- Memory: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html
- Gateway: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html

## How AgentCore is Used

### 1. AgentCore Runtime

**Location**: `chatbot-app/agentcore/`

The Strands Agent is containerized and deployed as an AgentCore Runtime:

```python
# chatbot-app/agentcore/src/agent/agent.py
from strands import Agent
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

class ChatbotAgent:
    def __init__(self, session_id: str, user_id: str):
        self.agent = Agent(
            model=BedrockModel(model_id="claude-sonnet-4"),
            tools=[...],
            session_manager=AgentCoreMemorySessionManager(...)  # AgentCore Memory
        )
```

**Key Features**:
- Runs on AWS Bedrock AgentCore managed runtime 
- Integrated with AgentCore Memory for conversation persistence
- Turn-based session management to optimize API calls
- Local tools (Weather, Visualization, etc.) embedded in container

### 2. AgentCore Memory

AgentCore Memory automatically persists conversation history:

```python
# Automatic persistence via AgentCoreMemorySessionManager
memory_config = AgentCoreMemoryConfig(
    memory_arn="arn:aws:bedrock-agentcore:...:memory/mem-xxx",
    max_tokens=12000
)

session_manager = AgentCoreMemorySessionManager(
    session_id=session_id,
    memory_config=memory_config
)
```

**Benefits**:
- Conversation history persisted across sessions
- Cross-session user preferences retained
- Automatic token limit management

### 3. AgentCore Gateway

**Terraform Module**: `infra/modules/gateway/`
**Tool Definitions**: `infra/registry/definitions/mcp/*.yaml`

AgentCore Gateway provides standardized access to Lambda tools:

```
AgentCore Runtime (with Cognito JWT)
           |
   AgentCore Gateway (CUSTOM_JWT auth)
           |
   +-------+--------+--------+---------+---------+
   |       |        |        |         |         |
Wikipedia ArXiv   Google   Tavily   Finance   Weather
Lambda    Lambda  Lambda   Lambda   Lambda    Lambda
```

**Benefits**:
- JWT-based authentication via Cognito
- Secure access to external services (no credentials in Runtime)
- Centralized API key management via Secrets Manager
- Lambda-based tools with auto-scaling

### 4. AgentCore Registry

**Terraform Module**: `infra/modules/registry/`
**Definitions**: `infra/registry/definitions/`

AgentCore Registry is a central catalog that enables runtime discovery of skills, tools, and agents:

```
infra/registry/definitions/
+-- mcp/        # MCP server definitions (Gateway Lambda tools)
+-- a2a/        # A2A agent definitions (Research, Code agents)
+-- skills/     # Agent skill definitions (with SKILL.md content)
```

Records are batched into 3 CloudFormation stacks by type (MCP, A2A, Skills) via a custom Lambda resource that wraps the AgentCore Registry API.

### 5. AgentCore Identity (3LO OAuth)

**Terraform Module**: `infra/modules/oauth-providers/`

AgentCore Identity manages per-user OAuth tokens for external services (Gmail, Calendar, GitHub, Notion). The 3LO flow delegates token exchange and storage to AgentCore's Token Vault.

See `docs/guides/THREE_LEGGED_OAUTH_FLOW.md` for the full flow.

### 6. AgentCore Observability

AgentCore provides built-in trace collection for agent execution monitoring, including tool call latency, token usage, and error rates.

## Key Files

| File | Purpose |
|------|---------|
| `chatbot-app/agentcore/src/agent/agent.py` | Main agent with AgentCore Memory integration |
| `chatbot-app/agentcore/src/agent/turn_based_session_manager.py` | Optimized memory persistence |
| `chatbot-app/agentcore/src/agent/gateway_mcp_client.py` | Gateway tool access |
| `infra/modules/runtime/` | Runtime deployment (Terraform) |
| `infra/modules/gateway/` | Gateway configuration (Terraform) |
| `infra/modules/gateway-lambda-tool/` | Lambda tool functions (Terraform) |
| `infra/registry/definitions/mcp/` | Gateway tool YAML definitions |
| `infra/modules/registry/` | Registry (skills, MCP servers, A2A agents) |
| `infra/modules/oauth-providers/` | OAuth credential providers (Google, GitHub, Notion) |
| `infra/modules/memory/` | AgentCore Memory configuration |

## Further Reading

- AWS Bedrock AgentCore Documentation: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/
- AgentCore Runtime: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html
- AgentCore Memory: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html
- AgentCore Gateway: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html

---

For implementation details, see:
- **README.md**: Architecture overview and features
- **DEPLOYMENT.md**: Step-by-step deployment instructions
