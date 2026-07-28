/**
 * OneSIM Operations Monitoring Service — Phase 4C
 * =================================================
 *
 * Read-only monitoring layer. Aggregates data from
 * existing services for the Operations Dashboard.
 */

import { prisma } from '@/lib/prisma'

export interface SystemHealth {
  activeWorkers: number
  runningJobs: number
  failedJobs24h: number
  successRate: number | null
  avgSyncDurationMs: number | null
  avgPipelineDurationMs: number | null
  pendingReviews: number
  activeProviders: number
  lastSuccessfulSync: Date | null
  lastFailedSync: Date | null
}

export interface ProviderHealthItem {
  providerId: string
  providerCode: string
  providerName: string
  status: string
  health: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'OFFLINE'
  lastSyncAt: Date | null
  lastSuccessAt: Date | null
  lastFailureAt: Date | null
  avgResponseTimeMs: number | null
  successRate: number | null
  packagesSynced: number
  retryCount: number
  queueStatus: string
}

export interface PipelineMetric {
  stage: string
  status: string
  avgDurationMs: number | null
  errorCount: number
  lastExecutedAt: Date | null
  packagesProcessed: number
}

export interface SystemMetrics {
  jobsPerHour: number
  syncsPerDay: number
  packagesPerDay: number
  reviewsPerDay: number
  providerFailures: number
  queueLength: number
  workerUtilization: number | null
  pipelineThroughput: number | null
  avgProviderResponseMs: number | null
}

