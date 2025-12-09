/**
 * Tools endpoint - returns available tools with user-specific enabled state
 * Cloud: Loads tool registry from DynamoDB TOOL_REGISTRY + user preferences from DynamoDB
 * Local: Loads tool registry from JSON file + user preferences from local file storage
 */
import { NextRequest, NextResponse } from 'next/server'
import { extractUserFromRequest } from '@/lib/auth-utils'
import {
  getUserEnabledTools as getDynamoUserEnabledTools,
  getUserProfile,
  upsertUserProfile,
  getToolRegistry
} from '@/lib/dynamodb-client'
import toolsConfigFallback from '@/config/tools-config.json'

// Check if running in local development mode
const IS_LOCAL = process.env.NEXT_PUBLIC_AGENTCORE_LOCAL === 'true'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    // Extract user from Cognito JWT token
    const user = extractUserFromRequest(request)
    const userId = user.userId

    // Step 1: Load tool registry configuration
    let toolsConfig: typeof toolsConfigFallback = toolsConfigFallback
    if (!IS_LOCAL) {
      // Cloud: Load from DynamoDB TOOL_REGISTRY (auto-initializes if not exists)
      const registryFromDDB = await getToolRegistry(toolsConfigFallback)
      if (registryFromDDB) {
        toolsConfig = registryFromDDB as typeof toolsConfigFallback
        console.log('[API] Tool registry loaded from DynamoDB')
      } else {
        console.log('[API] Tool registry not found in DynamoDB, using fallback JSON')
      }
    } else {
      console.log('[API] Local mode: using tools-config.json')
    }

    // Step 2: Load user-specific enabled tools
    let enabledToolIds: string[] = []

    if (userId !== 'anonymous') {
      // Authenticated user - load from DynamoDB (AWS) or local file (local)
      if (IS_LOCAL) {
        // Local: Load from file
        const { getUserEnabledTools: getLocalUserEnabledTools } = await import('@/lib/local-tool-store')
        enabledToolIds = getLocalUserEnabledTools(userId)
        console.log(`[API] Loaded authenticated user ${userId} from local file: ${enabledToolIds.length} enabled`)
      } else {
        // AWS: Load from DynamoDB
        const storedTools = await getDynamoUserEnabledTools(userId)
        const profile = await getUserProfile(userId)

        if (!profile) {
          // New user - initialize with all tools DISABLED (default)
          enabledToolIds = []

          // Create user profile with default preferences (all disabled)
          await upsertUserProfile(userId, user.email || '', user.username, {
            enabledTools: []
          })

          console.log(`[API] Initialized NEW user ${userId} with all tools DISABLED (default)`)
        } else {
          // Existing user - use stored preferences
          enabledToolIds = storedTools
          console.log(`[API] Loaded existing user ${userId} from DynamoDB: ${enabledToolIds.length} enabled`)
        }
      }
    } else {
      // Anonymous user - load from local file (local) or DynamoDB (AWS)
      if (IS_LOCAL) {
        const { getUserEnabledTools: getLocalUserEnabledTools } = await import('@/lib/local-tool-store')
        enabledToolIds = getLocalUserEnabledTools(userId)
        console.log(`[API] Loaded anonymous user from local file: ${enabledToolIds.length} enabled`)
      } else {
        // AWS: Load from DynamoDB
        const storedTools = await getDynamoUserEnabledTools(userId)
        enabledToolIds = storedTools
        console.log(`[API] Loaded anonymous user from DynamoDB: ${enabledToolIds.length} enabled`)
      }
    }

    // Step 3: Map tools with user-specific enabled state
    const localTools = (toolsConfig.local_tools || []).map((tool: any) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      category: tool.category,
      type: 'local_tools',
      tool_type: 'local',
      enabled: enabledToolIds.includes(tool.id)
    }))

    const builtinTools = (toolsConfig.builtin_tools || []).map((tool: any) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      category: tool.category,
      icon: tool.icon,
      type: 'builtin_tools',
      tool_type: 'builtin',
      enabled: enabledToolIds.includes(tool.id)
    }))

    // Browser automation tools (grouped within builtin tools)
    const browserAutomation = (toolsConfig.browser_automation || []).map((group: any) => {
      // Check if any tool in the group is enabled
      const anyToolEnabled = group.tools.some((tool: any) => enabledToolIds.includes(tool.id))

      return {
        id: group.id,
        name: group.name,
        description: group.description,
        category: group.category,
        icon: group.icon,
        type: 'builtin_tools',
        tool_type: 'builtin',
        enabled: anyToolEnabled,
        isDynamic: true,
        tools: group.tools.map((tool: any) => ({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          enabled: enabledToolIds.includes(tool.id)
        }))
      }
    })

    // Gateway tools (grouped like Browser Automation)
    const gatewayTargets = toolsConfig.gateway_targets || []
    const gatewayTools = gatewayTargets.map((target: any) => {
      // Check if any tool in the group is enabled
      const anyToolEnabled = target.tools.some((tool: any) => enabledToolIds.includes(tool.id))

      return {
        id: target.id,
        name: target.name,
        description: target.description,
        category: target.category,
        icon: target.icon,
        type: 'gateway',
        tool_type: 'gateway',
        enabled: anyToolEnabled,
        isDynamic: true,
        tools: target.tools.map((tool: any) => ({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          enabled: enabledToolIds.includes(tool.id)
        }))
      }
    })

    // Runtime A2A agents (grouped)
    const runtimeA2AServers = toolsConfig.agentcore_runtime_a2a || []
    const runtimeA2ATools = runtimeA2AServers.map((server: any) => {
      // For A2A agents, check if the agent itself is enabled (not nested tools)
      const isEnabled = enabledToolIds.includes(server.id)

      return {
        id: server.id,
        name: server.name,
        description: server.description,
        category: server.category,
        icon: server.icon,
        type: 'runtime-a2a',
        tool_type: 'runtime-a2a',
        enabled: isEnabled,
        isDynamic: false,
        runtime_arn: server.runtime_arn
      }
    })

    console.log(`[API] Returning tools for user ${userId} - ${enabledToolIds.length} enabled`)

    return NextResponse.json({
      tools: [...localTools, ...builtinTools, ...browserAutomation, ...gatewayTools, ...runtimeA2ATools]
    })
  } catch (error) {
    console.error('[API] Error loading tools:', error)

    // Fallback: return all tools from fallback config with default enabled state
    const localTools = (toolsConfigFallback.local_tools || []).map((tool: any) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      category: tool.category,
      type: 'local_tools',
      tool_type: 'local',
      enabled: tool.enabled ?? true
    }))

    const builtinTools = (toolsConfigFallback.builtin_tools || []).map((tool: any) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      category: tool.category,
      icon: tool.icon,
      type: 'builtin_tools',
      tool_type: 'builtin',
      enabled: tool.enabled ?? true
    }))

    // Browser automation tools (fallback - grouped)
    const browserAutomation = (toolsConfigFallback.browser_automation || []).map((group: any) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      category: group.category,
      icon: group.icon,
      type: 'builtin_tools',
      tool_type: 'builtin',
      enabled: group.enabled ?? true,
      isDynamic: true,
      tools: group.tools
    }))

    // Gateway tools (fallback - grouped)
    const gatewayTargets = toolsConfigFallback.gateway_targets || []
    const gatewayTools = gatewayTargets.map((target: any) => ({
      id: target.id,
      name: target.name,
      description: target.description,
      category: target.category,
      icon: target.icon,
      type: 'gateway',
      tool_type: 'gateway',
      enabled: target.enabled ?? false,
      isDynamic: true,
      tools: target.tools
    }))

    // Runtime A2A agents (fallback - grouped)
    const runtimeA2AServers = toolsConfigFallback.agentcore_runtime_a2a || []
    const runtimeA2ATools = runtimeA2AServers.map((server: any) => ({
      id: server.id,
      name: server.name,
      description: server.description,
      category: server.category,
      icon: server.icon,
      type: 'runtime-a2a',
      tool_type: 'runtime-a2a',
      enabled: server.enabled ?? false,
      isDynamic: false,
      runtime_arn: server.runtime_arn
    }))

    return NextResponse.json({
      tools: [...localTools, ...builtinTools, ...browserAutomation, ...gatewayTools, ...runtimeA2ATools]
    })
  }
}
