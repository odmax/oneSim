import { prisma } from '@/lib/prisma'
import { buildAdapter, isTemplateDrivenProvider } from '@/lib/providers/adapter-manager'

export interface HealthCheckResult {
  providerId: string
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN'
  responseTimeMs: number
  successRate: number
  failureCount: number
  consecutiveFailures: number
  metadata: any
}

async function getHealthAdapter(provider: any) {
  // Template providers use buildAdapter() which checks isTemplateDrivenProvider
  if (isTemplateDrivenProvider(provider)) {
    return await buildAdapter(provider)
  }
  // Legacy providers use the connector system
  const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
  return await buildConnectorFromProvider(provider.id)
}

export async function checkProviderHealth(providerId: string): Promise<HealthCheckResult> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) throw new Error(`Provider ${providerId} not found`)

  const metadata: any = {}
  const startTime = Date.now()
  let errors = 0
  let checks = 0

  // Test: Auth/connection test using testConnection() which is lightweight
  // Does NOT call syncPlans() — that's a heavy operation for health monitoring
  try {
    const adapter = await getHealthAdapter(provider)
    if (adapter) {
      const result = await adapter.testConnection()
      checks++
      metadata.authPassed = result.success
      if (result.success) {
        metadata.testConnectionMessage = result.data?.message
      } else {
        errors++
        metadata.testConnectionError = result.error?.message
      }
    } else {
      errors++
      checks++
      metadata.testConnectionError = 'No adapter available'
    }
  } catch (e: any) {
    errors++
    checks++
    metadata.testConnectionError = e.message
    metadata.authPassed = false
  }

  const totalTime = Date.now() - startTime
  const successRate = checks > 0 ? ((checks - errors) / checks) * 100 : 0

  // Get recent history for scoring and FAIR consecutive failure tracking
  const recentSnapshots = await prisma.providerHealthSnapshot.findMany({
    where: { providerId },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })

  // Consecutive failures: if current check has errors, add to previous; otherwise RESET to 0
  const prevConsecutive = recentSnapshots[0]?.consecutiveFailures || 0
  const consecutiveFailures = errors > 0 ? prevConsecutive + errors : 0

  let status: 'HEALTHY' | 'DEGRADED' | 'DOWN'

  // Status logic:
  // - DOWN: auth/test fails (errors > 0)
  // - DEGRADED: auth passes but response is slow (> 3000ms)
  // - HEALTHY: auth passes and response is fast (<= 3000ms)
  if (errors > 0 || successRate === 0) {
    status = 'DOWN'
    metadata.statusReason = 'Auth or connection test failed'
  } else if (totalTime > 8000) {
    status = 'DOWN'
    metadata.statusReason = `Response too slow: ${totalTime}ms > 8000ms`
  } else if (totalTime > 3000) {
    status = 'DEGRADED'
    metadata.statusReason = `Slow response: ${totalTime}ms (threshold: 3000ms)`
  } else {
    status = 'HEALTHY'
    metadata.statusReason = 'Auth passed, fast response'
  }

  await prisma.providerHealthSnapshot.create({
    data: {
      providerId,
      status,
      responseTimeMs: totalTime,
      successRate,
      failureCount: errors,
      consecutiveFailures,
      lastCheckAt: new Date(),
      metadata: metadata as any,
    },
  })

  // Update provider health tracking fields
  // Only mark as failed connection if truly DOWN (auth failed), not for DEGRADED
  const updateData: any = {
    activationSuccessRate: successRate,
    lastSyncAt: new Date(),
  }

  if (status === 'DOWN') {
    updateData.lastFailedConnection = new Date()
    updateData.errorCount = { increment: errors }
    updateData.lastError = metadata.testConnectionError || metadata.statusReason || null
  } else {
    // HEALTHY or DEGRADED: still counts as a successful connection
    updateData.lastSuccessfulConnection = new Date()
    if (status === 'DEGRADED') {
      updateData.lastError = metadata.statusReason || null
    }
  }

  await prisma.provider.update({ where: { id: providerId }, data: updateData })

  return { providerId, status, responseTimeMs: totalTime, successRate, failureCount: errors, consecutiveFailures, metadata }
}

export async function getProviderHealthStatus(providerId: string): Promise<{ status: string; responseTimeMs: number | null; successRate: number | null }> {
  const latest = await prisma.providerHealthSnapshot.findFirst({
    where: { providerId },
    orderBy: { createdAt: 'desc' },
  })
  if (!latest) return { status: 'UNKNOWN', responseTimeMs: null, successRate: null }
  return { status: latest.status, responseTimeMs: latest.responseTimeMs, successRate: latest.successRate }
}

export async function checkAllProvidersHealth(): Promise<{ checked: number; healthy: number; degraded: number; down: number }> {
  const providers = await prisma.provider.findMany({
    where: { status: { in: ['ACTIVE', 'DEGRADED', 'TESTING'] } },
  })

  let checked = 0, healthy = 0, degraded = 0, down = 0

  for (const provider of providers) {
    checked++
    try {
      const result = await checkProviderHealth(provider.id)
      if (result.status === 'HEALTHY') healthy++
      else if (result.status === 'DEGRADED') degraded++
      else down++
    } catch {
      down++
    }
  }

  return { checked, healthy, degraded, down }
}
