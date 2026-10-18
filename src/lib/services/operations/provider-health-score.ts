import { prisma } from '@/lib/prisma'
import { upsertProviderAlert, resolveProviderAlert } from './provider-alerts'
import { isProviderMonitored } from './provider-monitoring-policy'

export type ProviderHealth = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'RECOVERING' | 'UNKNOWN'

export interface HealthScore {
  score: number
  health: ProviderHealth
  reasons: string[]
  components: {
    auth: { score: number; reason: string }
    purchase: { score: number; attempts: number; successes: number; failures: number; reason: string }
    apiAvailability: { score: number; reason: string }
    circuit: { score: number; state: string; reason: string }
    catalog: { score: number; lastSync: Date | null; reason: string }
    balanceOrInventory: { score: number; reason: string }
    webhookSync: { score: number; reason: string }
  }
  stuckOrders: number
  activeAlerts: number
}

export interface LowBalanceThresholds {
  /** ProviderWallet.lowBalanceThreshold — highest precedence. */
  walletThreshold?: number | string | null
  /** provider.config.lowBalanceThreshold — second precedence. */
  configLowThreshold?: number | string | null
  /** provider.config.balanceThreshold — third precedence. */
  configBalanceThreshold?: number | string | null
  /** ProviderWallet.currency — compatibility guard against comparing currencies. */
  walletCurrency?: string | null
}

const BALANCE_SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000

/**
 * Deterministic LOW_PROVIDER_BALANCE evaluation.
 *
 * Threshold precedence (never inventing a default):
 *   1. ProviderWallet.lowBalanceThreshold (when a provider-wallet row exists)
 *   2. provider.config.lowBalanceThreshold
 *   3. provider.config.balanceThreshold
 *   4. none configured ⇒ no alert.
 *
 * Authoritative value: provider.config.balanceSnapshot with a numeric balance
 * and success !== false, and not older than 24h. Missing/failed/stale data is
 * NEVER treated as zero and never opens an alert. When a wallet currency and a
 * snapshot currency are both known and differ, balances are not compared (the
 * units are incompatible) so no alert opens.
 */
export function evaluateLowBalanceAlert(
  balanceSnapshot: unknown,
  thresholds: LowBalanceThresholds,
): { alert: boolean; reason: string | null; thresholdSource: 'wallet' | 'configLow' | 'configBalance' | null } {
  const snap = balanceSnapshot && typeof balanceSnapshot === 'object' ? balanceSnapshot as Record<string, unknown> : null
  const rawBalance = snap?.balance
  const balance =
    typeof rawBalance === 'number'
      ? (Number.isFinite(rawBalance) ? rawBalance : null)
      : typeof rawBalance === 'string' && /^-?\d+(\.\d+)?$/.test(rawBalance.trim())
        ? parseFloat(rawBalance)
        : null

  // Authoritative = numeric balance, provider fetch OK, and snapshot not stale.
  const fetchedAt = snap?.fetchedAt
  const fetchedMs = fetchedAt ? new Date(String(fetchedAt)).getTime() : NaN
  const stale = Number.isFinite(fetchedMs) && Date.now() - fetchedMs > BALANCE_SNAPSHOT_STALE_MS
  const authoritative = balance != null && snap?.success !== false && !stale

  const resolveThreshold = (): { value: number; source: 'wallet' | 'configLow' | 'configBalance' } | null => {
    const candidates: Array<[unknown, 'wallet' | 'configLow' | 'configBalance']> = [
      [thresholds.walletThreshold, 'wallet'],
      [thresholds.configLowThreshold, 'configLow'],
      [thresholds.configBalanceThreshold, 'configBalance'],
    ]
    for (const [raw, source] of candidates) {
      if (raw != null && Number.isFinite(Number(raw))) return { value: Number(raw), source }
    }
    return null
  }
  const threshold = resolveThreshold()
  if (authoritative !== true) return { alert: false, reason: null, thresholdSource: threshold?.source ?? null }
  if (!threshold) return { alert: false, reason: null, thresholdSource: null }

  // Currency compatibility: never compare a ProviderWallet currency against a
  // snapshot in a different currency.
  const snapshotCurrency = snap?.currency ? String(snap.currency).toLowerCase() : null
  const walletCurrency = thresholds.walletCurrency ? String(thresholds.walletCurrency).toLowerCase() : null
  if (snapshotCurrency && walletCurrency && snapshotCurrency !== walletCurrency) {
    return { alert: false, reason: null, thresholdSource: threshold.source }
  }

  if (balance! < threshold.value) {
    return { alert: true, reason: `Balance ${balance} below threshold ${threshold.value}`, thresholdSource: threshold.source }
  }
  return { alert: false, reason: null, thresholdSource: threshold.source }
}

