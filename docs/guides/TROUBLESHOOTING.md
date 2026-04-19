# Troubleshooting Guide

## Local Development

### Backend Not Starting

**Symptoms:**
- AgentCore container starts but immediately shuts down
- OpenTelemetry errors in logs

**Solution:**
Ensure environment variables are set in `.env`:

```bash
# OpenTelemetry (disable for local dev)
OTEL_METRICS_EXPORTER=none
OTEL_TRACES_EXPORTER=none
OTEL_LOGS_EXPORTER=none
```

### CORS Issues

**Symptoms:**
- Frontend shows "Backend disconnected"
- Browser console CORS errors

**Solution:**
The frontend BFF proxies requests to agentcore, so CORS is typically not an issue. If running agentcore directly, ensure the CORS configuration includes the frontend origin.

### Port Conflicts

**Symptoms:**
- "Port 3000 is in use" or "Port 8080 is in use"

**Solution:**
```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9

# Kill process on port 8080
lsof -ti:8080 | xargs kill -9
```

### Test Backend Connectivity

```bash
# Health check
curl http://localhost:8080/ping

# AG-UI warmup
curl -X POST -H "Content-Type: application/json" \
  -d '{"thread_id":"test","run_id":"test","state":{"action":"warmup"}}' \
  http://localhost:8080/invocations
```

## Cloud Deployment

### Container Build Failures

```bash
# Check CodeBuild logs
aws logs tail /aws/codebuild/agentcore-runtime-build --follow
```

### Runtime Execution Errors

```bash
# Check AgentCore Runtime logs (replace with actual ARN)
aws logs tail /aws/bedrock-agentcore/runtimes/YOUR_RUNTIME_ARN --follow
```

### Gateway Connection Issues

```bash
# Verify gateway deployment
aws bedrock-agentcore list-gateways --region us-west-2

# Check gateway targets
aws bedrock-agentcore list-gateway-targets \
  --gateway-id YOUR_GATEWAY_ID --region us-west-2
```

### Terraform State Issues

```bash
# Re-initialize backend
./infra/scripts/deploy.sh init

# Force unlock if state is locked
cd infra/environments/dev
terraform force-unlock LOCK-ID
```

### OAuth 3LO "redirect_uri_mismatch"

**Symptom:** Google OAuth returns `Error 400: redirect_uri_mismatch`

**Cause:** The OAuth credential provider's callback URL doesn't match what's registered in Google Cloud Console.

**Solution:**
1. Get the current callback URL:
   ```python
   import boto3
   client = boto3.client('bedrock-agentcore-control', region_name='us-west-2')
   resp = client.get_oauth2_credential_provider(name='google-oauth-provider')
   print(resp.get('callbackUrl'))
   ```
2. Register this URL in Google Cloud Console > Credentials > OAuth 2.0 Client > Authorized redirect URIs

This URL is stable unless the OAuth provider is deleted and recreated. The Terraform module uses `prevent_destroy` to avoid accidental recreation.

### CloudFront 403 or 502 Errors

**Symptom:** CloudFront returns 403 Forbidden or 502 Bad Gateway

**Check:**
1. ECS tasks are running: `aws ecs list-tasks --cluster CLUSTER_NAME`
2. ALB target group health: `aws elbv2 describe-target-health --target-group-arn ARN`
3. CloudFront → ALB prefix list is correct

## Architecture

- **AgentCore Runtime**: FastAPI with Strands Agents, port 8080
- **Frontend + BFF**: Next.js with TypeScript, port 3000
- **AI Models**: AWS Bedrock (Claude, Nova)
- **Communication**: Server-Sent Events (SSE) via AG-UI protocol

## Environment Variables

### AgentCore (.env)
```bash
OTEL_METRICS_EXPORTER=none
OTEL_TRACES_EXPORTER=none
OTEL_LOGS_EXPORTER=none
```

### Frontend
Environment variables are configured via `.env` or set by `start.sh`. Key variables:
- `NEXT_PUBLIC_AGENTCORE_LOCAL=true` — enables local mode
- `NEXT_PUBLIC_AGENTCORE_URL=http://localhost:8080` — local agentcore URL

## Development

- AgentCore Runtime runs on port 8080
- Frontend runs on port 3000
- API documentation: http://localhost:8080/docs
- Health check: http://localhost:8080/ping
