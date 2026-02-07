"""
AgentCore OAuth Helper for 3LO MCP Servers

Provides reusable OAuth/Identity functionality for MCP servers that need
per-user authentication via AgentCore Identity 3LO (Three-Legged OAuth).

Usage:
    from agentcore_oauth import (
        OAuthRequiredException,
        OAuthHelper,
        format_auth_required_response,
    )

    # Create helper for your OAuth provider
    oauth = OAuthHelper(
        provider_name="google-oauth-provider",
        scopes=["https://www.googleapis.com/auth/gmail.modify"],
    )

    # In your tool handler
    async def my_tool():
        try:
            token = await oauth.get_access_token()
            # Use token to call external API
        except OAuthRequiredException as e:
            return format_auth_required_response(e.auth_url)
"""
import os
import json
import logging
import boto3
from typing import List, Optional

from bedrock_agentcore.services.identity import IdentityClient
from bedrock_agentcore.runtime import BedrockAgentCoreContext

logger = logging.getLogger(__name__)


# ── Custom Exception ─────────────────────────────────────────────────────

class OAuthRequiredException(Exception):
    """Raised when OAuth authorization is required.

    This exception is raised when the Identity service returns an
    authorizationUrl instead of a cached token. Tool handlers should
    catch this and return the auth URL to the client.

    The client displays this URL to the user. After consent completion,
    calling the tool again succeeds because the token is now cached
    in AgentCore Token Vault.

    Attributes:
        auth_url: The authorization URL for user consent
    """
    def __init__(self, auth_url: str):
        self.auth_url = auth_url
        super().__init__(f"OAUTH_REQUIRED:{auth_url}")


# ── Callback URL Loading ─────────────────────────────────────────────────

OAUTH_CALLBACK_PATH = "/oauth-complete"


def get_oauth_callback_url(
    env_var: str = "OAUTH2_CALLBACK_URL",
    ssm_param_suffix: str = "frontend-url",
) -> str:
    """Load OAuth callback URL from environment or SSM.

    After user completes consent, AgentCore redirects to this URL
    with a session_id query parameter. The frontend must then call
    CompleteResourceTokenAuth to finalize the token exchange.

    Resolution order:
    1. Environment variable (full URL with path)
    2. SSM parameter + /oauth-complete path

    Args:
        env_var: Environment variable name for callback URL
        ssm_param_suffix: SSM parameter suffix (appended to /{project}/{env}/)

    Returns:
        str: Full callback URL with /oauth-complete path

    Raises:
        RuntimeError: If callback URL cannot be resolved
    """
    # Check environment variable first
    env_url = os.environ.get(env_var)
    if env_url:
        logger.info(f"[OAuth] Callback URL from environment: {env_url}")
        return env_url

    # Try SSM Parameter Store
    project_name = os.environ.get("PROJECT_NAME", "strands-agent-chatbot")
    environment = os.environ.get("ENVIRONMENT", "dev")
    region = os.environ.get("AWS_REGION", "us-west-2")
    ssm_param = f"/{project_name}/{environment}/{ssm_param_suffix}"

    try:
        ssm = boto3.client("ssm", region_name=region)
        response = ssm.get_parameter(Name=ssm_param)
        base_url = response["Parameter"]["Value"].rstrip("/")

        # Append /oauth-complete path if not already present
        if not base_url.endswith(OAUTH_CALLBACK_PATH):
            callback_url = f"{base_url}{OAUTH_CALLBACK_PATH}"
        else:
            callback_url = base_url

        logger.info(f"[OAuth] Callback URL from SSM: {callback_url}")
        return callback_url
    except Exception as e:
        logger.error(f"[OAuth] Failed to load callback URL from SSM ({ssm_param}): {e}")
        raise RuntimeError(
            f"OAuth callback URL not configured. "
            f"Set {env_var} environment variable or configure SSM parameter {ssm_param}."
        ) from e


# ── Response Formatting ──────────────────────────────────────────────────

def format_auth_required_response(
    auth_url: str,
    service_name: str = "external service",
) -> str:
    """Format OAuth authorization required response for client.

    Returns a JSON response that the client can parse to display
    the authorization URL to the user.

    Args:
        auth_url: The authorization URL for user consent
        service_name: Human-readable service name (e.g., "Gmail", "Calendar")

    Returns:
        str: JSON-formatted response with auth URL and instructions
    """
    return json.dumps({
        "oauth_required": True,
        "auth_url": auth_url,
        "message": f"{service_name} authorization required. Please click the link below to authorize access.",
        "instructions": [
            "1. Click the authorization link below",
            "2. Sign in with your account",
            "3. Grant the requested permissions",
            "4. After authorization completes, try this action again"
        ]
    }, indent=2)


