import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

// ── Types ──

export type SeverityLevel = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'OFFLINE' | 'UNKNOWN'

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL'

export interface DiagnosticCheck {
  name: string
  status: CheckStatus
  message: string
}

export interface AlertItem {
  code: string
  severity: SeverityLevel
  message: string
}

export interface ProviderDiagnosticOverview {
  id: string
  name: string
  code: string | null
  adapterStrategy: string | null
  type: string
  status: string
  severity: SeverityLevel
  verdict: PurchaseVerdict
  verdictReason: string
  operational: boolean
  hasPurchaseCapability: boolean
  authConfigured: boolean
  circuitState: string
  balanceStatus: string | null
  lastSuccessfulPurchase: Date | null
  lastFailedPurchase: Date | null
  lastProviderError: string | null
  lastSyncAt: Date | null
  catalogPackageCount: number
  purchaseReadyCount: number
  alertCount: number
  alerts: AlertItem[]
}

export interface ProviderDiagnosticDetail {
  id: string
  name: string
  code: string | null
  adapterStrategy: string | null
  type: string
  status: string
  environment: string | null
  enabledCapabilities: string[]
  severity: SeverityLevel
  verdict: PurchaseVerdict
  verdictReason: string
  alerts: AlertItem[]
  recommendations: RecommendedAction[]
  failureCategories: FailureCategory[]

  auth: {
    configured: boolean
    strategy: string | null
    lastConnectionTest: Date | null
    lastAuthFailure: Date | null
  }

  purchase: {
    capability: boolean
    operational: boolean
    circuitState: string
    configuredPackages: number
    purchaseReadyPackages: number
    blockedPackages: number
    purchaseEndpointConfigured: boolean
    travelDateRequired: boolean
    travelDatePresenceRate: number
    checks: DiagnosticCheck[]
  }

  balance: {
    known: boolean
    currency: string | null
    lastRefresh: Date | null
    lowBalance: boolean
    latestError: string | null
  }

  catalog: {
    total: number
    configured: number
    published: number
    purchaseReady: number
    blockedByPricing: number
    blockedByCost: number
    blockedBySnapshot: number
    blockedByProvider: number
    staleBundles: number
  }

  recentAttempts: {
    orderId: string
    attemptNumber: number
    timestamp: Date
    success: boolean
    duration: number | null
    errorCode: string | null
    errorMessage: string | null
    retryable: boolean
    status: string | null
  }[]

  lastRequest: {
    endpointPath: string | null
    method: string | null
    fieldsSent: string[]
    authPresent: boolean
    travelDatePresent: boolean
    planIdPresent: boolean
    orderIdPresent: boolean
  }

  lastResponse: {
    httpStatus: number | null
    result: string | null
    errorCode: string | null
    message: string | null
    retryClass: string | null
    reconciliationRequired: boolean
  }

  travelDate: {
    required: boolean
    defaultPolicy: string | null
    defaultRequirement: string | null
    lastResolved: string | null
    policyMatches: number
    policyMismatches: number
  }

  circuit: {
    state: string
    failureCount: number
    openedAt: Date | null
    nextProbeAt: Date | null
    failoverEligible: boolean
  }

  webhooks: {
    configured: boolean
    lastEventReceived: Date | null
    lastProcessResult: string | null
    failedCount: number
    queueCount: number
  }
}

// ── Service ──

