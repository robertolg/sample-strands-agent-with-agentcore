/**
 * AgentCore Client - Supports both local and AWS deployment
 * - Local: HTTP POST to localhost:8080
 * - AWS: Bedrock AgentCore Runtime via AWS SDK
 *
 * All payloads use AG-UI format (thread_id, run_id, messages, tools, state).
 */

// Check if running in local development mode
const IS_LOCAL = process.env.NEXT_PUBLIC_AGENTCORE_LOCAL === 'true'
const AGENTCORE_URL = process.env.NEXT_PUBLIC_AGENTCORE_URL || 'http://localhost:8080'

// AWS configuration (for cloud deployment)
const AWS_REGION = process.env.AWS_REGION || 'us-west-2'
const PROJECT_NAME = process.env.PROJECT_NAME || 'strands-agent-chatbot'
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev'

// Dynamic imports for AWS SDK (only loaded in cloud deployment)
let BedrockAgentCoreClient: any
let InvokeAgentRuntimeCommand: any
let SSMClient: any
let GetParameterCommand: any
let agentCoreClient: any
let ssmClient: any
let cachedRuntimeArn: string | null = null

/**
 * Initialize AWS clients (lazy loading for cloud deployment only)
 */
async function initializeAwsClients() {
  if (IS_LOCAL) return

  if (!BedrockAgentCoreClient) {
    const bedrockModule = await import('@aws-sdk/client-bedrock-agentcore')
    BedrockAgentCoreClient = bedrockModule.BedrockAgentCoreClient
    InvokeAgentRuntimeCommand = bedrockModule.InvokeAgentRuntimeCommand
    agentCoreClient = new BedrockAgentCoreClient({ region: AWS_REGION })

    const ssmModule = await import('@aws-sdk/client-ssm')
    SSMClient = ssmModule.SSMClient
    GetParameterCommand = ssmModule.GetParameterCommand
    ssmClient = new SSMClient({ region: AWS_REGION })
  }
}

/**
 * Get AgentCore Runtime ARN from Parameter Store or environment variable
 */
async function getAgentCoreRuntimeArn(): Promise<string> {
  if (cachedRuntimeArn) {
    return cachedRuntimeArn
  }

  // Try environment variable first
  const envArn = process.env.AGENTCORE_RUNTIME_ARN
  if (envArn) {
    console.log('[AgentCore] Using AGENTCORE_RUNTIME_ARN from environment')
    cachedRuntimeArn = envArn
    return envArn
  }

  // Try Parameter Store
  try {
    await initializeAwsClients()
    const paramPath = `/${PROJECT_NAME}/${ENVIRONMENT}/agentcore/runtime-arn`
    console.log(`[AgentCore] Loading Runtime ARN from Parameter Store: ${paramPath}`)

    const command = new GetParameterCommand({ Name: paramPath })
    const response = await ssmClient.send(command)

    if (response.Parameter?.Value) {
      console.log('[AgentCore] Runtime ARN loaded from Parameter Store')
      cachedRuntimeArn = response.Parameter.Value
      return response.Parameter.Value
    }
  } catch (error) {
    console.warn('[AgentCore] Failed to load from Parameter Store:', error)
  }

  throw new Error(
    'AGENTCORE_RUNTIME_ARN not configured. Please set environment variable or Parameter Store value.'
  )
}

/**
 * Invoke local AgentCore via HTTP POST (AG-UI body pass-through)
 */
