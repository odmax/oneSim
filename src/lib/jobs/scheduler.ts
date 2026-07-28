/**
 * OneSIM Provider Sync Scheduler — Phase 4B
 * ===========================================
 *
 * Creates due scheduled jobs without executing provider logic.
 */

import { prisma } from '@/lib/prisma'
import type { ScheduleFrequency } from '@prisma/client'

/**
 * Create all due scheduled jobs.
 * Call this periodically (e.g. every 5 minutes via cron).
 */
export async function createScheduledJobs(): Promise<{ created: number }> {
  const now = new Date()
  const schedules = await prisma.providerSyncSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
  })

  let created = 0
  for (const schedule of schedules) {
    // Deterministic idempotency key: schedule ID + time window
    const windowStart = getWindowStart(now, schedule.frequency)
    const idempotencyKey = `scheduled-${schedule.providerId}-${windowStart.toISOString()}`

    // Skip if a job already exists for this window
    const existing = await prisma.backgroundJob.findUnique({
      where: { idempotencyKey },
    })
    if (existing) {
      await updateNextRun(schedule.id, now, schedule.frequency)
      continue
    }

    // Create the scheduled job
    await prisma.backgroundJob.create({
      data: {
        type: 'PROVIDER_SYNC',
        status: 'PENDING',
        payload: { providerId: schedule.providerId, scheduleId: schedule.id },
        providerId: schedule.providerId,
        triggerSource: 'SCHEDULED',
        maxAttempts: 3,
        runAt: now,
        idempotencyKey,
        scheduleId: schedule.id,
      },
    })

    // Update schedule tracking
    await prisma.providerSyncSchedule.update({
      where: { id: schedule.id },
      data: { lastRunJobId: null },
    })

    await updateNextRun(schedule.id, now, schedule.frequency)
    created++
  }

  return { created }
}

/**
 * Get or update a provider's sync schedule.
 */
export async function getOrCreateSchedule(
  providerId: string,
  defaults?: { frequency?: ScheduleFrequency; enabled?: boolean },
) {
  let schedule = await prisma.providerSyncSchedule.findUnique({ where: { providerId } })
  if (!schedule) {
    schedule = await prisma.providerSyncSchedule.create({
      data: {
        providerId,
        frequency: defaults?.frequency || 'DAILY',
        enabled: defaults?.enabled ?? true,
        nextRunAt: new Date(),
      },
    })
  }
  return schedule
}

export async function updateSchedule(
  providerId: string,
  data: { enabled?: boolean; frequency?: ScheduleFrequency },
) {
  return prisma.providerSyncSchedule.upsert({
    where: { providerId },
    create: {
      providerId,
      enabled: data.enabled ?? true,
      frequency: data.frequency || 'DAILY',
      nextRunAt: new Date(),
    },
    update: {
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.frequency ? { frequency: data.frequency, nextRunAt: getNextRunTime(new Date(), data.frequency) } : {}),
    },
  })
}

export async function getSchedules() {
  return prisma.providerSyncSchedule.findMany({
    orderBy: { nextRunAt: 'asc' },
  })
}

function updateNextRun(scheduleId: string, now: Date, frequency: ScheduleFrequency): Promise<any> {
  return prisma.providerSyncSchedule.update({
    where: { id: scheduleId },
    data: {
      nextRunAt: getNextRunTime(now, frequency),
      lastRunAt: new Date(),
    },
  })
}

function getNextRunTime(from: Date, frequency: ScheduleFrequency): Date {
  const next = new Date(from)
  switch (frequency) {
    case 'HOURLY': next.setHours(next.getHours() + 1); break
    case 'DAILY': next.setDate(next.getDate() + 1); break
    case 'WEEKLY': next.setDate(next.getDate() + 7); break
    case 'CUSTOM': next.setDate(next.getDate() + 1); break
  }
  return next
}

function getWindowStart(now: Date, frequency: ScheduleFrequency): Date {
  const start = new Date(now)
  switch (frequency) {
    case 'HOURLY': start.setMinutes(0, 0, 0); break
    case 'DAILY': start.setHours(0, 0, 0, 0); break
    case 'WEEKLY': start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - start.getDay()); break
    case 'CUSTOM': start.setHours(0, 0, 0, 0); break
  }
  return start
}
