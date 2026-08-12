import { prisma } from '@/lib/prisma'
import { computeProviderHealth } from '@/lib/services/operations/provider-health-score'
import { upsertProviderAlert, resolveProviderAlert } from '@/lib/services/operations/provider-alerts'

const HEAL_LEASE_MS = 4 * 60 * 1000 // 4-minute lease

async function recordHealEvent(providerId: string, action: string, result: string, errorCode?: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO provider_self_heal_events ("id","providerId","action","result","errorCode","attemptedAt","completedAt","createdAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW(), NOW())`,
    providerId, action, result, errorCode || null
  ).catch(() => {})
}

async function claimProviderHeal(providerId: string): Promise<boolean> {
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + HEAL_LEASE_MS)
  const result = await prisma.$executeRawUnsafe(
    `UPDATE providers SET "selfHealLeaseUntil" = $1 WHERE id = $2 AND ("selfHealLeaseUntil" IS NULL OR "selfHealLeaseUntil" < NOW())`,
    leaseUntil, providerId
  )
  return result > 0
}

async function releaseProviderHeal(providerId: string) {
  await prisma.provider.update({ where: { id: providerId }, data: { selfHealLeaseUntil: null } as any }).catch(() => {})
}

async function safeProbe(p: any): Promise<{ success: boolean; errorCode?: string; probeUnavailable?: boolean }> {
  const cfg = (p.config as any) || {}
  const circuitState = cfg.circuitBreaker?.state || 'CLOSED'
  if (circuitState !== 'HALF_OPEN') return { success: true }

  try {
    const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
    const connector = await buildConnectorFromProvider(p.id) as any

    // Probe preference order: testConnection → balance → inventory → status
    if (connector?.testConnection) {
      const result = await connector.testConnection()
      return { success: result.success, errorCode: result.error?.code }
    }
    if (connector?.getBalance) {
      const result = await connector.getBalance()
      return { success: result.success, errorCode: result.error?.code }
    }
    // No safe probe available — do NOT close circuit
    return { success: false, errorCode: 'PROBE_UNAVAILABLE', probeUnavailable: true }
  } catch (e: any) {
    return { success: false, errorCode: e.code || 'PROBE_FAILED' }
  }
}

