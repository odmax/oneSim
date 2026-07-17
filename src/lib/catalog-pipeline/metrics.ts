import { prisma } from '@/lib/prisma'
import type { ReasonCounts } from './types'

export function aggregateReasons(reasons: string[]): ReasonCounts {
  const counts: ReasonCounts = {}
  for (const r of reasons) {
    counts[r] = (counts[r] || 0) + 1
  }
  return counts
}

export async function getPipelineSummary(providerId?: string) {
  const where: any = {}
  if (providerId) where.providerId = providerId

  const allRuns = await prisma.catalogPipelineRun.findMany({
    where,
    orderBy: { startedAt: 'desc' },
    take: 100,
    include: { stages: { orderBy: { createdAt: 'asc' } } },
  })

  const lastRun = allRuns[0] || null
  const lastSuccessful = allRuns.find(r => r.status === 'SUCCESS') || null

  // Aggregate stage counts across all runs
  const syncedCount = sumStageTotal(allRuns, 'PROVIDER_SYNC')
  const configuredCount = sumStagePassed(allRuns, 'CONFIGURATION')
  const healthEligibleCount = sumStagePassed(allRuns, 'CATALOG_HEALTH')
  const cheapestWinners = sumStagePassed(allRuns, 'CHEAPEST_SELECTION')
  const readyCount = sumStagePassed(allRuns, 'READY_FOR_PUBLISH')
  const publishedCount = sumStagePassed(allRuns, 'PUBLISH')
  const marketplaceVisibleCount = sumStagePassed(allRuns, 'MARKETPLACE')
  const blockedCount = sumStageFailed(allRuns, 'CATALOG_HEALTH')

  // Most common blocking reasons
  const allReasons: ReasonCounts = {}
  for (const run of allRuns) {
    for (const stage of run.stages) {
      const rc = (stage.reasonCounts || {}) as ReasonCounts
      for (const [reason, count] of Object.entries(rc)) {
        allReasons[reason] = (allReasons[reason] || 0) + count
      }
    }
  }
  const topBlockingReasons = Object.entries(allReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }))

  return {
    lastRun,
    lastSuccessful,
    syncedCount,
    configuredCount,
    healthEligibleCount,
    cheapestWinners,
    readyCount,
    publishedCount,
    marketplaceVisibleCount,
    blockedCount,
    topBlockingReasons,
  }
}

function sumStageTotal(runs: any[], stage: string): number {
  let sum = 0
  for (const run of runs) {
    for (const s of run.stages) {
      if (s.stage === stage) sum += s.total
    }
  }
  return sum
}

function sumStagePassed(runs: any[], stage: string): number {
  let sum = 0
  for (const run of runs) {
    for (const s of run.stages) {
      if (s.stage === stage) sum += s.passed
    }
  }
  return sum
}

function sumStageFailed(runs: any[], stage: string): number {
  let sum = 0
  for (const run of runs) {
    for (const s of run.stages) {
      if (s.stage === stage) sum += s.failed
    }
  }
  return sum
}

export async function getPipelineRunDetail(runId: string) {
  const run = await prisma.catalogPipelineRun.findUnique({
    where: { id: runId },
    include: { stages: { orderBy: { createdAt: 'asc' } } },
  })
  return run
}

export async function getPipelineRuns(params: {
  providerId?: string
  providerCode?: string
  status?: string
  trigger?: string
  fromDate?: string
  toDate?: string
  limit?: number
  offset?: number
}) {
  const where: any = {}
  if (params.providerId) where.providerId = params.providerId
  if (params.providerCode) where.providerCode = params.providerCode
  if (params.status) where.status = params.status
  if (params.trigger) where.trigger = params.trigger
  if (params.fromDate || params.toDate) {
    where.startedAt = {}
    if (params.fromDate) where.startedAt.gte = new Date(params.fromDate)
    if (params.toDate) where.startedAt.lte = new Date(params.toDate)
  }

  const [runs, total] = await Promise.all([
    prisma.catalogPipelineRun.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: params.limit || 50,
      skip: params.offset || 0,
      include: { stages: { orderBy: { createdAt: 'asc' } } },
    }),
    prisma.catalogPipelineRun.count({ where }),
  ])

  return { runs, total }
}
