#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Mcp3loRuntimeStack } from '../lib/mcp-3lo-runtime-stack';

const app = new cdk.App();

const projectName = process.env.PROJECT_NAME || 'strands-agent-chatbot';
const environment = process.env.ENVIRONMENT || 'dev';
const awsRegion = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-west-2';
const awsAccount = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID;

const cognitoUserPoolId = process.env.COGNITO_USER_POOL_ID || '';
const cognitoClientId = process.env.COGNITO_CLIENT_ID || '';

new Mcp3loRuntimeStack(app, 'Mcp3loRuntimeStack', {
  projectName,
  environment,
  cognitoUserPoolId,
  cognitoClientId,
  env: {
    account: awsAccount,
    region: awsRegion,
  },
  description: 'MCP 3LO Server Runtime on AWS Bedrock AgentCore',
});

app.synth();
