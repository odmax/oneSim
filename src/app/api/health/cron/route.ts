import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const CRON_JOBS = [
  { name: 'process-webhooks', path: '/api/cron/process-webhooks' },
  { name: 'provider-health', path: '/api/cron/provider-health' },
  { name: 'refresh-esims', path: '/api/cron/refresh-esims' },
  { name: 'sync-esim-status', path: '/api/cron/sync-esim-status' },
  { name: 'process-jobs', path: '/api/cron/process-jobs' },
]

export async function GET() {
  try {
    const jobs = await prisma.backgroundJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    const lastRun: Record<string, Date | null> = {}
    const lastResult: Record<string, string | null> = {}

    for (const cronJob of CRON_JOBS) {
      const latest = jobs.find(j => j.type === cronJob.name && j.status === 'COMPLETED')
      lastRun[cronJob.name] = latest?.createdAt || null
      lastResult[cronJob.name] = latest?.lastError || null
    }

    const pendingJobs = jobs.filter(j => j.status === 'PENDING').length
    const failedJobs = jobs.filter(j => j.status === 'FAILED').length
    const recentlyFailed = jobs.filter(j => j.status === 'FAILED' && j.createdAt > new Date(Date.now() - 24 * 60 * 60 * 1000)).length

    const resultsPerJob = CRON_JOBS.map(cronJob => {
      const jobEvents = jobs.filter(j => j.type === cronJob.name)
      return {
        name: cronJob.name,
        path: cronJob.path,
        lastRun: lastRun[cronJob.name]?.toISOString() || null,
        lastResult: lastResult[cronJob.name] || null,
        totalRuns: jobEvents.length,
        failed: jobEvents.filter(j => j.status === 'FAILED').length,
        succeeded: jobEvents.filter(j => j.status === 'COMPLETED').length,
      }
    })

    return NextResponse.json({
      success: true,
      status: failedJobs > 0 ? 'degraded' : 'healthy',
      summary: {
        totalCronJobs: CRON_JOBS.length,
        pendingJobs,
        failedJobs24h: recentlyFailed,
        totalFailedJobs: failedJobs,
      },
      jobs: resultsPerJob,
      timestamp: new Date().toISOString(),
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, status: 'error', error: e.message }, { status: 500 })
  }
}
