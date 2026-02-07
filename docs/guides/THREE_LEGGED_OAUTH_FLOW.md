# Three-Legged OAuth (3LO) Flow

This document describes how per-user OAuth authentication works for MCP tools (e.g., Gmail) via AgentCore Identity.

## Overview

3LO enables tools to access user-specific external services (Gmail, Calendar, etc.) by obtaining OAuth tokens on behalf of individual users. The flow involves three parties:

1. **User** — grants consent via Google sign-in
2. **AgentCore Identity** — manages token exchange and storage
3. **External Service** (Google) — issues access tokens

Once a user completes consent, the token is stored in **AgentCore Token Vault** so subsequent tool calls skip the consent step.

## Architecture

```
┌──────────┐     ┌──────────┐     ┌──────────────┐     ┌────────────┐
│ Frontend │     │   BFF    │     │  AgentCore   │     │  MCP 3LO   │
│ (Next.js)│     │ (Routes) │     │   Runtime    │     │  Server    │
└────┬─────┘     └────┬─────┘     └──────┬───────┘     └─────┬──────┘
     │                │                   │                    │
     │  1. Chat msg   │                   │                    │
     │  + auth_token  │                   │                    │
     │───────────────>│  2. /invocations  │                    │
     │                │  + Bearer JWT     │                    │
     │                │──────────────────>│  3. MCP call       │
     │                │                   │  + WorkloadToken   │
     │                │                   │───────────────────>│
     │                │                   │                    │
     │                │                   │                    │ 4. get_resource_
     │                │                   │               ┌────│    oauth2_token()
     │                │                   │               │    │
     │                │                   │               │ AgentCore
     │                │                   │               │ Identity
     │                │                   │               │    │
     │                │                   │    5a. Token  └───>│
     │                │                   │    (cache hit)     │
     │                │                   │<───────────────────│
     │                │                   │                    │
     │                │    OR             │                    │
     │                │                   │    5b. auth_url    │
     │                │                   │    (no token)      │
     │                │                   │<───────────────────│
     │                │   tool_result:    │                    │
     │   SSE event    │   oauth_required  │                    │
     │<───────────────│<──────────────────│                    │
     │                │                   │                    │
     │  6. Open popup │                   │                    │
     │  ┌──────────┐  │                   │                    │
     │  │ Google   │  │                   │                    │
     │  │ Consent  │  │                   │                    │
     │  └────┬─────┘  │                   │                    │
     │       │        │                   │                    │
     │  7. Redirect to /oauth-complete?session_id=xxx         │
     │       │        │                   │                    │
     │  8. POST /api/oauth/complete       │                    │
     │───────────────>│  9. CompleteResourceTokenAuth          │
     │                │──────────────────>│                    │
     │                │                   │ (token stored in   │
     │                │                   │  Token Vault)      │
     │                │                   │                    │
     │  10. User retries tool manually    │                    │
     │───────────────>│──────────────────>│───────────────────>│
     │                │                   │    Token found!    │
     │   Gmail data   │   Gmail data      │    Gmail data      │
     │<───────────────│<──────────────────│<───────────────────│
```

## Step-by-Step Flow

### Step 1-3: Initial Tool Request

The frontend sends a chat message with the Cognito JWT as `auth_token`. The BFF forwards this to the AgentCore Runtime, which invokes the MCP 3LO server. The Runtime injects a `WorkloadAccessToken` header derived from the JWT.

**Key files:**
- `chatbot-app/frontend/src/app/api/stream/chat/route.ts` — extracts JWT, passes as `authToken`
- `chatbot-app/agentcore/src/agent/mcp/mcp_runtime_client.py` — sets `Authorization: Bearer {jwt}` header
- `agent-blueprint/agentcore-runtime-mcp-stack/src/agentcore_context_middleware.py` — extracts `WorkloadAccessToken` into context

### Step 4-5: Token Lookup

The MCP server's `OAuthHelper.get_access_token()` calls `get_resource_oauth2_token()` with:

| Parameter | Value | Source |
|-----------|-------|--------|
| `resourceCredentialProviderName` | `"google-oauth-provider"` | Registered during deploy |
| `scopes` | Gmail scopes | Hardcoded in server |
| `oauth2Flow` | `"USER_FEDERATION"` | Per-user tokens |
| `workloadIdentityToken` | Derived from Cognito JWT | `WorkloadAccessToken` header |
| `resourceOauth2ReturnUrl` | `https://{cloudfront}/oauth-complete` | SSM parameter |

