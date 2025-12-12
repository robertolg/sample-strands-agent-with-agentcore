# AgentCore Gateway Stack

AWS Bedrock AgentCore Gateway with Lambda-based MCP tools for research and analysis.

## 📋 Overview

This stack deploys an AgentCore Gateway that provides 12 research tools through 5 Lambda functions:

| Category | Tools | Lambda Function |
|----------|-------|----------------|
| **Web Search** | tavily_search, tavily_extract | mcp-tavily |
| **Encyclopedia** | wikipedia_search, wikipedia_get_article | mcp-wikipedia |
| **Academic** | arxiv_search, arxiv_get_paper | mcp-arxiv |
| **Search Engine** | google_web_search, google_image_search | mcp-google-search |
| **Finance** | stock_quote, stock_history, financial_news, stock_analysis | mcp-finance |

## 🏗️ Architecture

```
AgentCore Runtime (with SigV4)
           ↓
    AgentCore Gateway (AWS_IAM auth)
           ↓
    ┌──────┴───────┬────────┬─────────┬─────────┐
    ↓              ↓        ↓         ↓         ↓
  Tavily      Wikipedia  ArXiv    Google    Finance
  Lambda       Lambda    Lambda   Lambda    Lambda
    (2)          (2)       (2)      (2)       (4)
```

## 🚀 Quick Start

### Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 18+ (for CDK)
- Python 3.13+ (for Lambda functions)
- Docker (optional, for local testing)

### Deploy

```bash
# Navigate to gateway stack directory
cd agent-blueprint/agentcore-gateway-stack

# Deploy everything
./scripts/deploy.sh
```

This script will:
1. Build all Lambda function packages
2. Install CDK dependencies
3. Synthesize CDK stacks
4. Deploy to AWS

### Set API Keys

After deployment, configure required API keys:

```bash
# Tavily API Key (required for tavily-search, tavily-extract)
aws secretsmanager put-secret-value \
  --secret-id strands-agent-chatbot/mcp/tavily-api-key \
  --secret-string "YOUR_TAVILY_API_KEY"

# Google Credentials (required for google-web-search, google-image-search)
aws secretsmanager put-secret-value \
  --secret-id strands-agent-chatbot/mcp/google-credentials \
  --secret-string '{"api_key":"YOUR_API_KEY","search_engine_id":"YOUR_ENGINE_ID"}'
```

### Test Gateway

```bash
./scripts/test-gateway.sh
```

## 📁 Project Structure

```
agentcore-gateway-stack/
├── infrastructure/           # CDK TypeScript code
│   ├── bin/
│   │   └── gateway-stack.ts # CDK app entry point
│   ├── lib/
│   │   ├── iam-stack.ts    # IAM roles and secrets
│   │   ├── gateway-stack.ts # AgentCore Gateway
│   │   ├── lambda-stack.ts  # Lambda functions
│   │   └── gateway-target-stack.ts # Gateway targets
│   ├── package.json
│   ├── tsconfig.json
│   └── cdk.json
├── lambda-functions/        # Lambda source code
│   ├── tavily/
│   ├── wikipedia/
│   ├── arxiv/
│   ├── google-search/
│   └── finance/
├── scripts/
│   ├── build-lambdas.sh    # Build Lambda packages
│   ├── deploy.sh           # Full deployment
│   ├── test-gateway.sh     # Test connectivity
│   └── destroy.sh          # Clean up resources
└── README.md
```

## 🔧 Configuration

### Environment Variables

Set these before deployment:

```bash
export PROJECT_NAME="strands-agent-chatbot"  # Default
export ENVIRONMENT="dev"                      # dev or prod
export AWS_REGION="us-west-2"                # AWS region
```

### Lambda Function Timeout and Memory

Edit `infrastructure/lib/lambda-stack.ts` to adjust:

```typescript
const lambdaConfigs = [
  {
    id: 'tavily',
    timeout: 300,      // seconds
    memorySize: 1024,  // MB
    // ...
  }
]
```

## 🧪 Testing

### Test Individual Lambda Function

