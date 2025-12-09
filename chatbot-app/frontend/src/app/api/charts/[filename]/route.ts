import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await params

    // Security: Only allow PNG files and sanitize filename
    if (!filename.endsWith('.png') || filename.includes('..') || filename.includes('/')) {
      return NextResponse.json(
        { error: 'Invalid filename' },
        { status: 400 }
      )
    }

    // Get session_id from query params
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session_id')
    const userId = url.searchParams.get('user_id') || 'default_user'

    if (!sessionId) {
      return NextResponse.json(
        { error: 'session_id required' },
        { status: 400 }
      )
    }

    // Construct path to local chart file
    const baseDir = process.env.RESEARCH_WORKSPACE_DIR || '/tmp/document-generator'
    const chartPath = path.join(baseDir, sessionId, 'charts', filename)

    console.log(`[Charts API] Attempting to read chart: ${chartPath}`)

    // Check if file exists
    try {
      await fs.access(chartPath)
    } catch {
      console.error(`[Charts API] Chart not found: ${chartPath}`)
      return NextResponse.json(
        { error: 'Chart not found' },
        { status: 404 }
      )
    }

    // Read file
    const fileBuffer = await fs.readFile(chartPath)

    console.log(`[Charts API] Serving chart: ${filename} (${fileBuffer.length} bytes)`)

    // Return image with proper headers
    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600',
      },
    })

  } catch (error) {
    console.error('[Charts API] Error serving chart:', error)
    return NextResponse.json(
      {
        error: 'Failed to serve chart',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
