import { prisma } from '@/lib/prisma'
import { computeProviderHealth } from '@/lib/services/operations/provider-health-score'
import { upsertProviderAlert, resolveProviderAlert } from '@/lib/services/operations/provider-alerts'
import { isReconciliationEligible, reconciliationCycleKey } from '@/lib/services/orders/reconciliation'
import { hasProviderAcceptanceEvidence } from '@/lib/services/orders/provider-reference'

const HEAL_LEASE_MS = 4 * 60 * 1000 // 4-minute lease

async function recordHealEvent(providerId: string, action: string, result: string, errorCode?: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO provider_self_heal_events ("id","providerId","action","result","errorCode","attemptedAt","completedAt","createdAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW(), NOW())`,
    providerId, action, result, errorCode || null
  ).catch(() => {})
}

/**
 * Claim a provider for self-heal with a lease. `selfHealLeaseUntil` is written
 * as a JS Date (Prisma serializes UTC wall-clock) into a `timestamp without time
 * zone` column, so the expiry comparison must use UTC wall-clock too —
 * `NOW() AT TIME ZONE 'UTC'` — otherwise a server timezone ahead of UTC makes
 * every lease look already-expired and multi-worker safety is lost.
 */
export async function claimProviderHeal(providerId: string): Promise<boolean> {
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + HEAL_LEASE_MS)
  const result = await prisma.$executeRawUnsafe(
    `UPDATE providers SET "selfHealLeaseUntil" = $1 WHERE id = $2 AND ("selfHealLeaseUntil" IS NULL OR "selfHealLeaseUntil" < NOW() AT TIME ZONE 'UTC')`,
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

    // 5. Order-level reconciliation discovery: find stranded PROVIDER_RECONCILIATION
    //    orders belonging to this provider and enqueue one order-specific
    //    PROVIDER_OPERATION per eligible order.  Deduplication is enforced at
    //    the DB level via the unique background_jobs.idempotencyKey, scoped to
    //    the order's CURRENT reconciliation CYCLE (attempt-generation): duplicate
    //    discovery of the same cycle is rejected and safely skipped, while the
    //    next due cycle derives a new key and can enqueue after the previous
    //    cycle's job COMPLETED and permanently retired its key.
    const stuckOrders = await prisma.eSIMPurchase.findMany({
      where: { providerId: p.id, status: 'PROVIDER_RECONCILIATION' },
      select: { id: true, status: true, retryCount: true, maxRetries: true, nextRetryAt: true, providerFulfillId: true, providerReservationId: true },
    } as any).catch(() => [])
    let eligibleOrders: any[] = []
    let generationByOrder: Map<string, number> = new Map()
    if (stuckOrders.length > 0) {
      // Orders beyond the generic retry budget stay eligible only with provider
      // acceptance evidence (order-level reference or a provider-owned attempt
      // reference) — the poll is read-only and never a second purchase. Recover
      // evidence batched per provider, then let the sync predicate decide.
      const attemptRefs = await prisma.providerAttempt.findMany({
        where: { orderId: { in: stuckOrders.map((o: any) => o.id) }, providerId: p.id },
        select: { orderId: true, providerId: true, providerReference: true },
      }).catch(() => [] as any[])
      const attemptsByOrder = new Map<string, any[]>()
      for (const a of attemptRefs) {
        const bucket = attemptsByOrder.get(a.orderId) || []
        bucket.push(a)
        attemptsByOrder.set(a.orderId, bucket)
      }
      eligibleOrders = stuckOrders.filter((o: any) =>
        isReconciliationEligible({
          status: o.status, retryCount: o.retryCount, maxRetries: o.maxRetries,
          nextRetryAt: o.nextRetryAt ? (o.nextRetryAt instanceof Date ? o.nextRetryAt : new Date(o.nextRetryAt)) : null,
          hasAcceptanceEvidence: hasProviderAcceptanceEvidence(
            { id: o.id, providerId: p.id, providerFulfillId: o.providerFulfillId ?? null, providerReservationId: o.providerReservationId ?? null },
            attemptsByOrder.get(o.id) || [],
          ),
        }),
      )
      // Cycle generation per order = number of completed reconciliation passes
      // (persisted source=RECONCILIATION attempts). groupBy returns a row only
      // for orders with at least one such attempt; orders with none fall back
      // to generation 0 below.
      const reconAttemptCounts = await prisma.providerAttempt.groupBy({
        by: ['orderId'],
        where: {
          orderId: { in: eligibleOrders.map((o: any) => o.id) },
          source: 'RECONCILIATION',
          status: { not: 'PENDING' },
        },
        _count: { _all: true },
      }).catch(() => [])
      generationByOrder = new Map<string, number>()
      for (const row of reconAttemptCounts as any[]) {
        generationByOrder.set(row.orderId, row._count._all)
      }
    }
    if (eligibleOrders.length > 0) {
      const { enqueueJob } = await import('../queue')
      for (const order of eligibleOrders) {
        const generation = generationByOrder.get(order.id) ?? 0
        const idempotencyKey = reconciliationCycleKey(order.id, generation)
        try {
          await enqueueJob('PROVIDER_OPERATION' as any, {
            providerId: p.id,
            operation: 'reconciliation',
            orderId: order.id,
          }, new Date(), 3, idempotencyKey)
          recovered++
          await recordHealEvent(p.id, 'ORDER_RECONCILIATION_ENQUEUED', 'success')
        } catch {
          // Duplicate (unique idempotencyKey constraint) — safe to skip.
        }
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
