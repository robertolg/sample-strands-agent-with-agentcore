# New Gateway Tool Template

Use this template when adding a new Gateway tool to avoid naming confusion.

---

## 📋 Pre-flight Checklist

Before you start:
- [ ] Lambda function is deployed
- [ ] Lambda function ARN is available
- [ ] Tool functionality is tested independently
- [ ] Tool input/output schema is designed

---

## Step 1: Choose Names

Fill in the table below:

| Name Type | Format | Your Value | Example |
|-----------|--------|------------|---------|
| **Lambda Function** | N/A | `____________` | `google-maps` |
| **Target Name** (kebab-case) | `{name}` | `____________` | `search-places` |
| **Schema Name** (snake_case) ⭐ | `{name}` | `____________` | `search_places` |
| **Config ID** | `gateway_{schema_name}` | `gateway____________` | `gateway_search_places` |

**⭐ Schema Name is the KEY - remember it for the next steps!**

---

## Step 2: YAML Tool Definition

Create a YAML file in `infra/registry/definitions/mcp/`:

```yaml
# File: infra/registry/definitions/mcp/YOUR_TARGET_NAME.yaml

name: YOUR_TARGET_NAME           # ← From table above (kebab-case)
description: SHORT DESCRIPTION
display_name: Your Tool Name
tools:
  - name: YOUR_SCHEMA_NAME      # ← From table above (snake_case)
    description: DETAILED DESCRIPTION OF WHAT THIS TOOL DOES
    input_type: object
    input_description: PARAMETERS DESCRIPTION
    properties:
      - name: REQUIRED_PARAM
        type: string             # or integer, boolean, etc.
        description: PARAMETER DESCRIPTION
        required: true
      - name: OPTIONAL_PARAM
        type: string
        description: OPTIONAL PARAMETER DESCRIPTION
```

---

## Step 3: tools-config.json

```json
// File: chatbot-app/frontend/src/config/tools-config.json

{
  "gateway_targets": [
    // ... existing tools ...

    // Add your new tool here:
    {
      "id": "gateway_YOUR_SCHEMA_NAME",  // ← From table above
      "name": "Your Tool Display Name",
      "description": "User-friendly description of what this tool does",
      "category": "Productivity",  // or "Search", "Data", "Communication", etc.
      "isDynamic": false,
      "tools": [
        {
          "id": "gateway_YOUR_SCHEMA_NAME",  // Same as parent ID
          "name": "YOUR_SCHEMA_NAME",  // Just the schema name
          "description": "Brief tool description"
        }
      ]
      // Usage guidance for Claude lives in the skill's SKILL.md, not here.
    }
  ]
}
```

---

## Step 4: Deploy

```bash
# 1. Deploy Gateway via Terraform
./infra/scripts/deploy.sh apply -target=module.gateway

# 2. Restart agentcore (if running locally)
# Server will auto-reload tools-config.json

# 3. Test in Frontend
# - Navigate to tool settings
# - Enable your new tool
# - Test with a query that should trigger the tool
```

---

## Step 5: Verification

Run these checks:

### Check 1: Gateway Target Deployed
```bash
aws bedrock-agent-core list-gateway-targets \
  --gateway-identifier YOUR_GATEWAY_ID \
  --region us-west-2
```
**Expected**: Your target appears in the list

---

### Check 2: FilteredMCPClient Logs
```bash
# Start agentcore with your tool enabled
# Look for these log lines:
```
```
✅ Filtered 1 tools from 20 available
   Original tool names: ['YOUR_TARGET_NAME___YOUR_SCHEMA_NAME']
📝 Simplified tool name: YOUR_TARGET_NAME___YOUR_SCHEMA_NAME → YOUR_SCHEMA_NAME
   Simplified tool names: ['YOUR_SCHEMA_NAME']
```

---

### Check 3: Agent Invocation
Test with the actual agent:
```bash
cd tests
python3 << EOF
import asyncio
import sys
sys.path.insert(0, '../chatbot-app/agentcore/src')

from agent.gateway_mcp_client import FilteredMCPClient
from strands import Agent
# ... (similar to test-simplified-agent.py)
EOF
```

**Expected**:
- Tool called with simplified name: `YOUR_SCHEMA_NAME`
- Gateway receives full name: `YOUR_TARGET_NAME___YOUR_SCHEMA_NAME`
- Tool execution succeeds

---

## Troubleshooting

| Issue | Likely Cause | Fix |
|-------|--------------|-----|
| Tool doesn't appear in list | Wrong ID in config | Check `gateway_{schema_name}` matches YAML |
| "Tool not found" error | Name mismatch | Verify YAML `tools[].name` is correct |
| Tool appears but fails | Lambda error | Check Lambda logs in CloudWatch |
| Name not simplified | FilteredMCPClient issue | Check `list_tools_sync()` logs |

---

## Example: Complete Workflow

Let's add a "Get Stock Price" tool:

### Planning
| Name Type | Value |
|-----------|-------|
| Lambda Function | `finance` |
| Target Name | `get-stock-price` |
| Schema Name | `get_stock_price` ⭐ |
| Config ID | `gateway_get_stock_price` |

### YAML Definition (infra/registry/definitions/mcp/finance.yaml)
```yaml
name: get-stock-price
description: Get current stock price
display_name: Stock Price
tools:
  - name: get_stock_price
    description: Get current stock price for a given symbol
    input_type: object
    properties:
      - name: symbol
        type: string
        description: Stock ticker symbol (e.g., AAPL, MSFT)
        required: true
```

### tools-config.json
```json
{
  "id": "gateway_get_stock_price",
  "name": "Get Stock Price",
  "description": "Get real-time stock prices",
  "category": "Finance",
  "tools": [{
    "id": "gateway_get_stock_price",
    "name": "get_stock_price",
    "description": "Get current stock price"
  }]
}
```

### Expected Flow
```
User enables: "gateway_get_stock_price"
  ↓
FilteredMCPClient filters: "get-stock-price___get_stock_price" → "get_stock_price"
  ↓
Claude sees: "get_stock_price"
  ↓
Claude calls: "get_stock_price"
  ↓
call_tool_sync converts: "get_stock_price" → "get-stock-price___get_stock_price"
  ↓
Gateway executes: Lambda function with "get-stock-price___get_stock_price"
  ↓
Success! ✅
```

---

## Done!

- [ ] YAML definition added
- [ ] tools-config.json updated
- [ ] Deployed to AWS
- [ ] Tested in Frontend
- [ ] Documentation updated (if needed)

Keep this template for future tool additions!
