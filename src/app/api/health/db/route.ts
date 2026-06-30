import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const startTime = Date.now()
  try {
    await prisma.$queryRaw`SELECT 1`
    const duration = Date.now() - startTime

    return NextResponse.json({
      success: true,
      status: 'healthy',
      database: 'connected',
      latencyMs: duration,
      timestamp: new Date().toISOString(),
    })
  } catch (e: any) {
    return NextResponse.json({
      success: false,
      status: 'unhealthy',
      database: 'disconnected',
      error: e.message,
      timestamp: new Date().toISOString(),
    }, { status: 503 })
  }
}
