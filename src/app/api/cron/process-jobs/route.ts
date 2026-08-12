export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { processDueJobs } from '@/lib/services/jobs/queue'
import { seedRecurringJobs } from '@/lib/services/jobs/recurring-jobs'

async function getCronSecret(): Promise<string> {
  const fromEnv = process.env.CRON_SECRET
  if (fromEnv) return fromEnv

  try {
    const setting = await prisma.setting.findUnique({
      where: { key: 'cron_secret' },
    })
    if (setting?.value) return setting.value
  } catch {
    // DB might not be available
  }

  return ''
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { success: false, error: 'Missing or invalid Authorization header. Use: Bearer {CRON_SECRET}' },
      { status: 401 },
    )
  }

  const token = authHeader.slice(7)
  const expected = await getCronSecret()

  if (!expected) {
    return NextResponse.json(
      { success: false, error: 'CRON_SECRET not configured. Set CRON_SECRET environment variable or cron_secret setting.' },
      { status: 500 },
    )
  }

  if (token !== expected) {
    return NextResponse.json(
      { success: false, error: 'Invalid cron secret' },
      { status: 401 },
    )
  }

  try {
    // Idempotent: seeds recurring jobs before processing due jobs
    await seedRecurringJobs()
    const results = await processDueJobs(20)

    const completed = results.filter(r => r.status === 'COMPLETED').length
    const failed = results.filter(r => r.status === 'FAILED').length
    const retried = results.filter(r => r.status === 'FAILED').length

    try {
      await prisma.auditLog.create({
        data: {
          action: 'CRON_JOBS_PROCESSED',
          entity: 'BackgroundJob',
          details: `Cron processed ${results.length} jobs: ${completed} completed, ${failed} failed`,
        },
      })
    } catch {
      // Audit log is best-effort
    }

    return NextResponse.json({
      success: true,
      processed: results.length,
      completed,
      failed,
      retried,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to process background jobs' },
      { status: 500 },
    )
  }
}
