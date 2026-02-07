"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Mcp3loRuntimeStack = void 0;
/**
 * MCP 3LO Runtime Stack
 * Deploys MCP Server with 3LO OAuth as AgentCore Runtime using CodeBuild pattern.
 * MCP Protocol - exposes Gmail (and future 3LO services) tools via AgentCore Runtime.
 */
const cdk = require("aws-cdk-lib");
const agentcore = require("aws-cdk-lib/aws-bedrockagentcore");
const ecr = require("aws-cdk-lib/aws-ecr");
const iam = require("aws-cdk-lib/aws-iam");
const ssm = require("aws-cdk-lib/aws-ssm");
const s3 = require("aws-cdk-lib/aws-s3");
const s3deploy = require("aws-cdk-lib/aws-s3-deployment");
const codebuild = require("aws-cdk-lib/aws-codebuild");
const cr = require("aws-cdk-lib/custom-resources");
const lambda = require("aws-cdk-lib/aws-lambda");
class Mcp3loRuntimeStack extends cdk.Stack {
    runtime;
    runtimeArn;
    constructor(scope, id, props) {
        super(scope, id, props);
        const projectName = props?.projectName || 'strands-agent-chatbot';
        const environment = props?.environment || 'dev';
        // Unique build tag to force Runtime to pull new image on each deployment
        const buildTag = Date.now().toString();
        // Cognito configuration for JWT inbound auth (required for 3LO user identity)
        const cognitoUserPoolId = props?.cognitoUserPoolId || process.env.COGNITO_USER_POOL_ID || '';
        const cognitoClientId = props?.cognitoClientId || process.env.COGNITO_CLIENT_ID || '';
        // ============================================================
        // Step 1: ECR Repository
        // ============================================================
        const useExistingEcr = process.env.USE_EXISTING_ECR === 'true';
        const repository = useExistingEcr
            ? ecr.Repository.fromRepositoryName(this, 'Mcp3loRepository', `${projectName}-mcp-3lo-server`)
            : new ecr.Repository(this, 'Mcp3loRepository', {
                repositoryName: `${projectName}-mcp-3lo-server`,
                removalPolicy: cdk.RemovalPolicy.RETAIN,
                imageScanOnPush: true,
                lifecycleRules: [
                    {
                        description: 'Keep last 10 images',
                        maxImageCount: 10,
                    },
                ],
            });
        // ============================================================
        // Step 2: IAM Execution Role for AgentCore Runtime
        // ============================================================
        const executionRole = new iam.Role(this, 'Mcp3loExecutionRole', {
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
            description: 'Execution role for MCP 3LO Server AgentCore Runtime',
        });
        // ECR Access
        executionRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ECRImageAccess',
            effect: iam.Effect.ALLOW,
            actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:GetAuthorizationToken'],
            resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/*`, '*'],
        }));
        // CloudWatch Logs
        executionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogStreams',
                'logs:DescribeLogGroups',
            ],
            resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
            ],
        }));
        // X-Ray and CloudWatch Metrics
        executionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'xray:PutTraceSegments',
                'xray:PutTelemetryRecords',
                'cloudwatch:PutMetricData',
            ],
            resources: ['*'],
        }));
        // OAuth outbound auth permissions
        executionRole.addToPolicy(new iam.PolicyStatement({
            sid: 'OAuthIdentityAccess',
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock-agentcore:GetResourceOauth2Token',
                'bedrock-agentcore:CreateWorkloadIdentity',
                'bedrock-agentcore:GetWorkloadAccessToken',
                'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
            ],
            resources: ['*'],
        }));
        // Secrets Manager (for OAuth credential provider secrets)
        executionRole.addToPolicy(new iam.PolicyStatement({
            sid: 'SecretsManagerAccess',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: [
                `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
            ],
        }));
        // Parameter Store (for configuration)
        executionRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter', 'ssm:GetParameters'],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter/${projectName}/*`,
            ],
        }));
        // ============================================================
        // Step 3: S3 Bucket for CodeBuild Source
        // ============================================================
        const sourceBucket = new s3.Bucket(this, 'Mcp3loSourceBucket', {
            bucketName: `${projectName}-mcp3lo-src-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [
                {
                    expiration: cdk.Duration.days(7),
                    id: 'DeleteOldSources',
                },
            ],
        });
        // ============================================================
        // Step 4: CodeBuild Project
        // ============================================================
        const codeBuildRole = new iam.Role(this, 'Mcp3loCodeBuildRole', {
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
            description: 'Build role for MCP 3LO Server container',
        });
        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ecr:GetAuthorizationToken',
                'ecr:BatchCheckLayerAvailability',
                'ecr:BatchGetImage',
                'ecr:GetDownloadUrlForLayer',
                'ecr:PutImage',
                'ecr:InitiateLayerUpload',
                'ecr:UploadLayerPart',
                'ecr:CompleteLayerUpload',
            ],
            resources: [
                '*',
                `arn:aws:ecr:${this.region}:${this.account}:repository/${repository.repositoryName}`,
            ],
        }));
        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/${projectName}-*`,
            ],
        }));
        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
            resources: [sourceBucket.bucketArn, `${sourceBucket.bucketArn}/*`],
        }));
        const buildProject = new codebuild.Project(this, 'Mcp3loBuildProject', {
            projectName: `${projectName}-mcp-3lo-builder`,
            description: 'Builds ARM64 container image for MCP 3LO Server Runtime',
            role: codeBuildRole,
            environment: {
                buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_ARM_3,
                computeType: codebuild.ComputeType.SMALL,
                privileged: true,
            },
            source: codebuild.Source.s3({
                bucket: sourceBucket,
                path: 'mcp-3lo-source/',
            }),
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    pre_build: {
                        commands: [
                            'echo Logging in to Amazon ECR...',
                            `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
                        ],
                    },
                    build: {
                        commands: [
                            'echo Building MCP 3LO Server Docker image for ARM64...',
                            'docker build --platform linux/arm64 -t mcp-3lo-server:latest .',
                            `docker tag mcp-3lo-server:latest ${repository.repositoryUri}:latest`,
                        ],
                    },
                    post_build: {
                        commands: [
                            'echo Pushing Docker image to ECR...',
                            `docker push ${repository.repositoryUri}:latest`,
                            'echo Build completed successfully',
                        ],
                    },
                },
            }),
        });
        // ============================================================
        // Step 5: Upload Source to S3
        // ============================================================
        const agentSourcePath = '..';
        const agentSourceUpload = new s3deploy.BucketDeployment(this, 'Mcp3loSourceUpload', {
            sources: [
                s3deploy.Source.asset(agentSourcePath, {
                    exclude: [
                        'venv/**',
                        '.venv/**',
                        '__pycache__/**',
                        '*.pyc',
                        '.git/**',
                        'node_modules/**',
                        '.DS_Store',
                        '*.log',
                        'cdk/**',
                        'cdk.out/**',
                    ],
                }),
            ],
            destinationBucket: sourceBucket,
            destinationKeyPrefix: 'mcp-3lo-source/',
            prune: false,
            retainOnDelete: false,
        });
        // ============================================================
        // Step 6: Trigger CodeBuild
        // ============================================================
        const buildTrigger = new cr.AwsCustomResource(this, 'TriggerMcp3loCodeBuild', {
            onCreate: {
                service: 'CodeBuild',
                action: 'startBuild',
                parameters: {
                    projectName: buildProject.projectName,
                },
                physicalResourceId: cr.PhysicalResourceId.of(`mcp-3lo-build-${Date.now()}`),
            },
            onUpdate: {
                service: 'CodeBuild',
                action: 'startBuild',
                parameters: {
                    projectName: buildProject.projectName,
                },
                physicalResourceId: cr.PhysicalResourceId.of(`mcp-3lo-build-${Date.now()}`),
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
                    resources: [buildProject.projectArn],
                }),
            ]),
            timeout: cdk.Duration.minutes(5),
        });
        buildTrigger.node.addDependency(agentSourceUpload);
        // ============================================================
        // Step 7: Wait for Build Completion
        // ============================================================
        const buildWaiterFunction = new lambda.Function(this, 'Mcp3loBuildWaiter', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
const { CodeBuildClient, BatchGetBuildsCommand } = require('@aws-sdk/client-codebuild');

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event));

  if (event.RequestType === 'Delete') {
    return sendResponse(event, 'SUCCESS', { Status: 'DELETED' });
  }

  const buildId = event.ResourceProperties.BuildId;
  const maxWaitMinutes = 14;
  const pollIntervalSeconds = 30;

  console.log('Waiting for build:', buildId);

  const client = new CodeBuildClient({});
  const startTime = Date.now();
  const maxWaitMs = maxWaitMinutes * 60 * 1000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await client.send(new BatchGetBuildsCommand({ ids: [buildId] }));
      const build = response.builds[0];
      const status = build.buildStatus;

      console.log(\`Build status: \${status}\`);

      if (status === 'SUCCEEDED') {
        return await sendResponse(event, 'SUCCESS', { Status: 'SUCCEEDED' });
      } else if (['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'].includes(status)) {
        return await sendResponse(event, 'FAILED', {}, \`Build failed with status: \${status}\`);
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalSeconds * 1000));

    } catch (error) {
      console.error('Error:', error);
      return await sendResponse(event, 'FAILED', {}, error.message);
    }
  }

  return await sendResponse(event, 'FAILED', {}, \`Build timeout after \${maxWaitMinutes} minutes\`);
};

async function sendResponse(event, status, data, reason) {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: reason || \`See CloudWatch Log Stream: \${event.LogStreamName}\`,
    PhysicalResourceId: event.PhysicalResourceId || event.RequestId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data
  });

  console.log('Response:', responseBody);

  const https = require('https');
  const url = require('url');
  const parsedUrl = url.parse(event.ResponseURL);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.path,
      method: 'PUT',
      headers: {
        'Content-Type': '',
        'Content-Length': responseBody.length
      }
    };

    const request = https.request(options, (response) => {
      console.log(\`Status: \${response.statusCode}\`);
      resolve(data);
    });

    request.on('error', (error) => {
      console.error('Error:', error);
      reject(error);
    });

    request.write(responseBody);
    request.end();
  });
}
      `),
            timeout: cdk.Duration.minutes(15),
            memorySize: 256,
        });
        buildWaiterFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:BatchGetBuilds'],
            resources: [buildProject.projectArn],
        }));
        const buildWaiter = new cdk.CustomResource(this, 'Mcp3loBuildWaiterResource', {
            serviceToken: buildWaiterFunction.functionArn,
            properties: {
                BuildId: buildTrigger.getResponseField('build.id'),
            },
        });
        buildWaiter.node.addDependency(buildTrigger);
        // ============================================================
        // Step 8: Create AgentCore Runtime (MCP Protocol)
        // ============================================================
        const runtimeName = projectName.replace(/-/g, '_') + '_mcp_3lo_runtime';
        const runtime = new agentcore.CfnRuntime(this, 'Mcp3loRuntime', {
            agentRuntimeName: runtimeName,
            description: 'MCP 3LO Server Runtime - Gmail and external OAuth service tools',
            roleArn: executionRole.roleArn,
            agentRuntimeArtifact: {
                containerConfiguration: {
                    containerUri: `${repository.repositoryUri}:latest`,
                },
            },
            networkConfiguration: {
                networkMode: 'PUBLIC',
            },
            protocolConfiguration: 'MCP',
            // JWT inbound auth - Cognito validates user identity for 3LO OAuth flows
            // Note: Only allowedAudience is used (validates 'aud' claim in id_token)
            // allowedClients is NOT used because Cognito id_token doesn't have 'client_id' claim
            ...(cognitoUserPoolId && cognitoClientId ? {
                authorizerConfiguration: {
                    customJwtAuthorizer: {
                        discoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${cognitoUserPoolId}/.well-known/openid-configuration`,
                        allowedAudience: [cognitoClientId],
                    },
                },
            } : {}),
            environmentVariables: {
                LOG_LEVEL: 'INFO',
                PROJECT_NAME: projectName,
                ENVIRONMENT: environment,
                AWS_DEFAULT_REGION: this.region,
                AWS_REGION: this.region,
                OTEL_PYTHON_DISABLED_INSTRUMENTATIONS: 'boto,botocore',
                // Build timestamp to force Runtime update on each deployment
                BUILD_TIMESTAMP: new Date().toISOString(),
            },
            tags: {
                Environment: environment,
                Application: `${projectName}-mcp-3lo-server`,
                Type: 'MCP-3LO-Server',
            },
        });
        runtime.node.addDependency(executionRole);
        runtime.node.addDependency(buildWaiter);
        this.runtime = runtime;
        this.runtimeArn = runtime.attrAgentRuntimeArn;
        // ============================================================
        // Step 9: Store Runtime Information in Parameter Store
        // ============================================================
        new ssm.StringParameter(this, 'Mcp3loRuntimeArnParameter', {
            parameterName: `/${projectName}/${environment}/mcp/mcp-3lo-runtime-arn`,
            stringValue: runtime.attrAgentRuntimeArn,
            description: 'MCP 3LO Server AgentCore Runtime ARN',
            tier: ssm.ParameterTier.STANDARD,
        });
        new ssm.StringParameter(this, 'Mcp3loRuntimeIdParameter', {
            parameterName: `/${projectName}/${environment}/mcp/mcp-3lo-runtime-id`,
            stringValue: runtime.attrAgentRuntimeId,
            description: 'MCP 3LO Server AgentCore Runtime ID',
            tier: ssm.ParameterTier.STANDARD,
        });
        // ============================================================
        // Outputs
        // ============================================================
        new cdk.CfnOutput(this, 'RepositoryUri', {
            value: repository.repositoryUri,
            description: 'ECR Repository URI for MCP 3LO Server container',
            exportName: `${projectName}-mcp-3lo-repo-uri`,
        });
        new cdk.CfnOutput(this, 'RuntimeArn', {
            value: runtime.attrAgentRuntimeArn,
            description: 'MCP 3LO Server AgentCore Runtime ARN',
            exportName: `${projectName}-mcp-3lo-runtime-arn`,
        });
        new cdk.CfnOutput(this, 'RuntimeId', {
            value: runtime.attrAgentRuntimeId,
            description: 'MCP 3LO Server AgentCore Runtime ID',
            exportName: `${projectName}-mcp-3lo-runtime-id`,
        });
        new cdk.CfnOutput(this, 'ParameterStorePrefix', {
            value: `/${projectName}/${environment}/mcp`,
            description: 'Parameter Store prefix for MCP 3LO Server configuration',
        });
    }
}
exports.Mcp3loRuntimeStack = Mcp3loRuntimeStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLTNsby1ydW50aW1lLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWNwLTNsby1ydW50aW1lLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBOzs7O0dBSUc7QUFDSCxtQ0FBa0M7QUFDbEMsOERBQTZEO0FBQzdELDJDQUEwQztBQUMxQywyQ0FBMEM7QUFDMUMsMkNBQTBDO0FBQzFDLHlDQUF3QztBQUN4QywwREFBeUQ7QUFDekQsdURBQXNEO0FBQ3RELG1EQUFrRDtBQUNsRCxpREFBZ0Q7QUFVaEQsTUFBYSxrQkFBbUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMvQixPQUFPLENBQXNCO0lBQzdCLFVBQVUsQ0FBUTtJQUVsQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQStCO1FBQ3ZFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFBO1FBRXZCLE1BQU0sV0FBVyxHQUFHLEtBQUssRUFBRSxXQUFXLElBQUksdUJBQXVCLENBQUE7UUFDakUsTUFBTSxXQUFXLEdBQUcsS0FBSyxFQUFFLFdBQVcsSUFBSSxLQUFLLENBQUE7UUFFL0MseUVBQXlFO1FBQ3pFLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxRQUFRLEVBQUUsQ0FBQTtRQUV0Qyw4RUFBOEU7UUFDOUUsTUFBTSxpQkFBaUIsR0FBRyxLQUFLLEVBQUUsaUJBQWlCLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxvQkFBb0IsSUFBSSxFQUFFLENBQUE7UUFDNUYsTUFBTSxlQUFlLEdBQUcsS0FBSyxFQUFFLGVBQWUsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLGlCQUFpQixJQUFJLEVBQUUsQ0FBQTtRQUVyRiwrREFBK0Q7UUFDL0QseUJBQXlCO1FBQ3pCLCtEQUErRDtRQUMvRCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixLQUFLLE1BQU0sQ0FBQTtRQUM5RCxN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MEJBQTBCLEVBQUU7WUFDeEQsYUFBYSxFQUFFLElBQUksV0FBVyxJQUFJLFdBQVcseUJBQXlCO1lBQ3RFLFdBQVcsRUFBRSxPQUFPLENBQUMsa0JBQWtCO1lBQ3ZDLFdBQVcsRUFBRSxxQ0FBcUM7WUFDbEQsSUFBSSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsUUFBUTtTQUNqQyxDQUFDLENBQUE7UUFFRiwrREFBK0Q7UUFDL0QsVUFBVTtRQUNWLCtEQUErRDtRQUMvRCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRTtZQUN2QyxLQUFLLEVBQUUsVUFBVSxDQUFDLGFBQWE7WUFDL0IsV0FBVyxFQUFFLGlEQUFpRDtZQUM5RCxVQUFVLEVBQUUsR0FBRyxXQUFXLG1CQUFtQjtTQUM5QyxDQUFDLENBQUE7UUFFRixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNwQyxLQUFLLEVBQUUsT0FBTyxDQUFDLG1CQUFtQjtZQUNsQyxXQUFXLEVBQUUsc0NBQXNDO1lBQ25ELFVBQVUsRUFBRSxHQUFHLFdBQVcsc0JBQXNCO1NBQ2pELENBQUMsQ0FBQTtRQUVGLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFO1lBQ25DLEtBQUssRUFBRSxPQUFPLENBQUMsa0JBQWtCO1lBQ2pDLFdBQVcsRUFBRSxxQ0FBcUM7WUFDbEQsVUFBVSxFQUFFLEdBQUcsV0FBVyxxQkFBcUI7U0FDaEQsQ0FBQyxDQUFBO1FBRUYsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxzQkFBc0IsRUFBRTtZQUM5QyxLQUFLLEVBQUUsSUFBSSxXQUFXLElBQUksV0FBVyxNQUFNO1lBQzNDLFdBQVcsRUFBRSx5REFBeUQ7U0FDdkUsQ0FBQyxDQUFBO0lBQ0osQ0FBQztDQUNGO0FBdGZELGdEQXNmQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogTUNQIDNMTyBSdW50aW1lIFN0YWNrXG4gKiBEZXBsb3lzIE1DUCBTZXJ2ZXIgd2l0aCAzTE8gT0F1dGggYXMgQWdlbnRDb3JlIFJ1bnRpbWUgdXNpbmcgQ29kZUJ1aWxkIHBhdHRlcm4uXG4gKiBNQ1AgUHJvdG9jb2wgLSBleHBvc2VzIEdtYWlsIChhbmQgZnV0dXJlIDNMTyBzZXJ2aWNlcykgdG9vbHMgdmlhIEFnZW50Q29yZSBSdW50aW1lLlxuICovXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInXG5pbXBvcnQgKiBhcyBhZ2VudGNvcmUgZnJvbSAnYXdzLWNkay1saWIvYXdzLWJlZHJvY2thZ2VudGNvcmUnXG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcidcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJ1xuaW1wb3J0ICogYXMgc3NtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zc20nXG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnXG5pbXBvcnQgKiBhcyBzM2RlcGxveSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMtZGVwbG95bWVudCdcbmltcG9ydCAqIGFzIGNvZGVidWlsZCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29kZWJ1aWxkJ1xuaW1wb3J0ICogYXMgY3IgZnJvbSAnYXdzLWNkay1saWIvY3VzdG9tLXJlc291cmNlcydcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJ1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cydcblxuZXhwb3J0IGludGVyZmFjZSBNY3AzbG9SdW50aW1lU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgcHJvamVjdE5hbWU/OiBzdHJpbmdcbiAgZW52aXJvbm1lbnQ/OiBzdHJpbmdcbiAgY29nbml0b1VzZXJQb29sSWQ/OiBzdHJpbmdcbiAgY29nbml0b0NsaWVudElkPzogc3RyaW5nXG59XG5cbmV4cG9ydCBjbGFzcyBNY3AzbG9SdW50aW1lU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgcnVudGltZTogYWdlbnRjb3JlLkNmblJ1bnRpbWVcbiAgcHVibGljIHJlYWRvbmx5IHJ1bnRpbWVBcm46IHN0cmluZ1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogTWNwM2xvUnVudGltZVN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKVxuXG4gICAgY29uc3QgcHJvamVjdE5hbWUgPSBwcm9wcz8ucHJvamVjdE5hbWUgfHwgJ3N0cmFuZHMtYWdlbnQtY2hhdGJvdCdcbiAgICBjb25zdCBlbnZpcm9ubWVudCA9IHByb3BzPy5lbnZpcm9ubWVudCB8fCAnZGV2J1xuXG4gICAgLy8gVW5pcXVlIGJ1aWxkIHRhZyB0byBmb3JjZSBSdW50aW1lIHRvIHB1bGwgbmV3IGltYWdlIG9uIGVhY2ggZGVwbG95bWVudFxuICAgIGNvbnN0IGJ1aWxkVGFnID0gRGF0ZS5ub3coKS50b1N0cmluZygpXG5cbiAgICAvLyBDb2duaXRvIGNvbmZpZ3VyYXRpb24gZm9yIEpXVCBpbmJvdW5kIGF1dGggKHJlcXVpcmVkIGZvciAzTE8gdXNlciBpZGVudGl0eSlcbiAgICBjb25zdCBjb2duaXRvVXNlclBvb2xJZCA9IHByb3BzPy5jb2duaXRvVXNlclBvb2xJZCB8fCBwcm9jZXNzLmVudi5DT0dOSVRPX1VTRVJfUE9PTF9JRCB8fCAnJ1xuICAgIGNvbnN0IGNvZ25pdG9DbGllbnRJZCA9IHByb3BzPy5jb2duaXRvQ2xpZW50SWQgfHwgcHJvY2Vzcy5lbnYuQ09HTklUT19DTElFTlRfSUQgfHwgJydcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFN0ZXAgMTogRUNSIFJlcG9zaXRvcnlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCB1c2VFeGlzdGluZ0VjciA9IHByb2Nlc3MuZW52LlVTRV9FWElTVElOR19FQ1IgPT09ICd0cnVlJ1xuICAgIGNvbnN0IHJlcG9zaXRvcnkgPSB1c2VFeGlzdGluZ0VjclxuICAgICAgPyBlY3IuUmVwb3NpdG9yeS5mcm9tUmVwb3NpdG9yeU5hbWUoXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICAnTWNwM2xvUmVwb3NpdG9yeScsXG4gICAgICAgICAgYCR7cHJvamVjdE5hbWV9LW1jcC0zbG8tc2VydmVyYFxuICAgICAgICApXG4gICAgICA6IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnTWNwM2xvUmVwb3NpdG9yeScsIHtcbiAgICAgICAgICByZXBvc2l0b3J5TmFtZTogYCR7cHJvamVjdE5hbWV9LW1jcC0zbG8tc2VydmVyYCxcbiAgICAgICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLFxuICAgICAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnS2VlcCBsYXN0IDEwIGltYWdlcycsXG4gICAgICAgICAgICAgIG1heEltYWdlQ291bnQ6IDEwLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU3RlcCAyOiBJQU0gRXhlY3V0aW9uIFJvbGUgZm9yIEFnZW50Q29yZSBSdW50aW1lXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgZXhlY3V0aW9uUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnTWNwM2xvRXhlY3V0aW9uUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiZWRyb2NrLWFnZW50Y29yZS5hbWF6b25hd3MuY29tJyksXG4gICAgICBkZXNjcmlwdGlvbjogJ0V4ZWN1dGlvbiByb2xlIGZvciBNQ1AgM0xPIFNlcnZlciBBZ2VudENvcmUgUnVudGltZScsXG4gICAgfSlcblxuICAgIC8vIEVDUiBBY2Nlc3NcbiAgICBleGVjdXRpb25Sb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBzaWQ6ICdFQ1JJbWFnZUFjY2VzcycsXG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydlY3I6QmF0Y2hHZXRJbWFnZScsICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsICdlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJ10sXG4gICAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOmVjcjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06cmVwb3NpdG9yeS8qYCwgJyonXSxcbiAgICAgIH0pXG4gICAgKVxuXG4gICAgLy8gQ2xvdWRXYXRjaCBMb2dzXG4gICAgZXhlY3V0aW9uUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nR3JvdXAnLFxuICAgICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICAgJ2xvZ3M6UHV0TG9nRXZlbnRzJyxcbiAgICAgICAgICAnbG9nczpEZXNjcmliZUxvZ1N0cmVhbXMnLFxuICAgICAgICAgICdsb2dzOkRlc2NyaWJlTG9nR3JvdXBzJyxcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOi9hd3MvYmVkcm9jay1hZ2VudGNvcmUvcnVudGltZXMvKmAsXG4gICAgICAgICAgYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOipgLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApXG5cbiAgICAvLyBYLVJheSBhbmQgQ2xvdWRXYXRjaCBNZXRyaWNzXG4gICAgZXhlY3V0aW9uUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgJ3hyYXk6UHV0VHJhY2VTZWdtZW50cycsXG4gICAgICAgICAgJ3hyYXk6UHV0VGVsZW1ldHJ5UmVjb3JkcycsXG4gICAgICAgICAgJ2Nsb3Vkd2F0Y2g6UHV0TWV0cmljRGF0YScsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICB9KVxuICAgIClcblxuICAgIC8vIE9BdXRoIG91dGJvdW5kIGF1dGggcGVybWlzc2lvbnNcbiAgICBleGVjdXRpb25Sb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBzaWQ6ICdPQXV0aElkZW50aXR5QWNjZXNzJyxcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFJlc291cmNlT2F1dGgyVG9rZW4nLFxuICAgICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpDcmVhdGVXb3JrbG9hZElkZW50aXR5JyxcbiAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0V29ya2xvYWRBY2Nlc3NUb2tlbicsXG4gICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFdvcmtsb2FkQWNjZXNzVG9rZW5Gb3JVc2VySWQnLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgfSlcbiAgICApXG5cbiAgICAvLyBTZWNyZXRzIE1hbmFnZXIgKGZvciBPQXV0aCBjcmVkZW50aWFsIHByb3ZpZGVyIHNlY3JldHMpXG4gICAgZXhlY3V0aW9uUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgc2lkOiAnU2VjcmV0c01hbmFnZXJBY2Nlc3MnLFxuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgYGFybjphd3M6c2VjcmV0c21hbmFnZXI6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnNlY3JldDoqYCxcbiAgICAgICAgXSxcbiAgICAgIH0pXG4gICAgKVxuXG4gICAgLy8gUGFyYW1ldGVyIFN0b3JlIChmb3IgY29uZmlndXJhdGlvbilcbiAgICBleGVjdXRpb25Sb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnc3NtOkdldFBhcmFtZXRlcicsICdzc206R2V0UGFyYW1ldGVycyddLFxuICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICBgYXJuOmF3czpzc206JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnBhcmFtZXRlci8ke3Byb2plY3ROYW1lfS8qYCxcbiAgICAgICAgXSxcbiAgICAgIH0pXG4gICAgKVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU3RlcCAzOiBTMyBCdWNrZXQgZm9yIENvZGVCdWlsZCBTb3VyY2VcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBzb3VyY2VCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdNY3AzbG9Tb3VyY2VCdWNrZXQnLCB7XG4gICAgICBidWNrZXROYW1lOiBgJHtwcm9qZWN0TmFtZX0tbWNwM2xvLXNyYy0ke3RoaXMuYWNjb3VudH0tJHt0aGlzLnJlZ2lvbn1gLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGV4cGlyYXRpb246IGNkay5EdXJhdGlvbi5kYXlzKDcpLFxuICAgICAgICAgIGlkOiAnRGVsZXRlT2xkU291cmNlcycsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTdGVwIDQ6IENvZGVCdWlsZCBQcm9qZWN0XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgY29kZUJ1aWxkUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnTWNwM2xvQ29kZUJ1aWxkUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdjb2RlYnVpbGQuYW1hem9uYXdzLmNvbScpLFxuICAgICAgZGVzY3JpcHRpb246ICdCdWlsZCByb2xlIGZvciBNQ1AgM0xPIFNlcnZlciBjb250YWluZXInLFxuICAgIH0pXG5cbiAgICBjb2RlQnVpbGRSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbicsXG4gICAgICAgICAgJ2VjcjpCYXRjaENoZWNrTGF5ZXJBdmFpbGFiaWxpdHknLFxuICAgICAgICAgICdlY3I6QmF0Y2hHZXRJbWFnZScsXG4gICAgICAgICAgJ2VjcjpHZXREb3dubG9hZFVybEZvckxheWVyJyxcbiAgICAgICAgICAnZWNyOlB1dEltYWdlJyxcbiAgICAgICAgICAnZWNyOkluaXRpYXRlTGF5ZXJVcGxvYWQnLFxuICAgICAgICAgICdlY3I6VXBsb2FkTGF5ZXJQYXJ0JyxcbiAgICAgICAgICAnZWNyOkNvbXBsZXRlTGF5ZXJVcGxvYWQnLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAnKicsXG4gICAgICAgICAgYGFybjphd3M6ZWNyOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpyZXBvc2l0b3J5LyR7cmVwb3NpdG9yeS5yZXBvc2l0b3J5TmFtZX1gLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApXG5cbiAgICBjb2RlQnVpbGRSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnbG9nczpDcmVhdGVMb2dHcm91cCcsICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsICdsb2dzOlB1dExvZ0V2ZW50cyddLFxuICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICBgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6L2F3cy9jb2RlYnVpbGQvJHtwcm9qZWN0TmFtZX0tKmAsXG4gICAgICAgIF0sXG4gICAgICB9KVxuICAgIClcblxuICAgIGNvZGVCdWlsZFJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydzMzpHZXRPYmplY3QnLCAnczM6UHV0T2JqZWN0JywgJ3MzOkxpc3RCdWNrZXQnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbc291cmNlQnVja2V0LmJ1Y2tldEFybiwgYCR7c291cmNlQnVja2V0LmJ1Y2tldEFybn0vKmBdLFxuICAgICAgfSlcbiAgICApXG5cbiAgICBjb25zdCBidWlsZFByb2plY3QgPSBuZXcgY29kZWJ1aWxkLlByb2plY3QodGhpcywgJ01jcDNsb0J1aWxkUHJvamVjdCcsIHtcbiAgICAgIHByb2plY3ROYW1lOiBgJHtwcm9qZWN0TmFtZX0tbWNwLTNsby1idWlsZGVyYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQnVpbGRzIEFSTTY0IGNvbnRhaW5lciBpbWFnZSBmb3IgTUNQIDNMTyBTZXJ2ZXIgUnVudGltZScsXG4gICAgICByb2xlOiBjb2RlQnVpbGRSb2xlLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgYnVpbGRJbWFnZTogY29kZWJ1aWxkLkxpbnV4QnVpbGRJbWFnZS5BTUFaT05fTElOVVhfMl9BUk1fMyxcbiAgICAgICAgY29tcHV0ZVR5cGU6IGNvZGVidWlsZC5Db21wdXRlVHlwZS5TTUFMTCxcbiAgICAgICAgcHJpdmlsZWdlZDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBzb3VyY2U6IGNvZGVidWlsZC5Tb3VyY2UuczMoe1xuICAgICAgICBidWNrZXQ6IHNvdXJjZUJ1Y2tldCxcbiAgICAgICAgcGF0aDogJ21jcC0zbG8tc291cmNlLycsXG4gICAgICB9KSxcbiAgICAgIGJ1aWxkU3BlYzogY29kZWJ1aWxkLkJ1aWxkU3BlYy5mcm9tT2JqZWN0KHtcbiAgICAgICAgdmVyc2lvbjogJzAuMicsXG4gICAgICAgIHBoYXNlczoge1xuICAgICAgICAgIHByZV9idWlsZDoge1xuICAgICAgICAgICAgY29tbWFuZHM6IFtcbiAgICAgICAgICAgICAgJ2VjaG8gTG9nZ2luZyBpbiB0byBBbWF6b24gRUNSLi4uJyxcbiAgICAgICAgICAgICAgYGF3cyBlY3IgZ2V0LWxvZ2luLXBhc3N3b3JkIC0tcmVnaW9uICR7dGhpcy5yZWdpb259IHwgZG9ja2VyIGxvZ2luIC0tdXNlcm5hbWUgQVdTIC0tcGFzc3dvcmQtc3RkaW4gJHt0aGlzLmFjY291bnR9LmRrci5lY3IuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbWAsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgYnVpbGQ6IHtcbiAgICAgICAgICAgIGNvbW1hbmRzOiBbXG4gICAgICAgICAgICAgICdlY2hvIEJ1aWxkaW5nIE1DUCAzTE8gU2VydmVyIERvY2tlciBpbWFnZSBmb3IgQVJNNjQuLi4nLFxuICAgICAgICAgICAgICAnZG9ja2VyIGJ1aWxkIC0tcGxhdGZvcm0gbGludXgvYXJtNjQgLXQgbWNwLTNsby1zZXJ2ZXI6bGF0ZXN0IC4nLFxuICAgICAgICAgICAgICBgZG9ja2VyIHRhZyBtY3AtM2xvLXNlcnZlcjpsYXRlc3QgJHtyZXBvc2l0b3J5LnJlcG9zaXRvcnlVcml9OmxhdGVzdGAsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgcG9zdF9idWlsZDoge1xuICAgICAgICAgICAgY29tbWFuZHM6IFtcbiAgICAgICAgICAgICAgJ2VjaG8gUHVzaGluZyBEb2NrZXIgaW1hZ2UgdG8gRUNSLi4uJyxcbiAgICAgICAgICAgICAgYGRvY2tlciBwdXNoICR7cmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpfTpsYXRlc3RgLFxuICAgICAgICAgICAgICAnZWNobyBCdWlsZCBjb21wbGV0ZWQgc3VjY2Vzc2Z1bGx5JyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgIH0pXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTdGVwIDU6IFVwbG9hZCBTb3VyY2UgdG8gUzNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBhZ2VudFNvdXJjZVBhdGggPSAnLi4nXG4gICAgY29uc3QgYWdlbnRTb3VyY2VVcGxvYWQgPSBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCAnTWNwM2xvU291cmNlVXBsb2FkJywge1xuICAgICAgc291cmNlczogW1xuICAgICAgICBzM2RlcGxveS5Tb3VyY2UuYXNzZXQoYWdlbnRTb3VyY2VQYXRoLCB7XG4gICAgICAgICAgZXhjbHVkZTogW1xuICAgICAgICAgICAgJ3ZlbnYvKionLFxuICAgICAgICAgICAgJy52ZW52LyoqJyxcbiAgICAgICAgICAgICdfX3B5Y2FjaGVfXy8qKicsXG4gICAgICAgICAgICAnKi5weWMnLFxuICAgICAgICAgICAgJy5naXQvKionLFxuICAgICAgICAgICAgJ25vZGVfbW9kdWxlcy8qKicsXG4gICAgICAgICAgICAnLkRTX1N0b3JlJyxcbiAgICAgICAgICAgICcqLmxvZycsXG4gICAgICAgICAgICAnY2RrLyoqJyxcbiAgICAgICAgICAgICdjZGsub3V0LyoqJyxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIF0sXG4gICAgICBkZXN0aW5hdGlvbkJ1Y2tldDogc291cmNlQnVja2V0LFxuICAgICAgZGVzdGluYXRpb25LZXlQcmVmaXg6ICdtY3AtM2xvLXNvdXJjZS8nLFxuICAgICAgcHJ1bmU6IGZhbHNlLFxuICAgICAgcmV0YWluT25EZWxldGU6IGZhbHNlLFxuICAgIH0pXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTdGVwIDY6IFRyaWdnZXIgQ29kZUJ1aWxkXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYnVpbGRUcmlnZ2VyID0gbmV3IGNyLkF3c0N1c3RvbVJlc291cmNlKHRoaXMsICdUcmlnZ2VyTWNwM2xvQ29kZUJ1aWxkJywge1xuICAgICAgb25DcmVhdGU6IHtcbiAgICAgICAgc2VydmljZTogJ0NvZGVCdWlsZCcsXG4gICAgICAgIGFjdGlvbjogJ3N0YXJ0QnVpbGQnLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgcHJvamVjdE5hbWU6IGJ1aWxkUHJvamVjdC5wcm9qZWN0TmFtZSxcbiAgICAgICAgfSxcbiAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoYG1jcC0zbG8tYnVpbGQtJHtEYXRlLm5vdygpfWApLFxuICAgICAgfSxcbiAgICAgIG9uVXBkYXRlOiB7XG4gICAgICAgIHNlcnZpY2U6ICdDb2RlQnVpbGQnLFxuICAgICAgICBhY3Rpb246ICdzdGFydEJ1aWxkJyxcbiAgICAgICAgcGFyYW1ldGVyczoge1xuICAgICAgICAgIHByb2plY3ROYW1lOiBidWlsZFByb2plY3QucHJvamVjdE5hbWUsXG4gICAgICAgIH0sXG4gICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogY3IuUGh5c2ljYWxSZXNvdXJjZUlkLm9mKGBtY3AtM2xvLWJ1aWxkLSR7RGF0ZS5ub3coKX1gKSxcbiAgICAgIH0sXG4gICAgICBwb2xpY3k6IGNyLkF3c0N1c3RvbVJlc291cmNlUG9saWN5LmZyb21TdGF0ZW1lbnRzKFtcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICBhY3Rpb25zOiBbJ2NvZGVidWlsZDpTdGFydEJ1aWxkJywgJ2NvZGVidWlsZDpCYXRjaEdldEJ1aWxkcyddLFxuICAgICAgICAgIHJlc291cmNlczogW2J1aWxkUHJvamVjdC5wcm9qZWN0QXJuXSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgIH0pXG5cbiAgICBidWlsZFRyaWdnZXIubm9kZS5hZGREZXBlbmRlbmN5KGFnZW50U291cmNlVXBsb2FkKVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU3RlcCA3OiBXYWl0IGZvciBCdWlsZCBDb21wbGV0aW9uXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYnVpbGRXYWl0ZXJGdW5jdGlvbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ01jcDNsb0J1aWxkV2FpdGVyJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIyX1gsXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmNvbnN0IHsgQ29kZUJ1aWxkQ2xpZW50LCBCYXRjaEdldEJ1aWxkc0NvbW1hbmQgfSA9IHJlcXVpcmUoJ0Bhd3Mtc2RrL2NsaWVudC1jb2RlYnVpbGQnKTtcblxuZXhwb3J0cy5oYW5kbGVyID0gYXN5bmMgKGV2ZW50KSA9PiB7XG4gIGNvbnNvbGUubG9nKCdFdmVudDonLCBKU09OLnN0cmluZ2lmeShldmVudCkpO1xuXG4gIGlmIChldmVudC5SZXF1ZXN0VHlwZSA9PT0gJ0RlbGV0ZScpIHtcbiAgICByZXR1cm4gc2VuZFJlc3BvbnNlKGV2ZW50LCAnU1VDQ0VTUycsIHsgU3RhdHVzOiAnREVMRVRFRCcgfSk7XG4gIH1cblxuICBjb25zdCBidWlsZElkID0gZXZlbnQuUmVzb3VyY2VQcm9wZXJ0aWVzLkJ1aWxkSWQ7XG4gIGNvbnN0IG1heFdhaXRNaW51dGVzID0gMTQ7XG4gIGNvbnN0IHBvbGxJbnRlcnZhbFNlY29uZHMgPSAzMDtcblxuICBjb25zb2xlLmxvZygnV2FpdGluZyBmb3IgYnVpbGQ6JywgYnVpbGRJZCk7XG5cbiAgY29uc3QgY2xpZW50ID0gbmV3IENvZGVCdWlsZENsaWVudCh7fSk7XG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG4gIGNvbnN0IG1heFdhaXRNcyA9IG1heFdhaXRNaW51dGVzICogNjAgKiAxMDAwO1xuXG4gIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRUaW1lIDwgbWF4V2FpdE1zKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgY2xpZW50LnNlbmQobmV3IEJhdGNoR2V0QnVpbGRzQ29tbWFuZCh7IGlkczogW2J1aWxkSWRdIH0pKTtcbiAgICAgIGNvbnN0IGJ1aWxkID0gcmVzcG9uc2UuYnVpbGRzWzBdO1xuICAgICAgY29uc3Qgc3RhdHVzID0gYnVpbGQuYnVpbGRTdGF0dXM7XG5cbiAgICAgIGNvbnNvbGUubG9nKFxcYEJ1aWxkIHN0YXR1czogXFwke3N0YXR1c31cXGApO1xuXG4gICAgICBpZiAoc3RhdHVzID09PSAnU1VDQ0VFREVEJykge1xuICAgICAgICByZXR1cm4gYXdhaXQgc2VuZFJlc3BvbnNlKGV2ZW50LCAnU1VDQ0VTUycsIHsgU3RhdHVzOiAnU1VDQ0VFREVEJyB9KTtcbiAgICAgIH0gZWxzZSBpZiAoWydGQUlMRUQnLCAnRkFVTFQnLCAnVElNRURfT1VUJywgJ1NUT1BQRUQnXS5pbmNsdWRlcyhzdGF0dXMpKSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBzZW5kUmVzcG9uc2UoZXZlbnQsICdGQUlMRUQnLCB7fSwgXFxgQnVpbGQgZmFpbGVkIHdpdGggc3RhdHVzOiBcXCR7c3RhdHVzfVxcYCk7XG4gICAgICB9XG5cbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCBwb2xsSW50ZXJ2YWxTZWNvbmRzICogMTAwMCkpO1xuXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yOicsIGVycm9yKTtcbiAgICAgIHJldHVybiBhd2FpdCBzZW5kUmVzcG9uc2UoZXZlbnQsICdGQUlMRUQnLCB7fSwgZXJyb3IubWVzc2FnZSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGF3YWl0IHNlbmRSZXNwb25zZShldmVudCwgJ0ZBSUxFRCcsIHt9LCBcXGBCdWlsZCB0aW1lb3V0IGFmdGVyIFxcJHttYXhXYWl0TWludXRlc30gbWludXRlc1xcYCk7XG59O1xuXG5hc3luYyBmdW5jdGlvbiBzZW5kUmVzcG9uc2UoZXZlbnQsIHN0YXR1cywgZGF0YSwgcmVhc29uKSB7XG4gIGNvbnN0IHJlc3BvbnNlQm9keSA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICBTdGF0dXM6IHN0YXR1cyxcbiAgICBSZWFzb246IHJlYXNvbiB8fCBcXGBTZWUgQ2xvdWRXYXRjaCBMb2cgU3RyZWFtOiBcXCR7ZXZlbnQuTG9nU3RyZWFtTmFtZX1cXGAsXG4gICAgUGh5c2ljYWxSZXNvdXJjZUlkOiBldmVudC5QaHlzaWNhbFJlc291cmNlSWQgfHwgZXZlbnQuUmVxdWVzdElkLFxuICAgIFN0YWNrSWQ6IGV2ZW50LlN0YWNrSWQsXG4gICAgUmVxdWVzdElkOiBldmVudC5SZXF1ZXN0SWQsXG4gICAgTG9naWNhbFJlc291cmNlSWQ6IGV2ZW50LkxvZ2ljYWxSZXNvdXJjZUlkLFxuICAgIERhdGE6IGRhdGFcbiAgfSk7XG5cbiAgY29uc29sZS5sb2coJ1Jlc3BvbnNlOicsIHJlc3BvbnNlQm9keSk7XG5cbiAgY29uc3QgaHR0cHMgPSByZXF1aXJlKCdodHRwcycpO1xuICBjb25zdCB1cmwgPSByZXF1aXJlKCd1cmwnKTtcbiAgY29uc3QgcGFyc2VkVXJsID0gdXJsLnBhcnNlKGV2ZW50LlJlc3BvbnNlVVJMKTtcblxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IG9wdGlvbnMgPSB7XG4gICAgICBob3N0bmFtZTogcGFyc2VkVXJsLmhvc3RuYW1lLFxuICAgICAgcG9ydDogNDQzLFxuICAgICAgcGF0aDogcGFyc2VkVXJsLnBhdGgsXG4gICAgICBtZXRob2Q6ICdQVVQnLFxuICAgICAgaGVhZGVyczoge1xuICAgICAgICAnQ29udGVudC1UeXBlJzogJycsXG4gICAgICAgICdDb250ZW50LUxlbmd0aCc6IHJlc3BvbnNlQm9keS5sZW5ndGhcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgY29uc3QgcmVxdWVzdCA9IGh0dHBzLnJlcXVlc3Qob3B0aW9ucywgKHJlc3BvbnNlKSA9PiB7XG4gICAgICBjb25zb2xlLmxvZyhcXGBTdGF0dXM6IFxcJHtyZXNwb25zZS5zdGF0dXNDb2RlfVxcYCk7XG4gICAgICByZXNvbHZlKGRhdGEpO1xuICAgIH0pO1xuXG4gICAgcmVxdWVzdC5vbignZXJyb3InLCAoZXJyb3IpID0+IHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yOicsIGVycm9yKTtcbiAgICAgIHJlamVjdChlcnJvcik7XG4gICAgfSk7XG5cbiAgICByZXF1ZXN0LndyaXRlKHJlc3BvbnNlQm9keSk7XG4gICAgcmVxdWVzdC5lbmQoKTtcbiAgfSk7XG59XG4gICAgICBgKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDE1KSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICB9KVxuXG4gICAgYnVpbGRXYWl0ZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6QmF0Y2hHZXRCdWlsZHMnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYnVpbGRQcm9qZWN0LnByb2plY3RBcm5dLFxuICAgICAgfSlcbiAgICApXG5cbiAgICBjb25zdCBidWlsZFdhaXRlciA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ01jcDNsb0J1aWxkV2FpdGVyUmVzb3VyY2UnLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IGJ1aWxkV2FpdGVyRnVuY3Rpb24uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEJ1aWxkSWQ6IGJ1aWxkVHJpZ2dlci5nZXRSZXNwb25zZUZpZWxkKCdidWlsZC5pZCcpLFxuICAgICAgfSxcbiAgICB9KVxuXG4gICAgYnVpbGRXYWl0ZXIubm9kZS5hZGREZXBlbmRlbmN5KGJ1aWxkVHJpZ2dlcilcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFN0ZXAgODogQ3JlYXRlIEFnZW50Q29yZSBSdW50aW1lIChNQ1AgUHJvdG9jb2wpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgcnVudGltZU5hbWUgPSBwcm9qZWN0TmFtZS5yZXBsYWNlKC8tL2csICdfJykgKyAnX21jcF8zbG9fcnVudGltZSdcbiAgICBjb25zdCBydW50aW1lID0gbmV3IGFnZW50Y29yZS5DZm5SdW50aW1lKHRoaXMsICdNY3AzbG9SdW50aW1lJywge1xuICAgICAgYWdlbnRSdW50aW1lTmFtZTogcnVudGltZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ01DUCAzTE8gU2VydmVyIFJ1bnRpbWUgLSBHbWFpbCBhbmQgZXh0ZXJuYWwgT0F1dGggc2VydmljZSB0b29scycsXG4gICAgICByb2xlQXJuOiBleGVjdXRpb25Sb2xlLnJvbGVBcm4sXG5cbiAgICAgIGFnZW50UnVudGltZUFydGlmYWN0OiB7XG4gICAgICAgIGNvbnRhaW5lckNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBjb250YWluZXJVcmk6IGAke3JlcG9zaXRvcnkucmVwb3NpdG9yeVVyaX06bGF0ZXN0YCxcbiAgICAgICAgfSxcbiAgICAgIH0sXG5cbiAgICAgIG5ldHdvcmtDb25maWd1cmF0aW9uOiB7XG4gICAgICAgIG5ldHdvcmtNb2RlOiAnUFVCTElDJyxcbiAgICAgIH0sXG5cbiAgICAgIHByb3RvY29sQ29uZmlndXJhdGlvbjogJ01DUCcsXG5cbiAgICAgIC8vIEpXVCBpbmJvdW5kIGF1dGggLSBDb2duaXRvIHZhbGlkYXRlcyB1c2VyIGlkZW50aXR5IGZvciAzTE8gT0F1dGggZmxvd3NcbiAgICAgIC8vIE5vdGU6IE9ubHkgYWxsb3dlZEF1ZGllbmNlIGlzIHVzZWQgKHZhbGlkYXRlcyAnYXVkJyBjbGFpbSBpbiBpZF90b2tlbilcbiAgICAgIC8vIGFsbG93ZWRDbGllbnRzIGlzIE5PVCB1c2VkIGJlY2F1c2UgQ29nbml0byBpZF90b2tlbiBkb2Vzbid0IGhhdmUgJ2NsaWVudF9pZCcgY2xhaW1cbiAgICAgIC4uLihjb2duaXRvVXNlclBvb2xJZCAmJiBjb2duaXRvQ2xpZW50SWQgPyB7XG4gICAgICAgIGF1dGhvcml6ZXJDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgY3VzdG9tSnd0QXV0aG9yaXplcjoge1xuICAgICAgICAgICAgZGlzY292ZXJ5VXJsOiBgaHR0cHM6Ly9jb2duaXRvLWlkcC4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tLyR7Y29nbml0b1VzZXJQb29sSWR9Ly53ZWxsLWtub3duL29wZW5pZC1jb25maWd1cmF0aW9uYCxcbiAgICAgICAgICAgIGFsbG93ZWRBdWRpZW5jZTogW2NvZ25pdG9DbGllbnRJZF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0gOiB7fSksXG5cbiAgICAgIGVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICAgIExPR19MRVZFTDogJ0lORk8nLFxuICAgICAgICBQUk9KRUNUX05BTUU6IHByb2plY3ROYW1lLFxuICAgICAgICBFTlZJUk9OTUVOVDogZW52aXJvbm1lbnQsXG4gICAgICAgIEFXU19ERUZBVUxUX1JFR0lPTjogdGhpcy5yZWdpb24sXG4gICAgICAgIEFXU19SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgICBPVEVMX1BZVEhPTl9ESVNBQkxFRF9JTlNUUlVNRU5UQVRJT05TOiAnYm90byxib3RvY29yZScsXG4gICAgICAgIC8vIEJ1aWxkIHRpbWVzdGFtcCB0byBmb3JjZSBSdW50aW1lIHVwZGF0ZSBvbiBlYWNoIGRlcGxveW1lbnRcbiAgICAgICAgQlVJTERfVElNRVNUQU1QOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICB9LFxuXG4gICAgICB0YWdzOiB7XG4gICAgICAgIEVudmlyb25tZW50OiBlbnZpcm9ubWVudCxcbiAgICAgICAgQXBwbGljYXRpb246IGAke3Byb2plY3ROYW1lfS1tY3AtM2xvLXNlcnZlcmAsXG4gICAgICAgIFR5cGU6ICdNQ1AtM0xPLVNlcnZlcicsXG4gICAgICB9LFxuICAgIH0pXG5cbiAgICBydW50aW1lLm5vZGUuYWRkRGVwZW5kZW5jeShleGVjdXRpb25Sb2xlKVxuICAgIHJ1bnRpbWUubm9kZS5hZGREZXBlbmRlbmN5KGJ1aWxkV2FpdGVyKVxuXG4gICAgdGhpcy5ydW50aW1lID0gcnVudGltZVxuICAgIHRoaXMucnVudGltZUFybiA9IHJ1bnRpbWUuYXR0ckFnZW50UnVudGltZUFyblxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU3RlcCA5OiBTdG9yZSBSdW50aW1lIEluZm9ybWF0aW9uIGluIFBhcmFtZXRlciBTdG9yZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBzc20uU3RyaW5nUGFyYW1ldGVyKHRoaXMsICdNY3AzbG9SdW50aW1lQXJuUGFyYW1ldGVyJywge1xuICAgICAgcGFyYW1ldGVyTmFtZTogYC8ke3Byb2plY3ROYW1lfS8ke2Vudmlyb25tZW50fS9tY3AvbWNwLTNsby1ydW50aW1lLWFybmAsXG4gICAgICBzdHJpbmdWYWx1ZTogcnVudGltZS5hdHRyQWdlbnRSdW50aW1lQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdNQ1AgM0xPIFNlcnZlciBBZ2VudENvcmUgUnVudGltZSBBUk4nLFxuICAgICAgdGllcjogc3NtLlBhcmFtZXRlclRpZXIuU1RBTkRBUkQsXG4gICAgfSlcblxuICAgIG5ldyBzc20uU3RyaW5nUGFyYW1ldGVyKHRoaXMsICdNY3AzbG9SdW50aW1lSWRQYXJhbWV0ZXInLCB7XG4gICAgICBwYXJhbWV0ZXJOYW1lOiBgLyR7cHJvamVjdE5hbWV9LyR7ZW52aXJvbm1lbnR9L21jcC9tY3AtM2xvLXJ1bnRpbWUtaWRgLFxuICAgICAgc3RyaW5nVmFsdWU6IHJ1bnRpbWUuYXR0ckFnZW50UnVudGltZUlkLFxuICAgICAgZGVzY3JpcHRpb246ICdNQ1AgM0xPIFNlcnZlciBBZ2VudENvcmUgUnVudGltZSBJRCcsXG4gICAgICB0aWVyOiBzc20uUGFyYW1ldGVyVGllci5TVEFOREFSRCxcbiAgICB9KVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZXBvc2l0b3J5VXJpJywge1xuICAgICAgdmFsdWU6IHJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNSIFJlcG9zaXRvcnkgVVJJIGZvciBNQ1AgM0xPIFNlcnZlciBjb250YWluZXInLFxuICAgICAgZXhwb3J0TmFtZTogYCR7cHJvamVjdE5hbWV9LW1jcC0zbG8tcmVwby11cmlgLFxuICAgIH0pXG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUnVudGltZUFybicsIHtcbiAgICAgIHZhbHVlOiBydW50aW1lLmF0dHJBZ2VudFJ1bnRpbWVBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ01DUCAzTE8gU2VydmVyIEFnZW50Q29yZSBSdW50aW1lIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHtwcm9qZWN0TmFtZX0tbWNwLTNsby1ydW50aW1lLWFybmAsXG4gICAgfSlcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSdW50aW1lSWQnLCB7XG4gICAgICB2YWx1ZTogcnVudGltZS5hdHRyQWdlbnRSdW50aW1lSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ01DUCAzTE8gU2VydmVyIEFnZW50Q29yZSBSdW50aW1lIElEJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3Byb2plY3ROYW1lfS1tY3AtM2xvLXJ1bnRpbWUtaWRgLFxuICAgIH0pXG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUGFyYW1ldGVyU3RvcmVQcmVmaXgnLCB7XG4gICAgICB2YWx1ZTogYC8ke3Byb2plY3ROYW1lfS8ke2Vudmlyb25tZW50fS9tY3BgLFxuICAgICAgZGVzY3JpcHRpb246ICdQYXJhbWV0ZXIgU3RvcmUgcHJlZml4IGZvciBNQ1AgM0xPIFNlcnZlciBjb25maWd1cmF0aW9uJyxcbiAgICB9KVxuICB9XG59XG4iXX0=