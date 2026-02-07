/**
 * MCP 3LO Runtime Stack
 * Deploys MCP Server with 3LO OAuth as AgentCore Runtime using CodeBuild pattern.
 * MCP Protocol - exposes Gmail (and future 3LO services) tools via AgentCore Runtime.
 */
import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
export interface Mcp3loRuntimeStackProps extends cdk.StackProps {
    projectName?: string;
    environment?: string;
    cognitoUserPoolId?: string;
    cognitoClientId?: string;
}
export declare class Mcp3loRuntimeStack extends cdk.Stack {
    readonly runtime: agentcore.CfnRuntime;
    readonly runtimeArn: string;
    constructor(scope: Construct, id: string, props?: Mcp3loRuntimeStackProps);
}