export async function computeProviderHealth(providerId: string): Promise<HealthScore> {
  const p = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!p) return healthZero()

  const now = new Date()
  const h24 = new Date(now.getTime() - 86400000)
  const h1 = new Date(now.getTime() - 3600000)
  const cfg = (p.config as any) || {}
  const caps = (p.enabledCapabilities || []) as string[]
  const reasons: string[] = []
  const operational = isProviderMonitored(p.status)

  // Non-operational providers (INACTIVE / MAINTENANCE / ARCHIVED) must never
  // raise operational alerts: a disabled provider or one in planned maintenance
  // has no credentials by design, its catalog is intentionally stale, and its
  // failure windows are expected noise. For those providers every alert code is
  // RESOLVED instead of upserted so stale alerts do not linger after a status
  // change while no NEW signal is ever fabricated.
  const alertOrResolve = (code: string, severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL', message: string): Promise<void> =>
    operational ? upsertProviderAlert(providerId, { code, severity, message }) : resolveProviderAlert(providerId, code)

  // 1. Auth (20 points)
  let authScore = 20
  let authReason = 'OK'
  if (!p.apiToken && !cfg.apiToken && !cfg.username) { authScore = 0; authReason = 'Not configured' }
  else if (p.lastFailedConnection && (!p.lastSuccessfulConnection || p.lastFailedConnection > p.lastSuccessfulConnection)) { authScore = 5; authReason = 'Recent auth failure' }
  else if (p.errorCount && p.errorCount > 5) { authScore = 10; authReason = `${p.errorCount} errors` }

  if (authScore < 10) await alertOrResolve('PROVIDER_AUTH_FAILED', 'ERROR', authReason)
  else await resolveProviderAlert(providerId, 'PROVIDER_AUTH_FAILED')

  // 2. Purchase success (25 points)
  const recentAttempts = await prisma.providerAttempt.findMany({
    where: { providerId, source: 'PURCHASE', startedAt: { gte: h24 } },
    orderBy: { startedAt: 'desc' }, take: 50,
  })
  const last1h = recentAttempts.filter(a => a.startedAt >= h1)
  const succ = recentAttempts.filter(a => a.status === 'SUCCEEDED').length
  // Permanent failures only: transient RETRYABLE failures are expected noise on
  // the way to the bounded retry budget and must not trip a permanent-failure
  // alert. Legacy rows without a classification are treated as permanent.
  const fail = recentAttempts.filter(a => a.status === 'FAILED' && a.retryClassification !== 'RETRYABLE').length
  const total = recentAttempts.length
  const failureRate = total > 0 ? fail / total : 0
  let purchaseScore = 25
  let purchaseReason = total > 0 ? `${succ}/${total} success` : 'No purchases'
  if (failureRate > 0.5) { purchaseScore = 8; purchaseReason = `${Math.round(failureRate * 100)}% failure rate` }
  else if (failureRate > 0.2) { purchaseScore = 16; purchaseReason = `${Math.round(failureRate * 100)}% failure rate` }

  if (failureRate > 0.3 && total >= 5) await alertOrResolve('PROVIDER_HIGH_FAILURE_RATE', 'ERROR', `${Math.round(failureRate * 100)}% (${fail}/${total})`)
  else await resolveProviderAlert(providerId, 'PROVIDER_HIGH_FAILURE_RATE')

  // 3. API availability (15 points) — with latency check
  const telemetry = await prisma.$queryRawUnsafe<{ totalCalls: number; totalSuccesses: number; totalLatencyMs: number | null; consecutiveFailures: number | null; lastLatencyMs: number | null }[]>(
    `SELECT SUM("totalCalls")::int as "totalCalls", SUM("totalSuccesses")::int as "totalSuccesses",
            SUM("totalLatencyMs")::bigint as "totalLatencyMs", MAX("consecutiveFailures")::int as "consecutiveFailures",
            MAX("lastLatencyMs")::int as "lastLatencyMs"
     FROM provider_endpoint_calls WHERE "providerId"=$1`, providerId
  ).catch(() => [{ totalCalls: 0, totalSuccesses: 0, totalLatencyMs: null, consecutiveFailures: null, lastLatencyMs: null }])
  const t = telemetry[0]
  const apiTotal = t?.totalCalls || 0
  const apiOk = t?.totalSuccesses || 0
  const apiRate = apiTotal > 0 ? apiOk / apiTotal : 1
  let apiScore = Math.round(15 * apiRate)
  let apiReason = apiTotal > 0 ? `${Math.round(apiRate * 100)}%` : 'No calls'

  // Latency alert — requires sustained evidence, not one slow call
  const avgLatency = (t?.totalLatencyMs != null && apiTotal > 0) ? Math.round(Number(t.totalLatencyMs) / apiTotal) : 0
  const latencyTrigger = cfg.latencyTriggerMs || 3000
  const latencyRecover = cfg.latencyRecoverMs || 2000
  if (apiTotal >= 5 && avgLatency > latencyTrigger) {
    await alertOrResolve('PROVIDER_HIGH_LATENCY', 'WARNING', `Avg ${avgLatency}ms (threshold ${latencyTrigger}ms)`)
    if (apiScore > 10) apiScore = Math.max(8, apiScore - 3)
  } else if (avgLatency > 0 && avgLatency <= latencyRecover) {
    await resolveProviderAlert(providerId, 'PROVIDER_HIGH_LATENCY')
  }

  // 4. Circuit (10 points)
  const circuit = cfg.circuitBreaker || {}
  const circuitState = circuit.state || 'CLOSED'
  let circuitScore = 10
  let circuitReason = circuitState
  if (circuitState === 'OPEN') { circuitScore = 0; reasons.push('Circuit breaker OPEN') }
  else if (circuitState === 'HALF_OPEN') { circuitScore = 5 }

  if (circuitState === 'OPEN') await alertOrResolve('CIRCUIT_OPEN', 'CRITICAL', 'Circuit breaker is OPEN')
  else await resolveProviderAlert(providerId, 'CIRCUIT_OPEN')

  // 5. Catalog (10 points)
  const staleHours = p.lastSyncAt ? (now.getTime() - p.lastSyncAt.getTime()) / 3600000 : 999
  let catalogScore = 10
  let catalogReason = p.lastSyncAt ? `Last: ${p.lastSyncAt.toISOString().slice(0, 10)}` : 'Never synced'
  if (staleHours > 168) { catalogScore = 0; reasons.push('Catalog stale >7 days') }
  else if (staleHours > 48) { catalogScore = 3; reasons.push('Catalog stale >2 days') }
  else if (staleHours > 24) { catalogScore = 6; reasons.push('Catalog stale >1 day') }

  if (staleHours > 48) await alertOrResolve('CATALOG_STALE', 'WARNING', `Last sync: ${p.lastSyncAt?.toISOString().slice(0, 10) || 'never'}`)
  else await resolveProviderAlert(providerId, 'CATALOG_STALE')

  // 6. Balance/Inventory (10 points) — extended
  const balanceSnap = cfg.balanceSnapshot || {}
  let balanceScore = 10
  let balanceReason = 'OK'

  // Check inventory counts if provider supports INVENTORY
  const invCount = await prisma.eSIM.count({
    where: { purchase: { package: { providerId } }, status: { not: 'EXPIRED' } },
  }).catch(() => 0)
  const hasInventory = caps.includes('INVENTORY')

  if (hasInventory) {
    const availableInventory = await prisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*)::int FROM esims e JOIN esim_purchases ep ON e."purchaseId"=ep.id JOIN esim_packages pk ON ep."packageId"=pk.id WHERE pk."providerId"=$1 AND e.status NOT IN ('EXPIRED','CANCELLED','REFUNDED')`, providerId
    ).catch(() => [{ count: 0 }])
    const avail = availableInventory[0]?.count || 0
    if (avail === 0) { balanceScore = 0; balanceReason = 'Inventory exhausted'; await alertOrResolve('INVENTORY_EXHAUSTED', 'CRITICAL', 'No SIM inventory available') }
    else if (avail < 5) { balanceScore = 3; balanceReason = `Low inventory (${avail})`; await alertOrResolve('INVENTORY_LOW', 'WARNING', `Only ${avail} SIMs available`) }
    else { await resolveProviderAlert(providerId, 'INVENTORY_EXHAUSTED'); await resolveProviderAlert(providerId, 'INVENTORY_LOW') }
  } else {
    // Authoritative provider balance snapshot (provider.config.balanceSnapshot
    // written by provider-balance.ts) + deterministic threshold precedence:
    // ProviderWallet.lowBalanceThreshold > config.lowBalanceThreshold >
    // config.balanceThreshold. Missing/failed/stale data is never zero and no
    // default threshold is invented. The wallet lookup is keyed by this provider
    // only — provider/account isolation preserved. NO provider call is made.
    const wallet = await prisma.providerWallet.findUnique({ where: { providerId } }).catch(() => null)
    const lowBalance = evaluateLowBalanceAlert(balanceSnap, {
      walletThreshold: wallet?.lowBalanceThreshold ?? null,
      configLowThreshold: cfg.lowBalanceThreshold,
      configBalanceThreshold: cfg.balanceThreshold,
      walletCurrency: wallet?.currency ?? null,
    })
    if (lowBalance.alert) {
      balanceScore = 3
      balanceReason = lowBalance.reason!
      await alertOrResolve('LOW_PROVIDER_BALANCE', 'WARNING', lowBalance.reason!)
    } else {
      await resolveProviderAlert(providerId, 'LOW_PROVIDER_BALANCE')
      if (balanceSnap?.balance == null && caps.includes('BALANCE')) {
        balanceScore = 5; balanceReason = 'Unknown'
      }
    }
  }

  // 7. Webhook/sync (10 points) — bounded unresolved/retry backlog, NOT an
  // all-time cumulative failure count. A backlog is provider events from the
  // last 24h that are still unprocessed (RECEIVED) or errored (FAILED).
  const webhookBacklog = await prisma.providerWebhookEvent.count({
    where: {
      providerId,
      receivedAt: { gte: new Date(now.getTime() - 86400000) },
      status: { in: ['RECEIVED', 'FAILED'] },
    },
  }).catch(() => 0)
  let webhookScore = 10
  let webhookReason = 'OK'
  if (webhookBacklog > 10) { webhookScore = 3; webhookReason = `${webhookBacklog} unresolved`; await alertOrResolve('WEBHOOK_BACKLOG', 'WARNING', `${webhookBacklog} unresolved webhook events in last 24h`) }
  else if (webhookBacklog > 0) { webhookScore = 6; webhookReason = `${webhookBacklog} unresolved` }
  else { await resolveProviderAlert(providerId, 'WEBHOOK_BACKLOG') }

  // Stuck orders detection
  const stuckOrders = await prisma.eSIMPurchase.count({
    where: {
      package: { providerId },
      status: { in: ['PENDING_PROVIDER', 'PROCESSING'] },
      createdAt: { lte: new Date(now.getTime() - 10 * 60_000) },
    },
  }).catch(() => 0)

  const reconciling = await prisma.eSIMPurchase.count({
    where: { package: { providerId }, status: 'PROVIDER_RECONCILIATION' },
  }).catch(() => 0)

  if (stuckOrders > 0) {
    reasons.push(`${stuckOrders} stuck orders`)
    await alertOrResolve('STUCK_ORDER', 'WARNING', `${stuckOrders} orders stuck > 10 min`)
  } else { await resolveProviderAlert(providerId, 'STUCK_ORDER') }

  if (reconciling > 0) {
    reasons.push(`${reconciling} reconciling orders`)
    await alertOrResolve('RECONCILIATION_BACKLOG', 'WARNING', `${reconciling} orders need reconciliation`)
  } else { await resolveProviderAlert(providerId, 'RECONCILIATION_BACKLOG') }

  const healthTotal = authScore + purchaseScore + apiScore + circuitScore + catalogScore + balanceScore + webhookScore
  let health: ProviderHealth = 'UNKNOWN'
  if (healthTotal >= 85) health = 'HEALTHY'
  else if (healthTotal >= 60) health = 'DEGRADED'
  else if (healthTotal >= 30) health = 'RECOVERING'
  else health = 'UNAVAILABLE'
  if (!operational) health = 'UNAVAILABLE'

  const alertCount = await prisma.$queryRawUnsafe<{ count: number }[]>(
    `SELECT COUNT(*)::int FROM provider_alerts WHERE "providerId"=$1 AND "resolvedAt" IS NULL`, providerId
  ).catch(() => [{ count: 0 }])

  return {
    score: healthTotal, health, reasons,
    components: {
      auth: { score: authScore, reason: authReason },
      purchase: { score: purchaseScore, attempts: total, successes: succ, failures: fail, reason: purchaseReason },
      apiAvailability: { score: apiScore, reason: apiReason },
      circuit: { score: circuitScore, state: circuitState, reason: circuitReason },
      catalog: { score: catalogScore, lastSync: p.lastSyncAt, reason: catalogReason },
      balanceOrInventory: { score: balanceScore, reason: balanceReason },
      webhookSync: { score: webhookScore, reason: webhookReason },
    },
    stuckOrders: stuckOrders + reconciling,
    activeAlerts: alertCount[0]?.count || 0,
  }
}

function healthZero(): HealthScore {
  return { score: 0, health: 'UNKNOWN', reasons: ['Provider not found'], components: {} as any, stuckOrders: 0, activeAlerts: 0 }
}