# ── OAuth Helper Class ───────────────────────────────────────────────────

class OAuthHelper:
    """Helper class for OAuth token retrieval via AgentCore Identity.

    This class encapsulates the common pattern for getting OAuth tokens
    from AgentCore Token Vault. It handles:
    - Token retrieval from cache
    - Raising OAuthRequiredException when consent is needed
    - Provider and scope configuration

    Usage:
        oauth = OAuthHelper(
            provider_name="google-oauth-provider",
            scopes=["https://www.googleapis.com/auth/gmail.modify"],
        )

        try:
            token = await oauth.get_access_token()
        except OAuthRequiredException as e:
            return format_auth_required_response(e.auth_url, "Gmail")

    Attributes:
        provider_name: OAuth credential provider name registered in AgentCore
        scopes: List of OAuth scopes to request
        callback_url: OAuth callback URL for redirects
    """

    def __init__(
        self,
        provider_name: str,
        scopes: List[str],
        callback_url: Optional[str] = None,
        region: Optional[str] = None,
    ):
        """Initialize OAuth helper.

        Args:
            provider_name: OAuth credential provider name (e.g., "google-oauth-provider")
            scopes: List of OAuth scopes to request
            callback_url: OAuth callback URL (loaded from env/SSM if not provided)
            region: AWS region (defaults to AWS_REGION env var or us-west-2)
        """
        self.provider_name = provider_name
        self.scopes = scopes
        self.region = region or os.environ.get("AWS_REGION", "us-west-2")

        # Load callback URL if not provided
        if callback_url:
            self.callback_url = callback_url
        else:
            self.callback_url = get_oauth_callback_url()

        # Create IdentityClient once (boto3 client creation is expensive)
        self._identity_client = IdentityClient(self.region)

        logger.info(f"[OAuth] Initialized helper for provider: {provider_name}")
        logger.info(f"[OAuth] Scopes: {scopes}")
        logger.info(f"[OAuth] Callback URL: {self.callback_url}")

    async def get_access_token(self) -> str:
        """Get OAuth access token from AgentCore Token Vault.

        This method bypasses the @requires_access_token decorator and directly
        calls the Identity API. This approach:
        1. Avoids SDK polling mechanism that blocks for up to 10 minutes
        2. Returns auth URL to client immediately when consent is needed
        3. Solves the N+1 token request problem

        Returns:
            str: OAuth2 access token

        Raises:
            OAuthRequiredException: When user consent is required (contains auth URL)
            ValueError: When WorkloadAccessToken is not set in context
            RuntimeError: When Identity service returns unexpected response
        """
        # Get workload access token from context (set by AgentCoreContextMiddleware)
        workload_token = BedrockAgentCoreContext.get_workload_access_token()
        if not workload_token:
            raise ValueError(
                "WorkloadAccessToken not set in context. "
                "Ensure AgentCoreContextMiddleware is added to the app."
            )

        # Direct API call to get OAuth2 token
        try:
            response = self._identity_client.dp_client.get_resource_oauth2_token(
                resourceCredentialProviderName=self.provider_name,
                scopes=self.scopes,
                oauth2Flow="USER_FEDERATION",
                workloadIdentityToken=workload_token,
                resourceOauth2ReturnUrl=self.callback_url,
            )
        except Exception as e:
            logger.error(f"[OAuth] Failed to get token from Identity service: {e}")
            raise

        # Token cached in Token Vault? Return it directly
        if "accessToken" in response:
            logger.debug("[OAuth] Token retrieved from Token Vault (cache hit)")
            return response["accessToken"]

        # Need user consent? Raise exception with auth URL
        if "authorizationUrl" in response:
            auth_url = response["authorizationUrl"]
            logger.warning("[OAuth] User consent required - returning auth URL to client")
            raise OAuthRequiredException(auth_url)

        # Unexpected response
        raise RuntimeError(
            f"Identity service returned neither accessToken nor authorizationUrl. "
            f"Response: {response}"
        )
