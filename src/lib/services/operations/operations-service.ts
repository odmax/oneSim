import { prisma } from '@/lib/prisma'

export interface OpsMetrics {
  providers: { total: number; online: number; offline: number; healthPct: number }
  jobs: { total: number; running: number; queued: number; failed: number }
  orders: { today: number; successful: number; failed: number; successRate: number }
  latency: { avgActivationMs: number | null; avgResponseMs: number | null }
  routing: { totalDecisions: number; avgCandidates: number }
  failover: { total: number; successful: number; retryableFailures: number }
  alerts: { total: number; active: number }
}

export interface ProviderHealthRow {
  id: string; code: string; name: string; status: string
  healthScore: number; errorCount: number
  lastSuccess: Date | null; lastFailure: Date | null
  balance: string | null
  activations: number; successRate: number | null; avgLatency: number | null
}

export interface JobAnalytics {
  byType: Record<string, number>
  byStatus: Record<string, number>
  avgRuntimeMs: number | null
  retryRate: number
}

export interface AlertItem {
  id: string; type: string; severity: 'info' | 'warning' | 'critical'
  providerId?: string; providerCode?: string
  message: string; createdAt: Date; acknowledgedAt?: Date
}

export async function getJobAnalytics(): Promise<JobAnalytics> {
  const jobs = await prisma.backgroundJob.findMany({
    select: { type: true, status: true }, take: 1000,
  }).catch(() => [])

  const byType: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  for (const j of jobs) {
    byType[j.type] = (byType[j.type] || 0) + 1
    byStatus[j.status] = (byStatus[j.status] || 0) + 1
  }

  const failed = byStatus['FAILED'] || 0
  const total = jobs.length
  return { byType, byStatus, avgRuntimeMs: null, retryRate: total ? Math.round((failed / total) * 100) : 0 }
}

export async function getCatalogAnalytics() {
  const [byConfig, byPublish, total] = await Promise.all([
    prisma.providerPackage.groupBy({ by: ['configurationStatus'], _count: true }).catch(() => []),
    prisma.providerPackage.groupBy({ by: ['publishStatus'], _count: true }).catch(() => []),
    prisma.providerPackage.count().catch(() => 0),
  ])

  const configCounts: Record<string, number> = {}
  for (const g of byConfig) configCounts[g.configurationStatus || 'UNKNOWN'] = g._count
  const publishCounts: Record<string, number> = {}
  for (const g of byPublish) publishCounts[g.publishStatus || 'UNKNOWN'] = g._count

  return { total, configCounts, publishCounts }
}

export function generateAlerts(metrics: OpsMetrics, providers: ProviderHealthRow[]): AlertItem[] {
  const alerts: AlertItem[] = []
  const now = new Date()

  for (const p of providers) {
    if (p.status === 'INACTIVE' || p.status === 'MAINTENANCE') {
      alerts.push({ id: `p-${p.id}-inactive`, type: 'PROVIDER_OFFLINE', severity: 'warning', providerId: p.id, providerCode: p.code, message: `${p.name} is ${p.status}`, createdAt: now })
    }
    if (p.healthScore < 30) {
      alerts.push({ id: `p-${p.id}-critical`, type: 'PROVIDER_HEALTH_CRITICAL', severity: 'critical', providerId: p.id, providerCode: p.code, message: `${p.name} health score is ${p.healthScore}%`, createdAt: now })
    }
    if (p.errorCount > 10) {
      alerts.push({ id: `p-${p.id}-errors`, type: 'PROVIDER_HIGH_ERRORS', severity: 'warning', providerId: p.id, providerCode: p.code, message: `${p.name} has ${p.errorCount} consecutive errors`, createdAt: now })
    }
  }

  if (metrics.jobs.failed > 5) {
    alerts.push({ id: 'jobs-failed', type: 'JOB_FAILURE_SPIKE', severity: 'warning', message: `${metrics.jobs.failed} failed background jobs`, createdAt: now })
  }

  return alerts
}

