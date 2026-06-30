import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const startTime = Date.now()
  let dbConnected = false
  let dbError: string | null = null
  let latencyMs = 0

  try {
    await prisma.$queryRaw`SELECT 1`
    latencyMs = Date.now() - startTime
    dbConnected = true
  } catch (e: any) {
    latencyMs = Date.now() - startTime
    dbError = e.message
  }

  const statusCode = dbConnected ? 200 : 503

  return NextResponse.json({
    success: dbConnected,
    status: dbConnected ? 'healthy' : 'unhealthy',
    dbConnected,
    latencyMs,
    error: dbError,
    timestamp: new Date().toISOString(),
    appVersion: process.env.npm_package_version || '1.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: (process.env.DATABASE_URL || '').replace(/\/\/.*@/, '//***@'),
  }, { status: statusCode })
}