**Two possible outcomes:**
- **Cache hit** — `accessToken` returned, tool proceeds normally
- **Cache miss** — `authorizationUrl` returned, `OAuthRequiredException` raised

**Key file:** `agent-blueprint/agentcore-runtime-mcp-stack/src/agentcore_oauth.py:214-267`

### Step 6: OAuth Popup

The tool result containing `oauth_required: true` and `auth_url` is streamed back to the frontend. The `ToolExecutionContainer` component detects the Google authorization URL pattern and opens a popup window automatically.

**Key file:** `chatbot-app/frontend/src/components/chat/ToolExecutionContainer.tsx:98-125`

### Step 7: Google Consent

The user signs in to Google and grants permissions in the popup. Google redirects the popup to:

```
https://{cloudfront}/oauth-complete?session_id={agentcore_session_id}
```

### Step 8-9: Token Completion

The `/oauth-complete` page extracts the `session_id` and calls the BFF endpoint, which invokes `CompleteResourceTokenAuthCommand`:

```typescript
const command = new CompleteResourceTokenAuthCommand({
  sessionUri: session_id,
  userIdentifier: { userToken: cognitoJwt }  // or { userId }
})
```

This tells AgentCore Identity to finalize the OAuth exchange and store the token in the Token Vault.

**Key files:**
- `chatbot-app/frontend/src/app/oauth-complete/page.tsx` — callback page
- `chatbot-app/frontend/src/app/api/oauth/complete/route.ts` — BFF endpoint

### Step 10: Retry

The user manually retries the tool (the instructions say "try this action again"). This time, `get_resource_oauth2_token()` returns a cached `accessToken` and the tool executes successfully.

## Token Persistence

### How Token Vault Identifies Users

The Token Vault associates stored OAuth tokens with a user identity. Two identifiers are used at different points in the flow:

| Phase | Identifier | Value |
|-------|-----------|-------|
| **Token request** (MCP server) | `workloadIdentityToken` | Derived from Cognito JWT by AgentCore Runtime |
| **Token completion** (BFF) | `userIdentifier.userToken` | Raw Cognito JWT from frontend |

AgentCore Identity extracts the `sub` (subject) claim from the JWT to identify the user. As long as the user's Cognito identity remains the same, the token should persist across sessions.

### Token Expiry

Google OAuth access tokens expire after 1 hour. AgentCore Identity handles refresh tokens internally — when the stored access token expires, it uses the refresh token to obtain a new one without requiring user consent again.

If the refresh token itself is revoked (e.g., user revokes access in Google Account settings), the next tool call will trigger a new consent flow.

### Known Behavior: Re-consent Between Sessions

Users may experience repeated OAuth consent prompts when:

1. **Cognito JWT expiry** — If the Cognito session expires and the user re-authenticates, the new JWT has a different `jti` (JWT ID). If AgentCore Identity matches tokens by the full JWT rather than just the `sub` claim, the stored OAuth token won't be found.

2. **Google OAuth app in "Testing" status** — Google limits test apps to 7-day refresh token lifetime. After 7 days, consent is required again. To fix this, publish the OAuth app or add the user as a test user.

3. **Scope changes** — If the MCP server's requested scopes change between deployments, the existing token may not cover the new scopes, triggering re-consent.

4. **Token Vault TTL** — AgentCore Token Vault may have a TTL policy on stored tokens. If tokens expire in the vault, re-consent is needed.

### Verifying Token Status

Check if a credential provider exists and view its configuration:

```python
import boto3
client = boto3.client('bedrock-agentcore-control', region_name='us-west-2')
response = client.get_oauth2_credential_provider(name='google-oauth-provider')
print(response)
```

## File Reference

| File | Role |
|------|------|
| `agentcore-runtime-mcp-stack/src/gmail_mcp_server.py` | MCP server with Gmail tools |
| `agentcore-runtime-mcp-stack/src/agentcore_oauth.py` | Token retrieval and auth URL generation |
| `agentcore-runtime-mcp-stack/src/agentcore_context_middleware.py` | Header extraction middleware |
| `frontend/src/components/chat/ToolExecutionContainer.tsx` | Auto-opens OAuth popup |
| `frontend/src/app/oauth-complete/page.tsx` | Handles Google redirect callback |
| `frontend/src/app/api/oauth/complete/route.ts` | Calls CompleteResourceTokenAuth |
| `agentcore/src/agent/mcp/mcp_runtime_client.py` | MCP Runtime client with JWT auth |
| `agentcore-runtime-mcp-stack/deploy.sh` | Registers OAuth credential provider |
