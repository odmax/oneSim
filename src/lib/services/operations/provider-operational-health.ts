import { prisma } from '@/lib/prisma'

// ─────────────────────────────────────────────
// Health types
// ─────────────────────────────────────────────

export type ProviderHealth = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'OFFLINE' | 'UNKNOWN'
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'
export type CatalogState = 'FRESH' | 'STALE' | 'FAILED' | 'NEVER_SYNCED' | 'DISABLED'

export interface ProviderOperationalHealth {
  provider: { id: string; name: string; code: string; status: string; environment: string; capabilities: string[] }
  overallHealth: ProviderHealth
  routingEligible: boolean
  routingBlockedReason?: string
  circuit: { state: CircuitState; failureCount: number; openedAt?: string }
  authentication: { configured: boolean; lastSuccess?: string; consecutiveFailures: number; state: string }
  purchases: { total: number; succeeded: number; failed: number; pending: number; uncertain: number; successRate?: number; lastSuccess?: string }
  catalog: { totalPackages: number; lastSync?: string; state: CatalogState }
  wallet?: { balance?: number; currency?: string; lastSync?: string; state: string }
  inventory: { supported: boolean; state: string }
  webhooks: { last?: string; received24h: number; failed24h: number }
  alerts: string[]
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'
  actionRequired: boolean
  actionType: string
}

const WINDOW_MS = parseInt(process.env.PROVIDER_HEALTH_RECENT_WINDOW_MINUTES || '60', 10) * 60 * 1000
const STALE_MS = parseInt(process.env.PROVIDER_HEALTH_STALE_MINUTES || '15', 10) * 60 * 1000
const CATALOG_STALE_MS = parseInt(process.env.PROVIDER_CATALOG_STALE_HOURS || '24', 10) * 3600 * 1000
const DEGRADED_RATE = parseInt(process.env.PROVIDER_HEALTH_DEGRADED_SUCCESS_RATE || '90', 10)
const UNHEALTHY_RATE = parseInt(process.env.PROVIDER_HEALTH_UNHEALTHY_SUCCESS_RATE || '60', 10)
const MIN_SAMPLE = parseInt(process.env.PROVIDER_HEALTH_MIN_SAMPLE_SIZE || '5', 10)

const OPERATIONAL_PROVIDER_STATUSES = ['ACTIVE', 'DEGRADED']

