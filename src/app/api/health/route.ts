export const dynamic = 'force-dynamic'

import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const dbCheck = await prisma.$queryRawUnsafe<{ result: number }[]>(`SELECT 1 as result`)
    return Response.json({
      status: dbCheck.length > 0 ? 'healthy' : 'degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      services: {
        database: dbCheck.length > 0 ? 'ok' : 'error',
        memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      },
    }, { status: 200 })
  } catch {
    return Response.json({ status: 'unhealthy', timestamp: new Date().toISOString() }, { status: 503 })
  }
}