export async function getProviderDiagnosticsOverview(): Promise<ProviderDiagnosticOverview[]> {
  const providers = await prisma.provider.findMany({
    include: {
      providerPackages: {
        select: { id: true, publishStatus: true, configurationStatus: true },
      },
    },
    orderBy: { name: 'asc' },
  })

  const results: ProviderDiagnosticOverview[] = []

  for (const p of providers) {
    const caps = (p.enabledCapabilities || []) as string[]
    const hasPurchase = caps.includes('PURCHASE')
    const operational = ['ACTIVE', 'DEGRADED', 'TESTING'].includes(p.status)

    // Circuit breaker from config
    const cfg = (p.config as any) || {}
    const circuit = cfg.circuitBreaker || {}
    const circuitState = circuit.state || 'CLOSED'

    // Balance from config
    const balance = cfg.balanceSnapshot || {}
    const balanceStatus = balance.balance != null ? `${balance.balance} ${balance.currency || ''}`.trim() : 'UNKNOWN'

    // Recent attempts
    const attempts = await prisma.providerAttempt.findMany({
      where: { providerId: p.id, source: 'PURCHASE' },
      orderBy: { startedAt: 'desc' },
      take: 5,
    })
    const lastSuccess = attempts.find(a => a.status === 'SUCCEEDED')
    const lastFail = attempts.find(a => a.status === 'FAILED')

    // Purchase-ready count
    const readyPackages = p.providerPackages.filter(pp =>
      pp.publishStatus === 'PUBLISHED' &&
      ['CONFIGURED', 'AUTO_CONFIGURED'].includes(pp.configurationStatus || '')
    )

    // Severity
    let severity: SeverityLevel = 'UNKNOWN'
    const alerts: AlertItem[] = []

    if (p.status === 'ACTIVE' || p.status === 'TESTING') {
      if (operational && hasPurchase && circuitState === 'CLOSED') {
        severity = 'HEALTHY'
      } else if (operational && hasPurchase && circuitState === 'HALF_OPEN') {
        severity = 'DEGRADED'
      } else if (!operational) {
        severity = 'OFFLINE'
      } else {
        severity = 'DEGRADED'
      }
    } else if (p.status === 'DEGRADED' || p.status === 'MAINTENANCE') {
      severity = 'DEGRADED'
    } else {
      severity = 'OFFLINE'
    }

    const balanceMsg = (balance.latestError || '').toLowerCase()
    const hasBalanceError = balanceMsg.includes('na') || (balance.latestError ? true : false)
    const hasBundleError = lastFail?.errorMessage?.toLowerCase().includes('bundle code not found') ?? false

    const verdict = computePurchaseVerdict({
      operational, hasPurchase, circuitOpen: circuitState === 'OPEN',
      authConfigured: !!(p.apiToken || cfg.apiToken || cfg.username),
      readyPackages: readyPackages.length,
      recentFailures: attempts.filter(a => a.status === 'FAILED').length,
      hasBalanceError,
      hasBundleError,
    })

    // Distinguish balance alerts
    if (balance.latestError) {
      const isProviderRejected = balanceMsg.includes('na') || balanceMsg.includes('rejected')
      alerts.push({
        code: isProviderRejected ? 'PROVIDER_BALANCE_REJECTED' : 'PROVIDER_BALANCE_UNAVAILABLE',
        severity: 'DEGRADED',
        message: isProviderRejected ? 'Provider rejected balance check' : `Balance unavailable: ${balance.latestError}`.substring(0, 120),
      })
    }
    if (circuitState === 'OPEN') alerts.push({ code: 'CIRCUIT_OPEN', severity: 'DEGRADED', message: `Circuit breaker open since ${circuit.openedAt || 'unknown'}` })
    if (!hasPurchase) alerts.push({ code: 'NO_PURCHASE_CAPABILITY', severity: 'DEGRADED', message: 'Provider does not support PURCHASE' })
    if (hasBundleError) alerts.push({ code: 'BUNDLE_CODE_NOT_FOUND', severity: 'DEGRADED', message: 'Bundle code not found in provider catalog' })

    results.push({
      id: p.id, name: p.name, code: p.code, adapterStrategy: p.adapterStrategy,
      type: p.type, status: p.status, severity, verdict: verdict.verdict, verdictReason: verdict.reason,
      operational, hasPurchaseCapability: hasPurchase,
      authConfigured: !!(p.apiToken || (p.config as any)?.apiToken || (p.config as any)?.username),
      circuitState, balanceStatus,
      lastSuccessfulPurchase: lastSuccess?.startedAt || null,
      lastFailedPurchase: lastFail?.startedAt || null,
      lastProviderError: lastFail?.errorMessage || null,
      lastSyncAt: p.lastSyncAt,
      catalogPackageCount: p.providerPackages.length,
      purchaseReadyCount: readyPackages.length,
      alertCount: alerts.length,
      alerts,
    })
  }

  return results
}

