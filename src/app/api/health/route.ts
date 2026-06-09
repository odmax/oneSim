import { NextRequest, NextResponse } from 'next/server'

const startTime = Date.now()

export async function GET(_request: NextRequest) {
  const pkg = require('@/../package.json') as any

  return NextResponse.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: pkg?.version || '1.0.0',
    name: pkg?.name || 'onesim-africa',
    node: process.version,
    environment: process.env.NODE_ENV || 'production',
  })
}