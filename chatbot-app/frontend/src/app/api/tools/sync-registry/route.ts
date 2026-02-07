/**
 * Sync tool registry - Force update DynamoDB TOOL_REGISTRY with tools-config.json
 * Admin endpoint to update tool registry when tools-config.json changes
 */
import { NextResponse } from 'next/server'
import { initializeToolRegistry } from '@/lib/dynamodb-client'
import toolsConfigFallback from '@/config/tools-config.json'

export const runtime = 'nodejs'

/**
 * POST /api/tools/sync-registry
 * Force update DynamoDB TOOL_REGISTRY from tools-config.json
 * Resolves SSM Parameter Store references for A2A runtime ARNs
 */
export async function POST() {
  try {
    console.log('[API] Force syncing TOOL_REGISTRY from tools-config.json...')

    // Clone config to avoid mutating the imported object
    const config = JSON.parse(JSON.stringify(toolsConfigFallback))

    // Resolve SSM parameters for A2A runtime agents and MCP runtime servers
    const ssmSections = [
      { key: 'agentcore_runtime_a2a', label: 'A2A' },
      { key: 'agentcore_runtime_mcp', label: 'MCP' },
    ]

    for (const section of ssmSections) {
      const items = (config as any)[section.key]
      if (items && items.length > 0) {
        const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm')
        const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'us-west-2' })

        console.log(`[API] Resolving ${items.length} ${section.label} runtime ARNs from SSM...`)

        for (const item of items) {
          if (item.runtime_arn_ssm) {
            try {
              const command = new GetParameterCommand({ Name: item.runtime_arn_ssm })
              const response = await ssmClient.send(command)
              if (response.Parameter?.Value) {
                item.runtime_arn = response.Parameter.Value
                console.log(`[API] ✓ Resolved ${item.id}: ${item.runtime_arn}`)
              } else {
                console.error(`[API] ✗ No value for SSM parameter ${item.runtime_arn_ssm}`)
                delete item.runtime_arn
              }
            } catch (error: any) {
              console.error(`[API] ✗ Failed to resolve SSM parameter ${item.runtime_arn_ssm}:`, error.message)
              delete item.runtime_arn
            }
          }
        }
      }
    }

    await initializeToolRegistry(config)

    return NextResponse.json({
      success: true,
      message: 'Tool registry synced successfully',
      local_tools: config.local_tools?.length || 0,
      builtin_tools: config.builtin_tools?.length || 0,
      browser_automation: config.browser_automation?.length || 0,
      gateway_targets: config.gateway_targets?.length || 0,
      agentcore_runtime_a2a: config.agentcore_runtime_a2a?.length || 0,
      agentcore_runtime_mcp: (config as any).agentcore_runtime_mcp?.length || 0,
    })
  } catch (error: any) {
    console.error('[API] Error syncing tool registry:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to sync tool registry',
        details: error.message
      },
      { status: 500 }
    )
  }
}