async function invokeLocalAgentCore(
  aguiBody: Record<string, any>,
  abortSignal?: AbortSignal
): Promise<ReadableStream> {
  console.log('[AgentCore] Invoking LOCAL AgentCore via HTTP POST')
  console.log(`[AgentCore]    URL: ${AGENTCORE_URL}/invocations`)

  const response = await fetch(`${AGENTCORE_URL}/invocations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(aguiBody),
    signal: abortSignal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`AgentCore returned ${response.status}: ${errorText}`)
  }

  console.log('[AgentCore] Local Runtime invoked successfully')

  if (!response.body) {
    throw new Error('No response stream received from AgentCore')
  }

  return response.body
}

/**
 * Invoke AWS Bedrock AgentCore Runtime (AG-UI body pass-through)
 */
async function invokeAwsAgentCore(
  aguiBody: Record<string, any>,
  userId: string,
  sessionId: string,
  abortSignal?: AbortSignal
): Promise<ReadableStream> {
  await initializeAwsClients()
  const runtimeArn = await getAgentCoreRuntimeArn()

  console.log('[AgentCore] Invoking AWS Bedrock AgentCore Runtime')
  console.log(`[AgentCore]    User: ${userId}, Session: ${sessionId}`)
  console.log(`[AgentCore]    ARN: ${runtimeArn}`)

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeArn,
    qualifier: 'DEFAULT',
    contentType: 'application/json',
    accept: 'text/event-stream',
    payload: Buffer.from(JSON.stringify(aguiBody)),
    runtimeUserId: userId,
    runtimeSessionId: sessionId,
  })

  const response = await agentCoreClient.send(command)

  console.log('[AgentCore] AWS Runtime invoked successfully')
  console.log(`[AgentCore]    Trace ID: ${response.traceId}`)
  console.log(`[AgentCore]    Status Code: ${response.statusCode}`)

  if (!response.response) {
    throw new Error('No response stream received from AgentCore Runtime')
  }

  // AWS SDK returns SdkStream (Node.js Readable stream or AsyncIterable)
  // Convert to Web ReadableStream for uniform handling
  const sdkStream = response.response

  // Check if it's a Node.js Readable stream (has 'pipe' method)
  if (typeof (sdkStream as any).pipe === 'function') {
    // Node.js Readable stream -> Web ReadableStream
    const nodeStream = sdkStream as any

    return new ReadableStream({
      start(controller) {
        // Handle abort signal
        if (abortSignal) {
          abortSignal.addEventListener('abort', () => {
            console.log('[AgentCore] Abort signal received, destroying Node.js stream')
            nodeStream.destroy()
            try {
              controller.close()
            } catch (e) {
              // Controller might already be closed
            }
          })
        }

        nodeStream.on('data', (chunk: Uint8Array) => {
          controller.enqueue(chunk)
        })

        nodeStream.on('end', () => {
          controller.close()
        })

        nodeStream.on('error', (error: Error) => {
          console.error('[AgentCore] Stream error:', error)
          controller.error(error)
        })
      },

      cancel() {
        console.log('[AgentCore] Stream cancelled, destroying Node.js stream')
        nodeStream.destroy()
      }
    })
  }

  // Otherwise, treat as AsyncIterable
  let aborted = false

  // Handle abort signal for AsyncIterable
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => {
      console.log('[AgentCore] Abort signal received for AsyncIterable stream')
      aborted = true
    })
  }

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of sdkStream as any) {
          if (aborted) {
            console.log('[AgentCore] Stream aborted, stopping iteration')
            break
          }
          if (chunk) {
            controller.enqueue(chunk)
          }
        }
        controller.close()
      } catch (error) {
        if (aborted) {
          console.log('[AgentCore] Stream aborted during iteration')
          try {
            controller.close()
          } catch (e) {
            // Controller might already be closed
          }
        } else {
          console.error('[AgentCore] Error reading stream:', error)
          controller.error(error)
        }
      }
    },

    cancel() {
      console.log('[AgentCore] AsyncIterable stream cancelled')
      aborted = true
    }
  })
}


/**
 * Invoke AgentCore and stream the response.
 * Accepts an AG-UI body object which is passed through to the backend.
 * userId/sessionId are used only for AWS SDK session affinity.
 */
export async function invokeAgentCoreRuntime(
  aguiBody: Record<string, any>,
  userId: string,
  sessionId: string,
  abortSignal?: AbortSignal
): Promise<ReadableStream> {
  try {
    if (IS_LOCAL) {
      return await invokeLocalAgentCore(aguiBody, abortSignal)
    } else {
      return await invokeAwsAgentCore(aguiBody, userId, sessionId, abortSignal)
    }
  } catch (error) {
    console.error('[AgentCore] Failed to invoke Runtime:', error)
    throw new Error(
      `Failed to invoke AgentCore Runtime: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

export async function pingAgentCoreRuntime(sessionId?: string, userId?: string): Promise<{
  success: boolean
  latencyMs: number
  mode: 'local' | 'aws'
  error?: string
}> {
  const startTime = Date.now()
  console.log(`[AgentCore Warmup] Starting (IS_LOCAL=${IS_LOCAL})`)

  try {
    if (IS_LOCAL) {
      console.log(`[AgentCore Warmup] Local mode: GET ${AGENTCORE_URL}/ping`)
      const response = await fetch(`${AGENTCORE_URL}/ping`, { method: 'GET' })
      const latencyMs = Date.now() - startTime
      if (!response.ok) throw new Error(`Ping failed: ${response.status}`)
      console.log(`[AgentCore Warmup] Local ping success: ${latencyMs}ms`)
      return { success: true, latencyMs, mode: 'local' }
    }

    console.log('[AgentCore Warmup] AWS mode: initializing clients')
    await initializeAwsClients()
    const runtimeArn = await getAgentCoreRuntimeArn()
    console.log(`[AgentCore Warmup] Runtime ARN: ${runtimeArn}`)

    const warmupSessionId = sessionId || `warmup00_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, '')}`
    const warmupUserId = userId || 'anonymous'
    console.log(`[AgentCore Warmup] Invoking with sessionId=${warmupSessionId}, userId=${warmupUserId}`)

    const payload = {
      thread_id: warmupSessionId,
      run_id: crypto.randomUUID(),
      messages: [],
      tools: [],
      context: [],
      state: { action: 'warmup', user_id: warmupUserId }
    }

    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      qualifier: 'DEFAULT',
      contentType: 'application/json',
      payload: Buffer.from(JSON.stringify(payload)),
      runtimeSessionId: warmupSessionId,
      runtimeUserId: warmupUserId,
    })

    const response = await agentCoreClient.send(command)
    const latencyMs = Date.now() - startTime
    console.log(`[AgentCore Warmup] AWS invoke success: ${latencyMs}ms, traceId=${response.traceId}`)
    return { success: true, latencyMs, mode: 'aws' }
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[AgentCore Warmup] Failed after ${latencyMs}ms: ${errorMsg}`)
    if (error instanceof Error && error.stack) {
      console.error(`[AgentCore Warmup] Stack: ${error.stack}`)
    }
    return { success: false, latencyMs, mode: IS_LOCAL ? 'local' : 'aws', error: errorMsg }
  }
}

/**
 * Health check - validates AgentCore configuration
 */
export async function validateAgentCoreConfig(): Promise<{
  configured: boolean
  url?: string
  runtimeArn?: string
  error?: string
}> {
  try {
    if (IS_LOCAL) {
      const response = await fetch(`${AGENTCORE_URL}/health`, {
        method: 'GET',
      })

      if (!response.ok) {
        throw new Error(`Health check failed with status ${response.status}`)
      }

      return {
        configured: true,
        url: AGENTCORE_URL,
      }
    } else {
      const runtimeArn = await getAgentCoreRuntimeArn()
      return {
        configured: true,
        runtimeArn,
      }
    }
  } catch (error) {
    return {
      configured: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