export async function getProviderDiagnosticsDetail(providerId: string): Promise<ProviderDiagnosticDetail | null> {
  const p = await prisma.provider.findUnique({
    where: { id: providerId },
    include: {
      providerPackages: { orderBy: { name: 'asc' } },
    },
  })
  if (!p) return null

  const caps = (p.enabledCapabilities || []) as string[]
  const hasPurchase = caps.includes('PURCHASE')
  const operational = ['ACTIVE', 'DEGRADED', 'TESTING'].includes(p.status)
  const cfg = (p.config as any) || {}
  const circuit = cfg.circuitBreaker || {}
  const balance = cfg.balanceSnapshot || {}

  // Attempts
  const attempts = await prisma.providerAttempt.findMany({
    where: { providerId: p.id, source: 'PURCHASE' },
    orderBy: { startedAt: 'desc' },
    take: 20,
  })

  const lastAttempt = attempts[0]
  const lastFail = attempts.find(a => a.status === 'FAILED')

  // Package stats
  const configured = p.providerPackages.filter(pp => ['CONFIGURED', 'AUTO_CONFIGURED'].includes(pp.configurationStatus || ''))
  const published = configured.filter(pp => pp.publishStatus === 'PUBLISHED')
  const readyCount = published.filter(pp =>
    pp.sellingPrice && Number(pp.sellingPrice) > 0 &&
    pp.activePriceSnapshotId
  )
  const blockedPricing = published.filter(pp => !pp.sellingPrice || Number(pp.sellingPrice) <= 0)
  const blockedSnapshot = published.filter(pp => !pp.activePriceSnapshotId)
  const blockedCost = configured.filter(pp => pp.costStatus && !['VALID', 'OVERRIDDEN'].includes(pp.costStatus))

  // Travel date
  const travelDatePkgs = p.providerPackages.filter(pp =>
    pp.travelDateRequirement === 'REQUIRED' || pp.travelDateRequirement === 'OPTIONAL'
  )
  const travelDateRequired = travelDatePkgs.length > 0

  // Checks
  const checks: DiagnosticCheck[] = [
    { name: 'PURCHASE capability', status: hasPurchase ? 'PASS' : 'FAIL', message: hasPurchase ? 'Enabled' : 'Not in enabledCapabilities' },
    { name: 'Provider operational', status: operational ? 'PASS' : 'FAIL', message: `Status: ${p.status}` },
    { name: 'Auth configured', status: p.apiToken ? 'PASS' : 'WARN', message: p.apiToken ? 'Token present' : 'No token configured' },
    { name: 'Circuit state', status: circuit.state === 'OPEN' ? 'FAIL' : circuit.state === 'HALF_OPEN' ? 'WARN' : 'PASS', message: circuit.state || 'CLOSED' },
    { name: 'Balance known', status: balance.balance != null ? 'PASS' : 'WARN', message: balance.balance != null ? `${balance.balance} ${balance.currency || ''}` : 'Unknown' },
    { name: 'Purchase-ready packages', status: readyCount.length > 0 ? 'PASS' : 'WARN', message: `${readyCount.length} ready` },
    { name: 'Catalog synced', status: p.lastSyncAt ? 'PASS' : 'WARN', message: p.lastSyncAt ? `Last: ${p.lastSyncAt.toISOString()}` : 'Never synced' },
  ]

  // Alerts
  const alerts: AlertItem[] = []
  if (circuit.state === 'OPEN') alerts.push({ code: 'CIRCUIT_OPEN', severity: 'DEGRADED', message: 'Circuit breaker open' })
  if (balance.latestError) alerts.push({ code: 'PROVIDER_LOW_BALANCE', severity: 'DEGRADED', message: balance.latestError })
  if (!hasPurchase) alerts.push({ code: 'NO_PURCHASE_CAPABILITY', severity: 'DEGRADED', message: 'PURCHASE not supported' })
  if (readyCount.length === 0) alerts.push({ code: 'NO_PURCHASE_READY_PACKAGES', severity: 'DEGRADED', message: 'No purchase-ready configured packages' })

  // Severity
  const severity: SeverityLevel = alerts.some(a => a.severity === 'DEGRADED') ? 'DEGRADED'
    : !operational ? 'OFFLINE'
    : readyCount.length > 0 ? 'HEALTHY'
    : 'DEGRADED'

  // Purchase verdict + recommendations + failure classification
  const balanceMsg = (balance.latestError || '').toLowerCase()
  const hasBalanceErr = balanceMsg.includes('na') || (balance.latestError ? true : false)
  const hasBundleErr = lastFail?.errorMessage?.toLowerCase().includes('bundle code not found') ?? false

  const purchaseVerdict = computePurchaseVerdict({
    operational, hasPurchase, circuitOpen: circuit.state === 'OPEN',
    authConfigured: !!(p.apiToken || cfg.apiToken || cfg.username),
    readyPackages: readyCount.length,
    recentFailures: attempts.filter(a => a.status === 'FAILED').length,
    hasBalanceError: hasBalanceErr,
    hasBundleError: hasBundleErr,
  })

  const recommendations: RecommendedAction[] = []
  for (const alert of alerts) {
    const act = RECOMMENDED_ACTIONS[alert.code]
    if (act && !recommendations.find(r => r.code === alert.code)) {
      recommendations.push({ code: alert.code, action: act })
    }
  }

  const failureCategories = getFailureCategories(attempts.map(a => ({ errorMessage: a.errorMessage, status: a.status, startedAt: a.startedAt })))

  // Webhook
  const webhookEvents = await prisma.providerWebhookEvent.count({
    where: { providerId: p.id, status: 'FAILED' },
  }).catch(() => 0)

  return {
    id: p.id, name: p.name, code: p.code, adapterStrategy: p.adapterStrategy,
    type: p.type, status: p.status, environment: p.environment, enabledCapabilities: caps, severity,
    verdict: purchaseVerdict.verdict, verdictReason: purchaseVerdict.reason,
    alerts, recommendations, failureCategories,

    auth: {
      configured: !!(p.apiToken || cfg.apiToken || cfg.username),
      strategy: p.authType || 'bearer_token',
      lastConnectionTest: p.lastSuccessfulConnection,
      lastAuthFailure: p.lastFailedConnection,
    },

    purchase: {
      capability: hasPurchase,
      operational,
      circuitState: circuit.state || 'CLOSED',
      configuredPackages: configured.length,
      purchaseReadyPackages: readyCount.length,
      blockedPackages: blockedPricing.length + blockedSnapshot.length + blockedCost.length,
      purchaseEndpointConfigured: !!(p.activationPath || p.activationPath !== undefined),
      travelDateRequired,
      travelDatePresenceRate: 0,
      checks,
    },

    balance: {
      known: balance.balance != null,
      currency: balance.currency || null,
      lastRefresh: balance.fetchedAt || null,
      lowBalance: balance.latestError ? true : false,
      latestError: balance.latestError || null,
    },

    catalog: {
      total: p.providerPackages.length,
      configured: configured.length,
      published: published.length,
      purchaseReady: readyCount.length,
      blockedByPricing: blockedPricing.length,
      blockedByCost: blockedCost.length,
      blockedBySnapshot: blockedSnapshot.length,
      blockedByProvider: 0,
      staleBundles: 0,
    },

    recentAttempts: attempts.map(a => ({
      orderId: a.orderId, attemptNumber: a.attemptNumber, timestamp: a.startedAt,
      success: a.status === 'SUCCEEDED', duration: a.latencyMs,
      errorCode: a.errorCode, errorMessage: a.errorMessage?.substring(0, 150) || null,
      retryable: a.retryClassification === 'RETRYABLE', status: a.status,
    })),

    lastRequest: {
      endpointPath: p.activationPath || null,
      method: 'POST',
      fieldsSent: [],
      authPresent: !!(p.apiToken || cfg.apiToken),
      travelDatePresent: false,
      planIdPresent: true,
      orderIdPresent: true,
    },

    lastResponse: {
      httpStatus: null,
      result: lastAttempt?.status || null,
      errorCode: lastAttempt?.errorCode || null,
      message: lastAttempt?.errorMessage?.substring(0, 200) || null,
      retryClass: lastAttempt?.retryClassification || null,
      reconciliationRequired: lastAttempt?.status === 'PROCESSING',
    },

    travelDate: {
      required: travelDateRequired,
      defaultPolicy: p.providerPackages[0]?.activationPolicy || null,
      defaultRequirement: p.providerPackages[0]?.travelDateRequirement || null,
      lastResolved: null,
      policyMatches: travelDatePkgs.length,
      policyMismatches: 0,
    },

    circuit: {
      state: circuit.state || 'CLOSED',
      failureCount: (p.errorCount as number) || 0,
      openedAt: circuit.openedAt || null,
      nextProbeAt: null,
      failoverEligible: operational && hasPurchase && circuit.state !== 'OPEN',
    },

    webhooks: {
      configured: caps.includes('WEBHOOKS') || caps.includes('SMS_MT'),
      lastEventReceived: null,
      lastProcessResult: null,
      failedCount: webhookEvents,
      queueCount: 0,
    },
  }
}