export async function getProviderOperationalHealth(providerId: string): Promise<ProviderOperationalHealth | null> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { id: true, name: true, code: true, status: true, environment: true, enabledCapabilities: true, apiBaseUrl: true, apiToken: true, supportsESIM: true, supportsTopUp: true, supportsUsage: true, supportsSuspendResume: true, supportsWebhookPush: true, config: true },
  })
  if (!provider) return null

  const now = new Date()
  const recentWindow = new Date(now.getTime() - WINDOW_MS)

  const capabilities = Array.isArray(provider.enabledCapabilities) ? provider.enabledCapabilities as string[] : []

  // Circuit breaker
  const cfg = (provider.config as any) || {}
  const circuit = cfg.circuitBreaker || {}
  const circuitState: CircuitState = circuit.state || 'CLOSED'
  const circuitFailures = (circuit.recentFailures || []).filter((f: any) => now.getTime() - f.time < WINDOW_MS)

  // Get recent attempts
  const [recentAttempts, recentHealthSnapshot, totalPackages, webhookCounts] = await Promise.all([
    prisma.providerAttempt.findMany({
      where: { providerId, startedAt: { gte: recentWindow } },
      select: { status: true, source: true, retryClassification: true, latencyMs: true, errorCode: true, startedAt: true },
      orderBy: { startedAt: 'desc' }, take: 100,
    }),
    prisma.providerHealthSnapshot.findFirst({ where: { providerId }, orderBy: { lastCheckAt: 'desc' }, select: { status: true, lastCheckAt: true, responseTimeMs: true, successRate: true, failureCount: true } }),
    prisma.providerPackage.count({ where: { providerId } }),
    prisma.providerWebhookEvent.aggregate({
      where: { receivedAt: { gte: new Date(now.getTime() - 86400000) } },
      _count: { id: true },
    }),
  ])

  // Purchase metrics
  const purchaseAttempts = recentAttempts.filter(a => a.source === 'PURCHASE')
  const succeeded = purchaseAttempts.filter(a => a.status === 'SUCCEEDED').length
  const failed = purchaseAttempts.filter(a => a.status === 'FAILED').length
  const pending = purchaseAttempts.filter(a => a.status === 'PROCESSING' || a.status === 'STARTED').length
  const uncertain = purchaseAttempts.filter(a => a.status === 'FAILED' && ['TIMEOUT', 'NETWORK_ERROR', 'GATEWAY_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(a.errorCode || '')).length
  const total = purchaseAttempts.length

  const successRate = total >= MIN_SAMPLE ? Math.round((succeeded / total) * 100) : undefined
  const lastSuccessAttempt = purchaseAttempts.find(a => a.status === 'SUCCEEDED')

  // Auth
  const hasCreds = Boolean(provider.apiBaseUrl && provider.apiToken)
  const authState = hasCreds ? (recentHealthSnapshot?.status === 'HEALTHY' ? 'HEALTHY' : 'UNKNOWN') : 'NOT_CONFIGURED'

  // Catalog
  let catalogState: CatalogState = 'NEVER_SYNCED'
  if (totalPackages > 0) catalogState = 'FRESH'

  // Wallet
  let walletView: any = undefined
  if (capabilities.includes('BALANCE') || provider.supportsTopUp) {
    walletView = { state: 'UNKNOWN' }
    const balanceData = (cfg.wallet || cfg.balance || {}) as any
    if (balanceData.balance != null) {
      walletView = { balance: Number(balanceData.balance), currency: balanceData.currency || 'USD', lastSync: balanceData.lastSyncedAt, state: balanceData.syncStatus || 'UNKNOWN' }
    }
  }

  // Health classification
  const overallHealth = deriveProviderHealth(provider.status, circuitState, total, succeeded, failed, uncertain, hasCreds, authState, recentHealthSnapshot)
  const isRoutingEligible = overallHealth !== 'OFFLINE' && overallHealth !== 'UNKNOWN' && circuitState !== 'OPEN' && OPERATIONAL_PROVIDER_STATUSES.includes(provider.status) && capabilities.includes('PURCHASE')

  const alerts: string[] = []
  if (circuitState === 'OPEN') alerts.push('Circuit breaker open')
  if (overallHealth === 'UNHEALTHY') alerts.push('Provider unhealthy')
  if (!hasCreds) alerts.push('Authentication not configured')
  if (failed > 0 && total >= MIN_SAMPLE && successRate != null && successRate < UNHEALTHY_RATE) alerts.push(`Success rate ${successRate}% below threshold`)

  let severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL' = 'INFO'
  if (circuitState === 'OPEN' || overallHealth === 'UNHEALTHY') severity = 'ERROR'
  else if (overallHealth === 'DEGRADED' || (successRate != null && successRate < DEGRADED_RATE)) severity = 'WARNING'

  return {
    provider: { id: provider.id, name: provider.name, code: provider.code, status: provider.status, environment: provider.environment, capabilities },
    overallHealth,
    routingEligible: isRoutingEligible,
    routingBlockedReason: isRoutingEligible ? undefined : circuitState === 'OPEN' ? 'Circuit open' : !capabilities.includes('PURCHASE') ? 'Missing PURCHASE capability' : overallHealth === 'UNHEALTHY' ? 'Provider unhealthy' : undefined,
    circuit: { state: circuitState, failureCount: circuitFailures.length, openedAt: circuit.openedAt ? new Date(circuit.openedAt).toISOString() : undefined },
    authentication: { configured: hasCreds, lastSuccess: recentHealthSnapshot?.lastCheckAt?.toISOString(), consecutiveFailures: recentHealthSnapshot?.failureCount ?? 0, state: authState },
    purchases: { total, succeeded, failed, pending, uncertain, successRate, lastSuccess: lastSuccessAttempt?.startedAt?.toISOString() },
    catalog: { totalPackages, lastSync: undefined, state: catalogState },
    wallet: walletView,
    inventory: { supported: capabilities.includes('INVENTORY'), state: capabilities.includes('INVENTORY') ? 'UNSUPPORTED' : 'UNSUPPORTED' },
    webhooks: { last: undefined, received24h: webhookCounts._count.id, failed24h: 0 },
    alerts,
    severity,
    actionRequired: alerts.length > 0,
    actionType: alerts.length > 0 ? (circuitState === 'OPEN' ? 'CIRCUIT_REVIEW' : 'MONITOR') : 'NONE',
  }
}

function deriveProviderHealth(status: string, circuit: string, total: number, succeeded: number, failed: number, uncertain: number, hasCreds: boolean, authState: string, health?: any): ProviderHealth {
  const operational = ['ACTIVE', 'DEGRADED', 'TESTING'].includes(status)
  if (!operational) return status === 'MAINTENANCE' ? 'OFFLINE' : 'OFFLINE'
  if (circuit === 'OPEN') return 'UNHEALTHY'
  if (total === 0) return hasCreds ? 'UNKNOWN' : 'UNKNOWN'
  if (total < MIN_SAMPLE) return 'UNKNOWN'
  const rate = Math.round((succeeded / total) * 100)
  if (rate >= DEGRADED_RATE) return 'HEALTHY'
  if (rate >= UNHEALTHY_RATE) return 'DEGRADED'
  return 'UNHEALTHY'
}
