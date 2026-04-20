/**
 * Available Models endpoint - returns list of supported AI models
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

// Available Bedrock models
const AVAILABLE_MODELS = [
  {
    id: 'eu.amazon.nova-pro-v1:0',
    name: 'Nova Pro',
    provider: 'Amazon',
    description: 'High-performance model'
  },
  {
    id: 'eu.amazon.nova-lite-v1:0',
    name: 'Nova Lite',
    provider: 'Amazon',
    description: 'Lightweight and efficient model'
  }
]

export async function GET() {
  try {
    return NextResponse.json({
      models: AVAILABLE_MODELS
    })
  } catch (error) {
    console.error('[API] Error loading available models:', error)

    return NextResponse.json({
      models: AVAILABLE_MODELS
    })
  }
}