```bash
aws lambda invoke \
  --function-name mcp-tavily \
  --payload '{"query":"AWS Lambda"}' \
  response.json

cat response.json
```

### Test Gateway Connectivity

```bash
./scripts/test-gateway.sh
```

### List Available Tools

```bash
aws bedrock-agentcore list-gateway-targets \
  --gateway-identifier <GATEWAY_ID> \
  --region us-west-2
```

## 🔌 Integration with AgentCore Runtime

### Update Runtime Stack

Add Gateway URL to Runtime environment:

```typescript
// agentcore-runtime-stack.ts
const runtime = new agentcore.CfnRuntime(this, 'AgentCoreRuntime', {
  // ... existing config ...

  environmentVariables: {
    // ... existing vars ...

    GATEWAY_URL: ssm.StringParameter.valueForStringParameter(
      this,
      `/${projectName}/${environment}/mcp/gateway-url`
    ),
  },
})
```

### Add Gateway Invoke Permissions

```typescript
executionRole.addToPolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['bedrock-agentcore:InvokeGateway'],
    resources: [
      `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
    ],
  })
)
```

### Use Gateway in Agent Code

```python
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
import requests
import json
import os

class GatewayClient:
    def __init__(self):
        self.gateway_url = os.getenv('GATEWAY_URL')
        self.region = os.getenv('AWS_REGION', 'us-west-2')
        self.session = boto3.Session()
        self.credentials = self.session.get_credentials()

    def invoke_tool(self, tool_name: str, arguments: dict) -> dict:
        """Invoke Gateway tool with SigV4 authentication"""
        url = f"{self.gateway_url}/invoke"

        payload = {
            'tool': tool_name,
            'arguments': arguments
        }

        # Create signed request
        request = AWSRequest(
            method='POST',
            url=url,
            data=json.dumps(payload),
            headers={'Content-Type': 'application/json'}
        )

        SigV4Auth(
            self.credentials,
            'bedrock-agentcore',
            self.region
        ).add_auth(request)

        # Send request
        response = requests.post(
            url,
            headers=dict(request.headers),
            data=request.body
        )

        response.raise_for_status()
        return response.json()

# Usage example
client = GatewayClient()
result = client.invoke_tool('tavily_search', {
    'query': 'AWS Lambda best practices'
})
print(result)
```

## 📊 Cost Estimate

### Monthly Cost (Approximate)

| Service | Usage | Cost |
|---------|-------|------|
| Lambda Invocations | 10,000 requests | $0.20 |
| Lambda Duration | ARM64, avg 5s | $0.83 |
| AgentCore Gateway | Active | $0.00* |
| Secrets Manager | 2 secrets | $0.80 |
| CloudWatch Logs | 1 GB | $0.50 |
| **Total** | | **~$2.33/month** |

*AgentCore Gateway is currently in preview and may incur charges after GA.

## 🗑️ Cleanup

To remove all resources:

```bash
./scripts/destroy.sh
```

This will delete:
- All Lambda functions
- AgentCore Gateway and targets
- IAM roles and policies
- CloudWatch log groups
- Secrets Manager secrets

## 🐛 Troubleshooting

### Lambda Function Fails to Deploy

**Error**: `Unable to find build.zip`

**Solution**: Run build script first:
```bash
./scripts/build-lambdas.sh
```

### Gateway Connection Failed

**Error**: `Unable to connect to Gateway`

**Solution**: Check Gateway status:
```bash
aws bedrock-agentcore get-gateway \
  --gateway-identifier <GATEWAY_ID> \
  --region us-west-2
```

### API Key Not Working

**Error**: `Failed to get API key from Secrets Manager`

**Solution**: Verify secret exists and Lambda role has permissions:
```bash
aws secretsmanager describe-secret \
  --secret-id strands-agent-chatbot/mcp/tavily-api-key
```

### CDK Deploy Fails

**Error**: `CDK version mismatch`

**Solution**: Install specific CDK version:
```bash
cd infrastructure
npm install aws-cdk@2.167.1
```

## 🤝 Contributing

Contributions are welcome! Please follow the existing code structure and patterns.

## 📄 License

See main project LICENSE file.
