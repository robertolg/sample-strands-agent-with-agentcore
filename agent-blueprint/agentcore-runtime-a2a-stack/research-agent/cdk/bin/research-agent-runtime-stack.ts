#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ResearchAgentRuntimeStack } from '../lib/research-agent-runtime-stack';

const app = new cdk.App();

const projectName = process.env.PROJECT_NAME || 'strands-agent-chatbot';
const environment = process.env.ENVIRONMENT || 'dev';
const awsRegion = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-west-2';
const awsAccount = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID;

new ResearchAgentRuntimeStack(app, 'ResearchAgentRuntimeStack', {
  projectName,
  environment,
  env: {
    account: awsAccount,
    region: awsRegion,
  },
  description: 'Research Agent A2A Runtime on AWS Bedrock AgentCore',
});

app.synth();