export async function getOpsMetrics(): Promise<OpsMetrics> {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const [providers, activeProviders, jobs, runningJobs, queuedJobs, failedJobs,
    todayOrders, successfulOrders, failedOrders, avgLatency, avgResLatency,
    attemptCount, routingCount] = await Promise.all([
    prisma.provider.count().catch(() => 0),
    prisma.provider.count({ where: { status: { in: ['ACTIVE', 'TESTING'] } } }).catch(() => 0),
    prisma.backgroundJob.count().catch(() => 0),
    prisma.backgroundJob.count({ where: { status: 'PROCESSING' } as any }).catch(() => 0),
    prisma.backgroundJob.count({ where: { status: 'PENDING' } as any }).catch(() => 0),
    prisma.backgroundJob.count({ where: { status: 'FAILED' } as any }).catch(() => 0),
    prisma.eSIMPurchase.count({ where: { createdAt: { gte: todayStart } } }).catch(() => 0),
    prisma.eSIMPurchase.count({ where: { status: 'FULFILLED' } }).catch(() => 0),
    prisma.eSIMPurchase.count({ where: { status: 'FAILED' } }).catch(() => 0),
    prisma.provider.aggregate({ _avg: { averageActivationTimeMs: true } }).catch(() => ({ _avg: { averageActivationTimeMs: null } })),
    prisma.provider.aggregate({ _avg: { averageActivationTimeMs: true } }).catch(() => ({ _avg: { averageActivationTimeMs: null } })),
    prisma.providerAttempt.count().catch(() => 0),
    prisma.providerAttempt.count({ where: { source: 'PURCHASE' } }).catch(() => 0),
  ])

  return {
    providers: { total: providers, online: activeProviders, offline: providers - activeProviders, healthPct: providers ? Math.round((activeProviders / providers) * 100) : 0 },
    jobs: { total: jobs, running: runningJobs, queued: queuedJobs, failed: failedJobs },
    orders: { today: todayOrders, successful: successfulOrders, failed: failedOrders, successRate: successfulOrders + failedOrders > 0 ? Math.round((successfulOrders / (successfulOrders + failedOrders)) * 100) : 100 },
    latency: { avgActivationMs: avgLatency._avg?.averageActivationTimeMs ?? null, avgResponseMs: avgResLatency._avg?.averageActivationTimeMs ?? null },
    routing: { totalDecisions: routingCount, avgCandidates: attemptCount > 0 ? Math.round((attemptCount / (routingCount || 1)) * 10) / 10 : 0 },
    failover: { total: attemptCount > 1 ? attemptCount - routingCount : 0, successful: 0, retryableFailures: 0 },
    alerts: { total: 0, active: 0 },
  }
}

export async function getProviderHealthList(): Promise<ProviderHealthRow[]> {
  const providers = await prisma.provider.findMany({
    where: { status: { not: 'ARCHIVED' } },
    orderBy: { status: 'asc' },
    select: {
      id: true, code: true, name: true, status: true,
      errorCount: true, lastSuccessfulConnection: true, lastFailedConnection: true,
      activationSuccessRate: true, averageActivationTimeMs: true, config: true,
    },
  })

  return providers.map(p => {
    const errCount = p.errorCount || 0
    const healthScore = errCount === 0 ? 100 : errCount > 10 ? 20 : errCount > 5 ? 50 : 70
    const cfg = (p.config as any) || {}
    const balSnap = cfg.balanceSnapshot
    const balance = balSnap ? `${(balSnap.balance ?? '?')} ${balSnap.currency || ''}` : null

    return {
      id: p.id, code: p.code || '', name: p.name, status: p.status,
      healthScore, errorCount: errCount,
      lastSuccess: p.lastSuccessfulConnection, lastFailure: p.lastFailedConnection,
      balance,
      activations: 0,
      successRate: p.activationSuccessRate ? Math.round(Number(p.activationSuccessRate) * 100) : null,
      avgLatency: p.averageActivationTimeMs ? Number(p.averageActivationTimeMs) : null,
    }
  })
}
