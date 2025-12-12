/**
 * Browser Session Poller
 *
 * Polls DynamoDB to detect when browser-use-agent saves a browser session ARN.
 * This allows the BFF to send metadata events to the frontend for Live View.
 */

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb'

const DYNAMODB_TABLE = process.env.DYNAMODB_USERS_TABLE || 'strands-agent-chatbot-users-v2'
const AWS_REGION = process.env.AWS_REGION || 'us-west-2'

// Polling configuration
const POLL_INTERVAL_MS = 2000 // 2 seconds
const MAX_POLL_DURATION_MS = 120000 // 2 minutes max

interface BrowserSessionResult {
  browserSessionId: string
  browserId?: string
}

// Track active polling sessions to prevent duplicates
const activePollers = new Set<string>()

/**
 * Poll DynamoDB for browser session ARN saved by browser-use-agent runtime.
 *
 * @param userId - User ID
 * @param sessionId - Chat session ID
 * @param onFound - Callback when browser session is found
 * @param abortSignal - Optional AbortSignal to stop polling
 * @returns Promise that resolves when polling completes or session is found
 */
export async function pollForBrowserSession(
  userId: string,
  sessionId: string,
  onFound: (result: BrowserSessionResult) => void,
  abortSignal?: AbortSignal
): Promise<BrowserSessionResult | null> {
  const pollerKey = `${userId}:${sessionId}`

  // Prevent duplicate polling for the same session
  if (activePollers.has(pollerKey)) {
    console.log(`[BrowserSessionPoller] Already polling for session ${sessionId}, skipping`)
    return null
  }

  activePollers.add(pollerKey)
  const client = new DynamoDBClient({ region: AWS_REGION })
  const startTime = Date.now()

  console.log(`[BrowserSessionPoller] Starting poll for user=${userId}, session=${sessionId}`)

  try {
    while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
      // Check if aborted
      if (abortSignal?.aborted) {
        console.log('[BrowserSessionPoller] Polling aborted')
        return null
      }

      try {
        // Query DynamoDB for the session
        const queryResponse = await client.send(new QueryCommand({
          TableName: DYNAMODB_TABLE,
          KeyConditionExpression: 'userId = :userId AND begins_with(sk, :sessionPrefix)',
          ExpressionAttributeValues: {
            ':userId': { S: userId },
            ':sessionPrefix': { S: 'SESSION#' }
          }
        }))

        // Find matching session and check for browserSession
        for (const item of queryResponse.Items || []) {
          if (item.sessionId?.S === sessionId) {
            // Check if browserSession exists in metadata
            const metadata = item.metadata?.M
            const browserSession = metadata?.browserSession?.M

            if (browserSession) {
              const browserSessionId = browserSession.sessionId?.S
              const browserId = browserSession.browserId?.S || undefined

              if (browserSessionId) {
                console.log(`[BrowserSessionPoller] Found browser session: ${browserSessionId}`)

                const result: BrowserSessionResult = {
                  browserSessionId,
                  browserId
                }

                // Invoke callback
                onFound(result)

                return result
              }
            }
          }
        }

        // Not found yet, wait and retry
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))

      } catch (error) {
        console.warn('[BrowserSessionPoller] Error during poll:', error)
        // Continue polling despite errors
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
      }
    }

    console.log('[BrowserSessionPoller] Max poll duration reached, no browser session found')
    return null
  } finally {
    // Always cleanup when polling ends
    activePollers.delete(pollerKey)
    console.log(`[BrowserSessionPoller] Cleaned up poller for session ${sessionId}`)
  }
}

/**
 * Create an SSE event string for browser session metadata
 */
export function createBrowserSessionEvent(browserSessionId: string, browserId?: string): string {
  const event = {
    type: 'metadata',
    metadata: {
      browserSessionId,
      ...(browserId && { browserId })
    }
  }
  return `data: ${JSON.stringify(event)}\n\n`
}