export type PurchaseVerdict = 'READY' | 'DEGRADED' | 'BLOCKED' | 'UNKNOWN'

export interface FailureCategory {
  category: string
  count1h: number
  count24h: number
  count7d: number
}

export interface RecommendedAction {
  code: string
  action: string
}

export const RECOMMENDED_ACTIONS: Record<string, string> = {
  PROVIDER_BALANCE_UNAVAILABLE: 'Refresh provider balance and confirm funding status with the provider.',
  PROVIDER_BALANCE_REJECTED: 'Provider rejected purchase due to balance. Top up provider account or route to another eligible provider.',
  PROVIDER_LOW_BALANCE: 'Top up provider account or route to another eligible provider.',
  BUNDLE_CODE_NOT_FOUND: 'Resync Choice catalog and validate the mapped bundle identifier against available templates.',
  TRAVEL_DATE_MISMATCH: 'Review provider travel-date policy configuration.',
  CIRCUIT_OPEN: 'Wait for recovery probe or manually review provider health to close circuit.',
  NO_PURCHASE_READY_PACKAGES: 'Review provider catalog configuration and pricing. Ensure packages are published with valid snapshots.',
  AUTH_FAILURE: 'Review and update provider authentication credentials.',
  STALE_CATALOG: 'Run provider catalog sync to refresh available plans.',
  PROVIDER_OFFLINE: 'Check provider status and connectivity.',
  INVENTORY_LOW: 'Review provider SIM inventory levels.',
  WEBHOOK_FAILURES: 'Investigate webhook processing pipeline.',
}

