import { prisma } from '@/lib/prisma'
import { acquireGroupLock, releaseGroupLock } from './locks'
import { handleCatalogEvent } from '@/lib/catalog-events/handlers'
import type { CatalogEvent, CatalogEventType, EventTrigger } from '@/lib/catalog-events/types'

const MAX_RETRIES = 5
const POLL_BATCH_SIZE = 10

function shouldBackoff(attempts: number): boolean {
  if (attempts === 0) return false
  const backoffMs = Math.min(1000 * Math.pow(2, attempts - 1), 30000)
  const minAge = new Date(Date.now() - backoffMs)
  return false // let the worker decide based on last attempt time
}

export async function processNextEvents(workerId: string): Promise<number> {
  // Recover stale PROCESSING events first
  await recoverStaleEvents()

  const pending = await prisma.catalogEvent.findMany({
    where: {
      status: { in: ['PENDING', 'FAILED'] },
      attempts: { lt: MAX_RETRIES },
    },
    orderBy: [{ attempts: 'asc' }, { createdAt: 'asc' }],
    take: POLL_BATCH_SIZE,
  })

  let processed = 0
  for (const evt of pending) {
    try {
      const success = await processEvent(evt, workerId)
      if (success) processed++
    } catch (err) {
      console.error(`[WORKER] Error processing event ${evt.id}:`, err)
    }
  }
  return processed
}

const STALE_PROCESSING_TIMEOUT_MINUTES = 10

async function recoverStaleEvents(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_TIMEOUT_MINUTES * 60 * 1000)
  const staleEvents = await prisma.catalogEvent.findMany({
    where: {
      status: 'PROCESSING',
      startedAt: { lt: cutoff },
    },
    select: { id: true, startedAt: true },
  })

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
  }

  if (staleEvents.length > 0) {
    console.log(`[WORKER] Recovered ${staleEvents.length} stale PROCESSING events`)
  }
}

async function processEvent(evt: any, workerId: string): Promise<boolean> {
  const comparableKey = evt.comparableKey || undefined

  if (comparableKey) {
    const locked = await acquireGroupLock(comparableKey, workerId)
    if (!locked) return false
  }

  try {
    await prisma.catalogEvent.update({
      where: { id: evt.id },
      data: { status: 'PROCESSING', startedAt: new Date(), attempts: { increment: 1 } },
    })

    const payload = evt.payload as Record<string, any>
    const event: CatalogEvent = {
      eventId: evt.id,
      timestamp: payload.timestamp || evt.createdAt.toISOString(),
      eventType: evt.eventType as CatalogEventType,
      providerId: evt.providerId,
      providerCode: evt.providerCode,
      packageId: evt.packageId,
      comparableKey: evt.comparableKey,
      changedFields: payload.changedFields || [],
      trigger: (payload.trigger as EventTrigger) || 'SYSTEM',
      userId: payload.userId || null,
      metadata: payload.metadata || {},
    }

    await handleCatalogEvent(event)

    await prisma.catalogEvent.update({
      where: { id: evt.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })

    return true
  } catch (err: any) {
    const newAttempts = evt.attempts + 1
    if (newAttempts >= MAX_RETRIES) {
      await prisma.catalogDeadLetter.create({
        data: {
          eventId: evt.id,
          eventType: evt.eventType,
          reason: err.message || 'Max retries exceeded',
      payload: evt.payload as any,
        },
      })
      await prisma.catalogEvent.update({
        where: { id: evt.id },
        data: { status: 'FAILED', lastError: err.message, completedAt: new Date() },
      })
    } else {
      await prisma.catalogEvent.update({
        where: { id: evt.id },
        data: {
          status: 'FAILED',
          lastError: err.message,
          attempts: newAttempts,
        },
      })
    }
    return false
  } finally {
    if (comparableKey) {
      await releaseGroupLock(comparableKey)
    }
  }
}

export async function retryEvent(eventId: string): Promise<boolean> {
  try {
    await prisma.catalogEvent.update({
      where: { id: eventId },
      data: { status: 'PENDING', lastError: null },
    })
    return true
  } catch {
    return false
  }
}

export async function cancelEvent(eventId: string): Promise<boolean> {
  try {
    await prisma.catalogEvent.update({
      where: { id: eventId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    return true
  } catch {
    return false
  }
}

export async function replayEvent(eventId: string): Promise<boolean> {
  const evt = await prisma.catalogEvent.findUnique({ where: { id: eventId } })
  if (!evt || evt.status !== 'COMPLETED') return false

  const newEvent = await prisma.catalogEvent.create({
    data: {
      eventType: evt.eventType,
      status: 'PENDING',
      providerId: evt.providerId,
      providerCode: evt.providerCode,
      packageId: evt.packageId,
      comparableKey: evt.comparableKey,
      payload: evt.payload as any,
      attempts: 0,
    },
  })

  return newEvent !== null
}

export async function getQueueMetrics() {
  const [pending, processing, completed, failed, deadLetter, avgDuration] = await Promise.all([
    prisma.catalogEvent.count({ where: { status: 'PENDING' } }),
    prisma.catalogEvent.count({ where: { status: 'PROCESSING' } }),
    prisma.catalogEvent.count({ where: { status: 'COMPLETED' } }),
    prisma.catalogEvent.count({ where: { status: 'FAILED' } }),
    prisma.catalogDeadLetter.count(),
    prisma.catalogEvent.aggregate({
      where: { status: 'COMPLETED', completedAt: { not: null } },
      _avg: { attempts: true },
    }),
  ])

  return { pending, processing, completed, failed, deadLetter, avgRetries: avgDuration._avg.attempts || 0 }
}

export async function getDeadLetterEvents() {
  return prisma.catalogDeadLetter.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
}

export async function replayDeadLetter(deadLetterId: string): Promise<boolean> {
  const dl = await prisma.catalogDeadLetter.findUnique({ where: { id: deadLetterId } })
  if (!dl) return false

  await prisma.catalogEvent.create({
    data: {
      eventType: dl.eventType,
      status: 'PENDING',
      providerId: (dl.payload as any)?.providerId || null,
      providerCode: (dl.payload as any)?.providerCode || null,
      packageId: (dl.payload as any)?.packageId || null,
      comparableKey: (dl.payload as any)?.comparableKey || null,
      payload: dl.payload as any,
      attempts: 0,
    },
  })
  return true
}

export async function deleteDeadLetter(deadLetterId: string): Promise<boolean> {
  try {
    await prisma.catalogDeadLetter.delete({ where: { id: deadLetterId } })
    return true
  } catch {
    return false
  }
}
