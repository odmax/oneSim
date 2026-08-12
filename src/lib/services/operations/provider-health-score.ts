import { prisma } from '@/lib/prisma'

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
}

export async function computeProviderHealth(providerId: string): Promise<HealthScore> {
  const p = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!p) return zeroScore()

  const now = new Date()
  const h24 = new Date(now.getTime() - 86400000)
  const h1 = new Date(now.getTime() - 3600000)
  const cfg = (p.config as any) || {}
  const caps = (p.enabledCapabilities || []) as string[]
  const reasons: string[] = []

  // 1. Auth (20 points)
  let authScore = 20
  let authReason = 'OK'
  if (!p.apiToken && !cfg.apiToken && !cfg.username) { authScore = 0; authReason = 'Not configured' }
  else if (p.lastFailedConnection && (!p.lastSuccessfulConnection || p.lastFailedConnection > p.lastSuccessfulConnection)) { authScore = 5; authReason = 'Recent auth failure' }
  else if (p.errorCount && p.errorCount > 5) { authScore = 10; authReason = `${p.errorCount} errors` }

  // 2. Purchase success (25 points)
  const recentAttempts = await prisma.providerAttempt.findMany({
    where: { providerId, source: 'PURCHASE', startedAt: { gte: h24 } },
    orderBy: { startedAt: 'desc' },
    take: 50,
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

  // 3. API availability (15 points)
  const telemetry = await prisma.$queryRawUnsafe<{ totalCalls: number; totalSuccesses: number }[]>(
    `SELECT SUM("totalCalls")::int as "totalCalls", SUM("totalSuccesses")::int as "totalSuccesses"
     FROM provider_endpoint_calls WHERE "providerId"=$1`, providerId
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

  // 5. Catalog (10 points)
  const staleHours = p.lastSyncAt ? (now.getTime() - p.lastSyncAt.getTime()) / 3600000 : 999
  let catalogScore = 10
  let catalogReason = p.lastSyncAt ? `Last: ${p.lastSyncAt.toISOString().slice(0, 10)}` : 'Never synced'
  if (staleHours > 168) { catalogScore = 0; reasons.push('Catalog stale >7 days') }
  else if (staleHours > 48) { catalogScore = 3; reasons.push('Catalog stale >2 days') }
  else if (staleHours > 24) { catalogScore = 6; reasons.push('Catalog stale >1 day') }

  // 6. Balance/Inventory (10 points)
  const balance = cfg.balanceSnapshot || {}
  let balanceScore = 10
  let balanceReason = 'OK'
  if (balance.latestError) { balanceScore = 3; balanceReason = balance.latestError?.substring(0, 60) }
  else if (!balance.balance && caps.includes('BALANCE')) { balanceScore = 5; balanceReason = 'Unknown' }

  // 7. Webhook/sync (10 points)
  const webhookFails = await prisma.providerWebhookEvent.count({ where: { providerId, status: 'FAILED' } }).catch(() => 0)
  let webhookScore = 10
  let webhookReason = 'OK'
  if (webhookFails > 10) { webhookScore = 3; webhookReason = `${webhookFails} failures` }
  else if (webhookFails > 0) { webhookScore = 6; webhookReason = `${webhookFails} failures` }

  const healthTotal = authScore + purchaseScore + apiScore + circuitScore + catalogScore + balanceScore + webhookScore
  let health: ProviderHealth = 'UNKNOWN'
  if (healthTotal >= 85) health = 'HEALTHY'
  else if (healthTotal >= 60) health = 'DEGRADED'
  else if (healthTotal >= 30) health = 'RECOVERING'
  else health = 'UNAVAILABLE'
  if (!['ACTIVE', 'DEGRADED', 'TESTING'].includes(p.status)) health = 'UNAVAILABLE'

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
  }
}

function zeroScore(): HealthScore {
  return { score: 0, health: 'UNKNOWN', reasons: ['Provider not found'], components: {} as any }
}