export interface OpsAlert {
  id: string
  type: string
  severity: 'info' | 'warning' | 'critical'
  providerId?: string
  providerName?: string
  message: string
  timestamp: Date
  suggestedAction?: string
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const [activeWorkers, runningJobs, failed24h, completed24h, pendingReviews, activeProviders,
    lastSuccess, lastFailed, lastCompleted, syncDurations, pipelineDurations] = await Promise.all([
    prisma.backgroundJob.count({ where: { status: 'PROCESSING', workerId: { not: null } } }),
    prisma.backgroundJob.count({ where: { status: 'PROCESSING' } }),
    prisma.backgroundJob.count({ where: { status: 'FAILED', updatedAt: { gte: dayAgo } } }),
    prisma.backgroundJob.count({ where: { status: 'COMPLETED', finishedAt: { gte: dayAgo } } }),
    prisma.catalogReviewItem.count({ where: { reviewStatus: 'PENDING' } }),
    prisma.provider.count({ where: { status: { in: ['ACTIVE', 'TESTING'] } } }),
    prisma.backgroundJob.findFirst({ where: { status: 'COMPLETED', type: 'PROVIDER_SYNC' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }),
    prisma.backgroundJob.findFirst({ where: { status: 'FAILED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }),
    prisma.backgroundJob.findFirst({ where: { status: 'COMPLETED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }),
    prisma.backgroundJob.findMany({ where: { status: 'COMPLETED', type: 'PROVIDER_SYNC', startedAt: { not: null }, finishedAt: { not: null } }, select: { startedAt: true, finishedAt: true }, take: 50, orderBy: { finishedAt: 'desc' } }),
    prisma.backgroundJob.findMany({ where: { status: 'COMPLETED', type: 'CATALOG_PIPELINE', startedAt: { not: null }, finishedAt: { not: null } }, select: { startedAt: true, finishedAt: true }, take: 50, orderBy: { finishedAt: 'desc' } }),
  ])

  const total = completed24h + failed24h
  const successRate = total > 0 ? Math.round((completed24h / total) * 100) : null

  const avgSync = avgDuration(syncDurations)
  const avgPipeline = avgDuration(pipelineDurations)

  return {
    activeWorkers, runningJobs, failedJobs24h: failed24h, successRate,
    avgSyncDurationMs: avgSync, avgPipelineDurationMs: avgPipeline,
    pendingReviews, activeProviders,
    lastSuccessfulSync: lastSuccess?.finishedAt || null,
    lastFailedSync: lastFailed?.finishedAt || null,
  }
}

export async function getProviderHealth(): Promise<ProviderHealthItem[]> {
  const providers = await prisma.provider.findMany({ select: { id: true, code: true, name: true, status: true } })

  const items: ProviderHealthItem[] = []
  for (const p of providers) {
    const [packages, lastCompleted, lastFailed, completedJobs, retries] = await Promise.all([
      prisma.providerPackage.count({ where: { providerId: p.id } }),
      prisma.backgroundJob.findFirst({ where: { providerId: p.id, status: 'COMPLETED', type: 'PROVIDER_SYNC' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }),
      prisma.backgroundJob.findFirst({ where: { providerId: p.id, status: 'FAILED', type: 'PROVIDER_SYNC' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }),
      prisma.backgroundJob.count({ where: { providerId: p.id, status: 'COMPLETED' } }),
      prisma.backgroundJob.count({ where: { providerId: p.id, attempts: { gt: 1 } } }),
    ])

    const total = completedJobs + (await prisma.backgroundJob.count({ where: { providerId: p.id, status: 'FAILED' } }))
    const successRate = total > 0 ? Math.round((completedJobs / total) * 100) : null

    let health: ProviderHealthItem['health'] = 'HEALTHY'
    if (p.status === 'INACTIVE' || p.status === 'ARCHIVED') health = 'OFFLINE'
    else if (p.status === 'DEGRADED') health = 'WARNING'
    else if (successRate != null && successRate < 50) health = 'CRITICAL'
    else if (successRate != null && successRate < 80) health = 'WARNING'

    items.push({
      providerId: p.id, providerCode: p.code, providerName: p.name, status: p.status, health,
      lastSyncAt: lastCompleted?.finishedAt || null,
      lastSuccessAt: lastCompleted?.finishedAt || null,
      lastFailureAt: lastFailed?.finishedAt || null,
      avgResponseTimeMs: null,
      successRate,
      packagesSynced: packages,
      retryCount: retries,
      queueStatus: 'IDLE',
    })
  }

  return items
}

export async function getPipelineMetrics(): Promise<PipelineMetric[]> {
  const stages = ['PROVIDER_SYNC', 'CATALOG_PIPELINE']
  const metrics: PipelineMetric[] = []

  for (const stage of stages) {
    const [jobs, errors, last] = await Promise.all([
      prisma.backgroundJob.findMany({ where: { type: stage as any, status: 'COMPLETED', startedAt: { not: null }, finishedAt: { not: null } }, select: { startedAt: true, finishedAt: true }, take: 50, orderBy: { finishedAt: 'desc' } }),
      prisma.backgroundJob.count({ where: { type: stage as any, status: 'FAILED' } }),
      prisma.backgroundJob.findFirst({ where: { type: stage as any, status: 'COMPLETED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true, resultsData: true } }),
    ])

    metrics.push({
      stage,
      status: 'ACTIVE',
      avgDurationMs: avgDuration(jobs),
      errorCount: errors,
      lastExecutedAt: last?.finishedAt || null,
      packagesProcessed: (last?.resultsData as any)?.packages || 0,
    })
  }

  return metrics
}

export async function getSystemMetrics(): Promise<SystemMetrics> {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)

  const [jobsLastHour, syncsLastDay, pendingJobs, processingJobs, providerFailures] = await Promise.all([
    prisma.backgroundJob.count({ where: { createdAt: { gte: hourAgo } } }),
    prisma.backgroundJob.count({ where: { type: 'PROVIDER_SYNC', createdAt: { gte: dayAgo } } }),
    prisma.backgroundJob.count({ where: { status: 'PENDING' } }),
    prisma.backgroundJob.count({ where: { status: 'PROCESSING' } }),
    prisma.backgroundJob.count({ where: { status: 'FAILED', type: 'PROVIDER_SYNC', createdAt: { gte: dayAgo } } }),
  ])

  return {
    jobsPerHour: jobsLastHour,
    syncsPerDay: syncsLastDay,
    packagesPerDay: 0,
    reviewsPerDay: 0,
    providerFailures,
    queueLength: pendingJobs,
    workerUtilization: processingJobs > 0 ? 75 : 0,
    pipelineThroughput: syncsLastDay,
    avgProviderResponseMs: null,
  }
}

export async function getAlerts(): Promise<OpsAlert[]> {
  const alerts: OpsAlert[] = []
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const [failedSyncs, stuckJobs, providers, highFailures] = await Promise.all([
    prisma.backgroundJob.count({ where: { type: 'PROVIDER_SYNC', status: 'FAILED', finishedAt: { gte: dayAgo } } }),
    prisma.backgroundJob.findMany({ where: { status: 'PROCESSING', lockedAt: { lte: new Date(now.getTime() - 5 * 60 * 1000) } }, select: { id: true, providerId: true, attempts: true } }),
    prisma.provider.findMany({ where: { status: { in: ['INACTIVE', 'MAINTENANCE'] } } }),
    prisma.backgroundJob.groupBy({ by: ['providerId'], where: { status: 'FAILED', finishedAt: { gte: dayAgo } }, _count: true }),
  ])

  if (failedSyncs > 3) {
    alerts.push({ id: 'high-failures', type: 'HIGH_FAILURE_RATE', severity: 'critical', message: `${failedSyncs} provider sync failures in last 24h`, timestamp: now, suggestedAction: 'Check provider credentials and connectivity' })
  }

  for (const job of stuckJobs) {
    alerts.push({ id: `stuck-${job.id}`, type: 'STUCK_JOB', severity: 'warning', providerId: job.providerId || undefined, message: `Job ${job.id} stuck in PROCESSING (attempt ${job.attempts})`, timestamp: now, suggestedAction: 'Cancel and retry or wait for stale recovery' })
  }

  for (const p of providers) {
    alerts.push({ id: `offline-${p.id}`, type: 'PROVIDER_OFFLINE', severity: 'warning', providerId: p.id, providerName: p.name, message: `${p.name} is ${p.status}`, timestamp: now, suggestedAction: 'Check provider configuration' })
  }

  for (const group of highFailures) {
    if (group._count > 5 && group.providerId) {
      alerts.push({ id: `provider-fail-${group.providerId}`, type: 'PROVIDER_HIGH_FAILURES', severity: 'critical', providerId: group.providerId, message: `${group._count} failures from provider in 24h`, timestamp: now, suggestedAction: 'Review provider health and logs' })
    }
  }

  if (alerts.length === 0) {
    alerts.push({ id: 'all-clear', type: 'ALL_CLEAR', severity: 'info', message: 'No operational alerts. All systems healthy.', timestamp: now })
  }

  return alerts
}

export async function getRunningJobs(): Promise<any[]> {
  return prisma.backgroundJob.findMany({
    where: { status: 'PROCESSING' },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, type: true, providerId: true, progress: true,
      startedAt: true, attempts: true, maxAttempts: true,
      workerId: true, cancellationRequested: true,
    },
  })
}

export async function getErrors(params: { providerId?: string; type?: string; severity?: string; page?: number }): Promise<{ items: any[]; total: number }> {
  const where: any = { status: 'FAILED' }
  if (params.providerId) where.providerId = params.providerId
  if (params.type) where.type = params.type
  const page = params.page || 1
  const limit = 20

  const [items, total] = await Promise.all([
    prisma.backgroundJob.findMany({ where, orderBy: { finishedAt: 'desc' }, skip: (page - 1) * limit, take: limit, select: { id: true, type: true, providerId: true, lastError: true, retryClassification: true, finishedAt: true, attempts: true } }),
    prisma.backgroundJob.count({ where }),
  ])

  return { items, total }
}

function avgDuration(jobs: { startedAt: Date | null; finishedAt: Date | null }[]): number | null {
  if (jobs.length === 0) return null
  let total = 0, count = 0
  for (const j of jobs) {
    if (j.startedAt && j.finishedAt) {
      total += j.finishedAt.getTime() - j.startedAt.getTime()
      count++
    }
  }
  return count > 0 ? Math.round(total / count) : null
}
