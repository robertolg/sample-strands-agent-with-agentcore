/**
 * OAuth 3LO Completion Endpoint
 *
 * This endpoint completes the AgentCore Identity 3LO (Three-Legged OAuth) flow.
 * Uses the official AWS SDK CompleteResourceTokenAuthCommand.
 */
import { NextRequest, NextResponse } from 'next/server'
import { extractUserFromRequest } from '@/lib/auth-utils'
import {
  BedrockAgentCoreClient,
  CompleteResourceTokenAuthCommand,
} from '@aws-sdk/client-bedrock-agentcore'

const AWS_REGION = process.env.AWS_REGION || 'us-west-2'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { session_id } = body

    if (!session_id) {
      return NextResponse.json(
        { error: 'session_id is required' },
        { status: 400 }
      )
    }

    // Extract user identity from JWT token
    const user = extractUserFromRequest(request)
    const authHeader = request.headers.get('authorization')
    const userToken = authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null

    console.log(`[OAuth] Completing 3LO flow for session: ${session_id}`)
    console.log(`[OAuth] User: ${user.userId}`)
    console.log(`[OAuth] userToken present: ${!!userToken}, length: ${userToken?.length || 0}`)

    // Build userIdentifier
    const userIdentifier = userToken
      ? { userToken }
      : { userId: user.userId }

    console.log(`[OAuth] Using ${userToken ? 'userToken' : 'userId'} for identification`)

    // Use AWS SDK CompleteResourceTokenAuthCommand
    const client = new BedrockAgentCoreClient({ region: AWS_REGION })
    const command = new CompleteResourceTokenAuthCommand({
      sessionUri: session_id,
      userIdentifier,
    })

    await client.send(command)
    console.log('[OAuth] 3LO flow completed successfully')

    return NextResponse.json({
      success: true,
      message: 'OAuth authorization completed. You can now close this window and retry the action.'
    })

  } catch (error: any) {
    console.error('[OAuth] Error completing OAuth flow:', error)

    // Extract error details
    const errorMessage = error?.message || String(error)
    const statusCode = error?.$metadata?.httpStatusCode || 500

    return NextResponse.json(
      { error: 'Failed to complete OAuth flow', details: errorMessage },
      { status: statusCode }
    )
  }
}
