# Google OAuth Setup Guide

This guide walks through configuring Google OAuth for Gmail tool access via AgentCore 3LO (Three-Legged OAuth).

## Prerequisites

- Frontend + BFF deployed (CloudFront URL available)
- Cognito authentication stack deployed
- A Google Cloud project

## Step 1: Create Google OAuth Client

1. Go to [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **Create Credentials** > **OAuth client ID**
3. Select **Web application** as the application type
4. Give it a name (e.g., `Strands Agent Chatbot`)
5. Leave **Authorized redirect URIs** empty for now (you will add it in Step 4)
6. Click **Create**
7. Copy the **Client ID** and **Client Secret**

## Step 2: Enable Gmail API

1. Go to [Gmail API Library](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
2. Click **Enable**

## Step 3: Run the Deploy Script

From the repository root:

```bash
cd agent-blueprint
./deploy.sh
```

Select **Option 6** (AgentCore Runtime MCP - Gmail OAuth via 3LO) or **Option 7** (Full Stack).

When prompted, enter your Google OAuth Client ID and Client Secret:

```
Enter Google OAuth Client ID (or press Enter to skip): <your-client-id>
Enter Google OAuth Client Secret: <your-client-secret>
```

The script registers the credential provider with AgentCore and outputs a **callback URL**:

```
✓ Provider registered with callback URL: https://prod.us-west-2.agentcore.bedrock.aws.dev/...

IMPORTANT: Add the Callback URL as an Authorized redirect URI in Google Cloud Console:
  https://prod.us-west-2.agentcore.bedrock.aws.dev/...
```

## Step 4: Add Redirect URI to Google Cloud Console

1. Go back to [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials)
2. Click on the OAuth client you created in Step 1
3. Under **Authorized redirect URIs**, click **Add URI**
4. Paste the callback URL from the deploy script output
5. Click **Save**

## Step 5: Configure OAuth Consent Screen (If Not Done)

If your Google Cloud project hasn't configured the OAuth consent screen yet:

1. Go to [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
2. Select **External** user type (or **Internal** for Google Workspace)
3. Fill in the required fields (app name, user support email, developer contact)
4. Add the scope: `https://www.googleapis.com/auth/gmail.readonly`
5. Add test users if the app is in **Testing** status

## Verification

After deployment, open the chatbot and enable the Gmail tools (`search_emails`, `read_email`) from the tools dropdown. When you first use a Gmail tool, the agent will prompt you to authorize access via a Google sign-in popup.
