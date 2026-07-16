import { prisma } from '@/lib/prisma'
import { getTokenState, refreshAuthentication } from '@/lib/providers/token-lifecycle'
import { checkProviderHealth } from '@/lib/providers/health-check'
import { recordHealthEvent } from './health-monitor'

const JOB_LOCK_KEY = 'provider_maintenance_running'

async function acquireJobLock(): Promise<boolean> {
  try {
    const existing = await prisma.maintenanceJob.findUnique({ where: { jobKey: JOB_LOCK_KEY } })
    if (existing && existing.status === 'RUNNING') {
      const elapsed = Date.now() - existing.startedAt.getTime()
      if (elapsed < 30 * 60 * 1000) return false
      await prisma.maintenanceJob.update({
        where: { jobKey: JOB_LOCK_KEY },
        data: { status: 'FAILED', finishedAt: new Date(), error: 'Stale lock released' },
      })
    }
    await prisma.maintenanceJob.upsert({
      where: { jobKey: JOB_LOCK_KEY },
      update: { status: 'RUNNING', startedAt: new Date(), finishedAt: null, error: null },
      create: { jobKey: JOB_LOCK_KEY, status: 'RUNNING', startedAt: new Date() },
    })
    return true
  } catch {
    return false
  }
}

async function releaseJobLock(success: boolean, error?: string): Promise<void> {
  try {
    await prisma.maintenanceJob.update({
      where: { jobKey: JOB_LOCK_KEY },
      data: { status: success ? 'COMPLETED' : 'FAILED', finishedAt: new Date(), error: error || null },
    })
  } catch { }
}

export async function runProviderMaintenance(): Promise<{ checked: number; refreshed: number; errors: string[] }> {
  const acquired = await acquireJobLock()
  if (!acquired) {
    console.log('[PROVIDER_MAINTENANCE] Skipped — job already running')
    return { checked: 0, refreshed: 0, errors: ['Job already running'] }
  }

  const errors: string[] = []
  let checked = 0
  let refreshed = 0

  try {
    const providers = await prisma.provider.findMany({
      where: { status: { notIn: ['ARCHIVED'] } },
      select: { id: true, code: true, name: true },
    })

    for (const provider of providers) {
      try {
        checked++
        const tokenState = await getTokenState(provider.id)

        if (!tokenState.tokenPresent || tokenState.expired || tokenState.expiresSoon) {
          const ok = await refreshAuthentication(provider.id)
          if (ok) refreshed++
        }

        const health = await checkProviderHealth(provider.id)
        const healthy = health.status === 'HEALTHY'

        await recordHealthEvent(provider.id, {
          eventType: 'CONNECTION_TEST' as any,
          success: healthy,
          message: healthy ? 'Health check passed' : `Health: ${health.status}`,
        })
      } catch (e: any) {
        const msg = `${provider.code || provider.id}: ${e.message || 'Unknown error'}`
        errors.push(msg)
        console.log(`[PROVIDER_MAINTENANCE] Error for ${provider.code}: ${msg}`)
      }
    }

    await releaseJobLock(errors.length === 0)
    return { checked, refreshed, errors }
  } catch (e: any) {
    await releaseJobLock(false, e.message)
    return { checked, refreshed, errors: [e.message || 'Fatal error'] }
  }
}

export async function getCatalogSyncDueProviders(): Promise<string[]> {
  const providers = await prisma.provider.findMany({
    where: {
      status: { notIn: ['ARCHIVED'] },
      adapterStrategy: { not: null },
    },
    select: {
      id: true,
      config: true,
      lastSyncAt: true,
    },
  })

  const now = Date.now()
  const due: string[] = []

  for (const p of providers) {
    const cfg = (p.config as any) || {}
    const schedule = cfg.catalogSyncSchedule || 'manual'
    const intervalMs = getScheduleInterval(schedule)
    if (intervalMs === null) continue

    if (!p.lastSyncAt || now - p.lastSyncAt.getTime() >= intervalMs) {
      due.push(p.id)
    }
  }

  return due
}

function getScheduleInterval(schedule: string): number | null {
  switch (schedule) {
    case 'hourly': return 60 * 60 * 1000
    case 'every_6_hours': return 6 * 60 * 60 * 1000
    case 'daily': return 24 * 60 * 60 * 1000
    case 'manual': return null
    default:
      if (/^\d+$/.test(schedule)) return parseInt(schedule, 10) * 60 * 1000
      return null
  }
}
