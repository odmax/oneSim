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
  alerts: AlertItem[]

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

    if (balance.latestError) {
      severity = severity === 'HEALTHY' ? 'DEGRADED' : severity
      alerts.push({ code: 'PROVIDER_LOW_BALANCE', severity: 'DEGRADED', message: `Balance: ${balance.latestError}`.substring(0, 120) })
    }
    if (circuitState === 'OPEN') {
      severity = severity === 'HEALTHY' ? 'DEGRADED' : severity
      alerts.push({ code: 'CIRCUIT_OPEN', severity: 'DEGRADED', message: `Circuit breaker open since ${circuit.openedAt || 'unknown'}` })
    }
    if (!hasPurchase) {
      alerts.push({ code: 'NO_PURCHASE_CAPABILITY', severity: 'DEGRADED', message: 'Provider does not support PURCHASE' })
    }

    results.push({
      id: p.id, name: p.name, code: p.code, adapterStrategy: p.adapterStrategy,
      type: p.type, status: p.status, severity, operational, hasPurchaseCapability: hasPurchase,
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

  // Webhook
  const webhookEvents = await prisma.providerWebhookEvent.count({
    where: { providerId: p.id, status: 'FAILED' },
  }).catch(() => 0)

  return {
    id: p.id, name: p.name, code: p.code, adapterStrategy: p.adapterStrategy,
    type: p.type, status: p.status, environment: p.environment, enabledCapabilities: caps, severity, alerts,

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