export async function executeProviderSelfHeal(): Promise<{ completed: boolean; result?: any; error?: string }> {
  const providers = await prisma.provider.findMany({ where: { status: { not: 'ARCHIVED' } } })
  let healthEvaluated = 0; let recovered = 0; let skipped = 0
  const alerts: string[] = []

  for (const p of providers) {
    // Multi-worker safety: claim this provider
    if (!await claimProviderHeal(p.id)) { skipped++; continue }

    const health = await computeProviderHealth(p.id)
    healthEvaluated++
    const cfg = (p.config as any) || {}
    const caps = (p.enabledCapabilities || []) as string[]
    const circuitState = cfg.circuitBreaker?.state || 'CLOSED'

    // Store health snapshot
    cfg.lastHealthScore = health.score
    cfg.lastHealthSeverity = health.health
    cfg.lastHealthEvaluatedAt = new Date().toISOString()
    await prisma.provider.update({ where: { id: p.id }, data: { config: cfg as any } }).catch(() => {})

    // 1. Auth recovery
    if (health.components.auth.score < 5) {
      try {
        const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
        const connector = await buildConnectorFromProvider(p.id) as any
        if (connector?.refreshAuthentication) {
          await connector.refreshAuthentication()
          recovered++
          await recordHealEvent(p.id, 'AUTH_REFRESH', 'success')
          alerts.push(`${p.name}: re-authenticated`)
        }
      } catch (e: any) {
        await recordHealEvent(p.id, 'AUTH_REFRESH', 'failure', e.code)
      }
    }

    // 2. Circuit state machine
    if (circuitState === 'OPEN' && cfg.circuitBreaker?.openedAt) {
      const openedMs = Date.now() - new Date(cfg.circuitBreaker.openedAt).getTime()
      if (openedMs > 5 * 60_000) {
        cfg.circuitBreaker.state = 'HALF_OPEN'
        cfg.circuitBreaker.halfOpenedAt = new Date().toISOString()
        await prisma.provider.update({ where: { id: p.id }, data: { config: cfg as any } }).catch(() => {})
        recovered++
        alerts.push(`${p.name}: circuit → HALF_OPEN`)
        await recordHealEvent(p.id, 'CIRCUIT_PROBE', 'half_open')
      }
    }

    // 3. HALF_OPEN → safe probe → CLOSED/OPEN
    if (circuitState === 'HALF_OPEN') {
      const probe = await safeProbe(p)
      cfg.circuitBreaker = cfg.circuitBreaker || {}
      cfg.circuitBreaker.lastCircuitProbeAt = new Date().toISOString()
      cfg.circuitBreaker.lastCircuitProbeResult = probe.probeUnavailable ? 'UNAVAILABLE' : probe.success ? 'SUCCESS' : 'FAILED'
      cfg.circuitBreaker.lastCircuitProbeErrorCode = probe.errorCode || null

      if (probe.success) {
        cfg.circuitBreaker.state = 'CLOSED'
        cfg.circuitBreaker.closedAt = new Date().toISOString()
        await prisma.provider.update({ where: { id: p.id }, data: { config: cfg as any, errorCount: 0 } }).catch(() => {})
        await resolveProviderAlert(p.id, 'CIRCUIT_OPEN')
        recovered++
        await recordHealEvent(p.id, 'CIRCUIT_PROBE', 'success')
        alerts.push(`${p.name}: circuit → CLOSED`)
      } else if (probe.probeUnavailable) {
        // No safe probe — keep HALF_OPEN, do not close or open
        await prisma.provider.update({ where: { id: p.id }, data: { config: cfg as any } }).catch(() => {})
        await recordHealEvent(p.id, 'CIRCUIT_PROBE', 'unavailable')
        alerts.push(`${p.name}: circuit probe unavailable — staying HALF_OPEN`)
      } else {
        cfg.circuitBreaker.state = 'OPEN'
        cfg.circuitBreaker.openedAt = new Date().toISOString()
        await prisma.provider.update({ where: { id: p.id }, data: { config: cfg as any } }).catch(() => {})
        await recordHealEvent(p.id, 'CIRCUIT_PROBE', 'failure', probe.errorCode)
        alerts.push(`${p.name}: circuit probe failed → OPEN`)
      }
    }

    // 4. Catalog self-heal: enqueue sync if stale
    if (health.components.catalog.score < 6 && caps.includes('CATALOG_SYNC')) {
      const existing = await prisma.backgroundJob.findFirst({
        where: { type: 'PROVIDER_OPERATION' as any, status: 'PENDING' as any, payload: { path: ['providerId'], equals: p.id } as any },
      }).catch(() => null)
      if (!existing) {
        const { enqueueJob } = await import('../queue')
        await enqueueJob('PROVIDER_OPERATION' as any, { providerId: p.id, operation: 'sync_catalog' })
        recovered++
        await recordHealEvent(p.id, 'CATALOG_RESYNC_ENQUEUED', 'success')
        alerts.push(`${p.name}: catalog resync enqueued`)
      }
    }

    // 5. Reconciliation backlog enqueue
    if (health.stuckOrders > 5) {
      const existing = await prisma.backgroundJob.findFirst({
        where: { type: 'PROVIDER_OPERATION' as any, status: 'PENDING' as any, payload: { path: ['providerId', 'operation'], equals: [p.id, 'reconciliation'].toString() } as any },
      }).catch(() => null)
      if (!existing) {
        const { enqueueJob } = await import('../queue')
        await enqueueJob('PROVIDER_OPERATION' as any, { providerId: p.id, operation: 'reconciliation' })
        recovered++
        await recordHealEvent(p.id, 'ORDER_RECONCILIATION_ENQUEUED', 'success')
      }
    }

    // 6. Sync failure spike detection
    const syncFails1h = await prisma.eSIM.count({
      where: {
        purchase: { package: { providerId: p.id } },
        statusSyncRetryCount: { gte: 3 },
        lastStatusSyncAt: { gte: new Date(Date.now() - 3600000) },
      },
    }).catch(() => 0)
    if (syncFails1h >= 3) {
      await upsertProviderAlert(p.id, { code: 'SYNC_FAILURE_SPIKE', severity: 'WARNING', message: `${syncFails1h} sync failures in last hour` })
    } else {
      await resolveProviderAlert(p.id, 'SYNC_FAILURE_SPIKE')
    }

    // Clear expired sync locks
    const expired = new Date(Date.now() - 5 * 60_000)
    const cleared = await prisma.eSIM.updateMany({
      where: { purchase: { package: { providerId: p.id } }, statusNextSyncAt: { lte: expired }, lastStatusSyncAt: { lte: expired } },
      data: { statusNextSyncAt: new Date(Date.now() + 60_000) },
    }).catch(() => ({ count: 0 }))
    if (cleared.count > 0) {
      recovered++
      await recordHealEvent(p.id, 'STALE_LOCK_RECOVERY', 'success')
    }

    await releaseProviderHeal(p.id)
  }

  console.log(`[PROVIDER_SELF_HEAL] evaluated=${healthEvaluated} recovered=${recovered} skipped=${skipped}`)
  return { completed: true, result: { healthEvaluated, recovered, skipped, alerts } }
}
