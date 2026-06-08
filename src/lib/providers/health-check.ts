import { prisma } from '@/lib/prisma'
import { getAdapterForProvider } from '@/lib/providers/adapter-manager'

export interface HealthCheckResult {
  providerId: string
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN'
  responseTimeMs: number
  successRate: number
  failureCount: number
  consecutiveFailures: number
  metadata: any
}

export async function checkProviderHealth(providerId: string): Promise<HealthCheckResult> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) throw new Error(`Provider ${providerId} not found`)

  const metadata: any = {}
  const startTime = Date.now()
  let errors = 0
  let checks = 0

  // Test 1: Auth/connection test
  try {
    const adapter = await getAdapterForProvider(providerId)
    if (adapter) {
      const result = await adapter.testConnection()
      checks++
      if (!result.success) {
        errors++
        metadata.testConnectionError = result.error?.message
      }
    }
  } catch (e: any) {
    errors++
    checks++
    metadata.testConnectionError = e.message
  }

  // Test 2: Sync plans (catalog endpoint)
  try {
    const adapter = await getAdapterForProvider(providerId)
    if (adapter) {
      const result = await adapter.syncPlans()
      checks++
      if (!result.success) {
        errors++
        metadata.syncPlansError = result.error?.message
      }
    }
  } catch (e: any) {
    errors++
    checks++
    metadata.syncPlansError = e.message
  }

  const totalTime = Date.now() - startTime
  const successRate = checks > 0 ? ((checks - errors) / checks) * 100 : 0

  // Get recent history for scoring
  const recentSnapshots = await prisma.providerHealthSnapshot.findMany({
    where: { providerId },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })

  const recentFailures = recentSnapshots.filter(s => s.status === 'DOWN' || s.status === 'DEGRADED').length
  const consecutiveFailures = errors > 0 ? (recentSnapshots[0]?.consecutiveFailures || 0) + errors : 0

  let status: 'HEALTHY' | 'DEGRADED' | 'DOWN'

  if (errors >= checks || totalTime > 10000) {
    status = 'DOWN'
  } else if (successRate < 70 || totalTime > 5000 || consecutiveFailures >= 3) {
    status = 'DOWN'
  } else if (successRate < 95 || totalTime > 2000) {
    status = 'DEGRADED'
  } else {
    status = 'HEALTHY'
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
  await prisma.provider.update({
    where: { id: providerId },
    data: {
      activationSuccessRate: successRate,
      lastSyncAt: new Date(),
      ...(status === 'DOWN' || status === 'DEGRADED' ? {
        lastFailedConnection: new Date(),
        errorCount: { increment: errors },
        lastError: metadata.testConnectionError || metadata.syncPlansError || null,
      } : {
        lastSuccessfulConnection: new Date(),
      }),
    },
  })

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