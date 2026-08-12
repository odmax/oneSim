import { prisma } from '@/lib/prisma'
import { upsertProviderAlert, resolveProviderAlert } from './provider-alerts'

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

export async function computeProviderHealth(providerId: string): Promise<HealthScore> {
  const p = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!p) return healthZero()

  const now = new Date()
  const h24 = new Date(now.getTime() - 86400000)
  const h1 = new Date(now.getTime() - 3600000)
  const cfg = (p.config as any) || {}
  const caps = (p.enabledCapabilities || []) as string[]
  const reasons: string[] = []
  const operational = ['ACTIVE', 'DEGRADED', 'TESTING'].includes(p.status)

  // 1. Auth (20 points)
  let authScore = 20
  let authReason = 'OK'
  if (!p.apiToken && !cfg.apiToken && !cfg.username) { authScore = 0; authReason = 'Not configured' }
  else if (p.lastFailedConnection && (!p.lastSuccessfulConnection || p.lastFailedConnection > p.lastSuccessfulConnection)) { authScore = 5; authReason = 'Recent auth failure' }
  else if (p.errorCount && p.errorCount > 5) { authScore = 10; authReason = `${p.errorCount} errors` }

  if (authScore < 10) await upsertProviderAlert(providerId, { code: 'PROVIDER_AUTH_FAILED', severity: 'ERROR', message: authReason })
  else await resolveProviderAlert(providerId, 'PROVIDER_AUTH_FAILED')

  // 2. Purchase success (25 points)
  const recentAttempts = await prisma.providerAttempt.findMany({
    where: { providerId, source: 'PURCHASE', startedAt: { gte: h24 } },
    orderBy: { startedAt: 'desc' }, take: 50,
  })
  const last1h = recentAttempts.filter(a => a.startedAt >= h1)
  const succ = recentAttempts.filter(a => a.status === 'SUCCEEDED').length
  const fail = recentAttempts.filter(a => a.status === 'FAILED').length
  const total = recentAttempts.length
  const failureRate = total > 0 ? fail / total : 0
  let purchaseScore = 25
  let purchaseReason = total > 0 ? `${succ}/${total} success` : 'No purchases'
  if (failureRate > 0.5) { purchaseScore = 8; purchaseReason = `${Math.round(failureRate * 100)}% failure rate` }
  else if (failureRate > 0.2) { purchaseScore = 16; purchaseReason = `${Math.round(failureRate * 100)}% failure rate` }

  if (failureRate > 0.3 && total >= 5) await upsertProviderAlert(providerId, { code: 'PROVIDER_HIGH_FAILURE_RATE', severity: 'ERROR', message: `${Math.round(failureRate * 100)}% (${fail}/${total})` })
  else await resolveProviderAlert(providerId, 'PROVIDER_HIGH_FAILURE_RATE')

  // 3. API availability (15 points)
  const telemetry = await prisma.$queryRawUnsafe<{ totalCalls: number; totalSuccesses: number }[]>(
    `SELECT SUM("totalCalls")::int as "totalCalls", SUM("totalSuccesses")::int as "totalSuccesses" FROM provider_endpoint_calls WHERE "providerId"=$1`, providerId
  ).catch(() => [{ totalCalls: 0, totalSuccesses: 0 }])
  const apiTotal = telemetry[0]?.totalCalls || 0
  const apiOk = telemetry[0]?.totalSuccesses || 0
  const apiRate = apiTotal > 0 ? apiOk / apiTotal : 1
  let apiScore = Math.round(15 * apiRate)
  let apiReason = apiTotal > 0 ? `${Math.round(apiRate * 100)}%` : 'No calls'

  // 4. Circuit (10 points)
  const circuit = cfg.circuitBreaker || {}
  const circuitState = circuit.state || 'CLOSED'
  let circuitScore = 10
  let circuitReason = circuitState
  if (circuitState === 'OPEN') { circuitScore = 0; reasons.push('Circuit breaker OPEN') }
  else if (circuitState === 'HALF_OPEN') { circuitScore = 5 }

  if (circuitState === 'OPEN') await upsertProviderAlert(providerId, { code: 'CIRCUIT_OPEN', severity: 'CRITICAL', message: 'Circuit breaker is OPEN' })
  else await resolveProviderAlert(providerId, 'CIRCUIT_OPEN')

  // 5. Catalog (10 points)
  const staleHours = p.lastSyncAt ? (now.getTime() - p.lastSyncAt.getTime()) / 3600000 : 999
  let catalogScore = 10
  let catalogReason = p.lastSyncAt ? `Last: ${p.lastSyncAt.toISOString().slice(0, 10)}` : 'Never synced'
  if (staleHours > 168) { catalogScore = 0; reasons.push('Catalog stale >7 days') }
  else if (staleHours > 48) { catalogScore = 3; reasons.push('Catalog stale >2 days') }
  else if (staleHours > 24) { catalogScore = 6; reasons.push('Catalog stale >1 day') }

  if (staleHours > 48) await upsertProviderAlert(providerId, { code: 'CATALOG_STALE', severity: 'WARNING', message: `Last sync: ${p.lastSyncAt?.toISOString().slice(0, 10) || 'never'}` })
  else await resolveProviderAlert(providerId, 'CATALOG_STALE')

  // 6. Balance/Inventory (10 points) — extended
  const balance = cfg.balanceSnapshot || {}
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
    if (avail === 0) { balanceScore = 0; balanceReason = 'Inventory exhausted'; await upsertProviderAlert(providerId, { code: 'INVENTORY_EXHAUSTED', severity: 'CRITICAL', message: 'No SIM inventory available' }) }
    else if (avail < 5) { balanceScore = 3; balanceReason = `Low inventory (${avail})`; await upsertProviderAlert(providerId, { code: 'INVENTORY_LOW', severity: 'WARNING', message: `Only ${avail} SIMs available` }) }
    else { await resolveProviderAlert(providerId, 'INVENTORY_EXHAUSTED'); await resolveProviderAlert(providerId, 'INVENTORY_LOW') }
  } else if (balance.latestError) {
    balanceScore = 3; balanceReason = balance.latestError?.substring(0, 60)
    await upsertProviderAlert(providerId, { code: 'LOW_PROVIDER_BALANCE', severity: 'WARNING', message: balanceReason })
  } else if (!balance.balance && caps.includes('BALANCE')) {
    balanceScore = 5; balanceReason = 'Unknown'
  } else {
    await resolveProviderAlert(providerId, 'LOW_PROVIDER_BALANCE')
  }

  // 7. Webhook/sync (10 points)
  const webhookFails = await prisma.providerWebhookEvent.count({ where: { providerId, status: 'FAILED' } }).catch(() => 0)
  let webhookScore = 10
  let webhookReason = 'OK'
  if (webhookFails > 10) { webhookScore = 3; webhookReason = `${webhookFails} failures`; await upsertProviderAlert(providerId, { code: 'WEBHOOK_BACKLOG', severity: 'WARNING', message: `${webhookFails} webhook failures` }) }
  else if (webhookFails > 0) { webhookScore = 6; webhookReason = `${webhookFails} failures` }
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
    where: { package: { providerId }, status: 'RECONCILIATION_REQUIRED' },
  }).catch(() => 0)

  if (stuckOrders > 0) {
    reasons.push(`${stuckOrders} stuck orders`)
    await upsertProviderAlert(providerId, { code: 'STUCK_ORDER', severity: 'WARNING', message: `${stuckOrders} orders stuck > 10 min` })
  } else { await resolveProviderAlert(providerId, 'STUCK_ORDER') }

  if (reconciling > 0) {
    reasons.push(`${reconciling} reconciling orders`)
    await upsertProviderAlert(providerId, { code: 'RECONCILIATION_BACKLOG', severity: 'WARNING', message: `${reconciling} orders need reconciliation` })
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
