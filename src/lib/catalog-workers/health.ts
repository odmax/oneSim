import { prisma } from '@/lib/prisma'

export interface QueueHealth {
  pending: number
  processing: number
  completed: number
  failed: number
  deadLetterCount: number
  avgRetries: number
  oldestPendingSec: number | null
  longestProcessingSec: number | null
  retryRate: number
  deadLetterGrowth24h: number
  avgProcessingTimeMs: number
}

export async function getQueueHealth(): Promise<QueueHealth> {
  const now = new Date()

  const [
    pending, processing, completed, failed, deadLetterCount,
    avgRetriesResult, oldestPending, longestProcessing,
    avgDurationResult, deadLetter24h,
  ] = await Promise.all([
    prisma.catalogEvent.count({ where: { status: 'PENDING' } }),
    prisma.catalogEvent.count({ where: { status: 'PROCESSING' } }),
    prisma.catalogEvent.count({ where: { status: 'COMPLETED' } }),
    prisma.catalogEvent.count({ where: { status: 'FAILED' } }),
    prisma.catalogDeadLetter.count(),
    prisma.catalogEvent.aggregate({
      where: { status: 'COMPLETED' },
      _avg: { attempts: true },
    }),
    prisma.catalogEvent.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.catalogEvent.findFirst({
      where: { status: 'PROCESSING' },
      orderBy: { startedAt: 'asc' },
      select: { startedAt: true },
    }),
    prisma.catalogEvent.aggregate({
      where: { status: 'COMPLETED', completedAt: { not: null } },
      _avg: { attempts: true },
    }),
    prisma.catalogDeadLetter.count({
      where: {
        createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
    }),
  ])

  const oldestPendingSec = oldestPending?.createdAt
    ? Math.round((now.getTime() - oldestPending.createdAt.getTime()) / 1000)
    : null

  const longestProcessingSec = longestProcessing?.startedAt
    ? Math.round((now.getTime() - longestProcessing.startedAt.getTime()) / 1000)
    : null

  const totalResolved = completed + failed + deadLetterCount
  const retryRate = totalResolved > 0
    ? (avgRetriesResult._avg.attempts || 0)
    : 0

  const avgProcessingTimeMs = avgDurationResult._avg.attempts
    ? Math.round(avgDurationResult._avg.attempts * 1000)
    : 0

  return {
    pending,
    processing,
    completed,
    failed,
    deadLetterCount,
    avgRetries: avgRetriesResult._avg.attempts || 0,
    oldestPendingSec,
    longestProcessingSec,
    retryRate,
    deadLetterGrowth24h: deadLetter24h,
    avgProcessingTimeMs,
  }
}

export interface StaleProcessingResult {
  recovered: number
  details: { eventId: string; stuckMinutes: number }[]
}

export async function recoverStaleProcessingEvents(
  staleTimeoutMinutes = 10,
): Promise<StaleProcessingResult> {
  const cutoff = new Date(Date.now() - staleTimeoutMinutes * 60 * 1000)

  const staleEvents = await prisma.catalogEvent.findMany({
    where: {
      status: 'PROCESSING',
      startedAt: { lt: cutoff },
    },
    select: { id: true, startedAt: true },
  })

  const details: StaleProcessingResult['details'] = []
  for (const evt of staleEvents) {
    const stuckMinutes = evt.startedAt
      ? Math.round((Date.now() - evt.startedAt.getTime()) / 60000)
      : 0
    await prisma.catalogEvent.update({
      where: { id: evt.id },
      data: {
        status: 'PENDING',
        lastError: `Recovered from stale PROCESSING after ${stuckMinutes} minutes`,
        startedAt: null,
      },
    })
    details.push({ eventId: evt.id, stuckMinutes })
  }

  if (details.length > 0) {
    console.log('[WORKER_HEALTH] Recovered stale events:', details)
  }

  return { recovered: details.length, details }
}