export function computePurchaseVerdict(params: {
  operational: boolean
  hasPurchase: boolean
  circuitOpen: boolean
  authConfigured: boolean
  readyPackages: number
  recentFailures: number
  hasBalanceError: boolean
  hasBundleError: boolean
}): { verdict: PurchaseVerdict; reason: string } {
  if (!params.hasPurchase) return { verdict: 'BLOCKED', reason: 'Provider does not support PURCHASE capability' }
  if (!params.operational) return { verdict: 'BLOCKED', reason: 'Provider is not operational' }
  if (params.circuitOpen) return { verdict: 'BLOCKED', reason: 'Circuit breaker is OPEN' }
  if (params.readyPackages === 0) return { verdict: 'BLOCKED', reason: 'No purchase-ready packages configured' }
  if (!params.authConfigured) return { verdict: 'BLOCKED', reason: 'Authentication not configured' }

  if (params.hasBalanceError || params.hasBundleError) {
    const reasons: string[] = []
    if (params.hasBalanceError) reasons.push('balance issue')
    if (params.hasBundleError) reasons.push('bundle mapping issue')
    return { verdict: 'DEGRADED', reason: `Purchase may fail: ${reasons.join(', ')}` }
  }

  if (params.recentFailures > 0) return { verdict: 'DEGRADED', reason: `${params.recentFailures} recent purchase failure(s)` }

  return { verdict: 'READY', reason: 'All purchase checks passed' }
}

