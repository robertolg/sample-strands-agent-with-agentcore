"""
AgentCore Context Middleware for FastMCP Servers

Bridges AgentCore Runtime request headers into BedrockAgentCoreContext.
Required when using FastMCP on AgentCore Runtime, since FastMCP does not
process AgentCore headers automatically (unlike BedrockAgentCoreApp).

Usage:
    from agentcore_context_middleware import AgentCoreContextMiddleware

    mcp = FastMCP()
    # ... define tools ...

    app = mcp.streamable_http_app()
    app.add_middleware(AgentCoreContextMiddleware)
"""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from bedrock_agentcore.runtime import BedrockAgentCoreContext


class AgentCoreContextMiddleware(BaseHTTPMiddleware):
    """Bridges AgentCore Runtime request headers into BedrockAgentCoreContext.

    AgentCore Runtime sends these headers on every invocation:
      - WorkloadAccessToken: per-user identity token
      - OAuth2CallbackUrl: OAuth redirect URL for 3LO flows
      - X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: session ID

    BedrockAgentCoreApp (FastAPI) handles this automatically, but FastMCP does not.
    This middleware fills that gap.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        # Debug: Log all headers to understand what AgentCore sends
        print(f"[Middleware] Request path: {request.url.path}")
        print(f"[Middleware] Headers received: {dict(request.headers)}")

        token = request.headers.get("WorkloadAccessToken")
        if token:
            print(f"[Middleware] WorkloadAccessToken found (length={len(token)})")
            BedrockAgentCoreContext.set_workload_access_token(token)
        else:
            print("[Middleware] WARNING: No WorkloadAccessToken header!")

        callback_url = request.headers.get("OAuth2CallbackUrl")
        if callback_url:
            print(f"[Middleware] OAuth2CallbackUrl found: {callback_url}")
            BedrockAgentCoreContext.set_oauth2_callback_url(callback_url)
        else:
            print("[Middleware] WARNING: No OAuth2CallbackUrl header!")

        session_id = request.headers.get("X-Amzn-Bedrock-AgentCore-Runtime-Session-Id")
        if session_id:
            BedrockAgentCoreContext.set_request_context(
                request_id=request.headers.get("X-Amzn-Request-Id", ""),
                session_id=session_id,
            )

        return await call_next(request)