export function classifyFailureMessage(msg: string | null | undefined): string {
  if (!msg) return 'UNKNOWN'
  const m = msg.toLowerCase()
  if (m.includes('reconcil') || m.includes('uncertain')) return 'RECONCILIATION'
  if (m.includes('validation') || m.includes('invalid') || m.includes('required') || m.includes('mandatory')) return 'VALIDATION'
  if (m.includes('auth') || m.includes('unauthorized') || m.includes('token') || m.includes('credential')) return 'AUTH'
  if (m.includes('balance') || m.includes('insufficient') || m.includes('wallet') || m.includes('fund')) return 'BALANCE'
  if (m.includes('bundle') || m.includes('template') || m.includes('not found') || m.includes('sku')) return 'BUNDLE_MAPPING'
  if (m.includes('inventory') || m.includes('stock') || m.includes('sim') || m.includes('iccid')) return 'INVENTORY'
  if (m.includes('rate') || m.includes('limit') || m.includes('throttle')) return 'RATE_LIMIT'
  if (m.includes('network') || m.includes('connection') || m.includes('refused') || m.includes('dns')) return 'NETWORK'
  if (m.includes('timeout') || m.includes('timed out')) return 'TIMEOUT'
  if (m.includes('reconcil') || m.includes('uncertain')) return 'RECONCILIATION'
  if (m.includes('provider') || m.includes('server error') || m.includes('internal')) return 'PROVIDER_ERROR'
  return 'UNKNOWN'
}

export function getFailureCategories(attempts: { errorMessage?: string | null; status?: string | null; startedAt: Date }[]): FailureCategory[] {
  const now = Date.now()
  const h1 = now - 3600000
  const h24 = now - 86400000
  const d7 = now - 604800000

  const failures = attempts.filter(a => a.status === 'FAILED')
  const cats = new Map<string, { count1h: number; count24h: number; count7d: number }>()

  for (const a of failures) {
    const cat = classifyFailureMessage(a.errorMessage)
    if (!cats.has(cat)) cats.set(cat, { count1h: 0, count24h: 0, count7d: 0 })
    const c = cats.get(cat)!
    const t = new Date(a.startedAt).getTime()
    if (t >= h1) c.count1h++
    if (t >= h24) c.count24h++
    if (t >= d7) c.count7d++
  }

  return Array.from(cats.entries()).map(([category, counts]) => ({ category, ...counts }))
}

export interface ChoiceBundleValidationResult {
  totalPackages: number
  validMappings: number
  invalidMappings: number
  staleMappings: number
  missingIdentifiers: number
  rows: {
    packageName: string
    providerPackageId: string
    providerPlanCode: string | null
    identifierPresent: boolean
    lastSuccessfulPurchase: Date | null
    lastFailure: string | null
    status: 'VALID' | 'INVALID' | 'MISSING' | 'UNKNOWN'
  }[]
}

export async function validateChoiceBundleMappings(providerId: string): Promise<ChoiceBundleValidationResult> {
  const plans = await prisma.providerPackage.findMany({
    where: { providerId, configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] } },
    include: {
      provider: { select: { lastSyncResult: true } },
    },
    orderBy: { name: 'asc' },
  })

  // Look for the bundle identifier field: providerPlanCode is used as the identifier
  // in the Choice connector's syncPlans (maps to bundle_template_id)
  const rows = await Promise.all(plans.map(async pp => {
    const identifier = pp.providerPlanCode
    const identifierPresent = !!(identifier && identifier.trim())
    const lastAttempt = await prisma.providerAttempt.findFirst({
      where: { providerId, source: 'PURCHASE', errorMessage: { contains: 'Bundle code not found' } },
      orderBy: { startedAt: 'desc' },
    })
    const lastSuccess = await prisma.providerAttempt.findFirst({
      where: { providerId, source: 'PURCHASE', status: 'SUCCEEDED' },
      orderBy: { startedAt: 'desc' },
    })

    const status: 'VALID' | 'INVALID' | 'MISSING' | 'UNKNOWN' =
      !identifierPresent ? 'MISSING'
      : lastAttempt ? 'INVALID'
      : identifierPresent ? 'UNKNOWN'
      : 'MISSING'

    return {
      packageName: pp.name,
      providerPackageId: pp.id,
      providerPlanCode: identifier,
      identifierPresent,
      lastSuccessfulPurchase: lastSuccess?.startedAt || null,
      lastFailure: lastAttempt?.errorMessage?.substring(0, 150) || null,
      status,
    }
  }))

  return {
    totalPackages: plans.length,
    validMappings: rows.filter(r => r.status !== 'INVALID' && r.status !== 'MISSING').length,
    invalidMappings: rows.filter(r => r.status === 'INVALID').length,
    staleMappings: 0,
    missingIdentifiers: rows.filter(r => r.status === 'MISSING').length,
    rows,
  }
}
