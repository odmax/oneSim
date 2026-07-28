import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { revalidatePath } from 'next/cache'
import { startPipelineRun, recordStageFromCounts, completePipelineRun, failPipelineRun } from '@/lib/catalog-pipeline'
import { calculatePackageProfit } from './profit-utils'

export type CoverageType = 'local' | 'regional' | 'global'

function detectCoverageType(country: string | null, region: string | null, planType: string | null): CoverageType {
  if (planType?.toUpperCase() === 'GLOBAL' || country?.toUpperCase() === 'GLOBAL' || region?.toUpperCase() === 'GLOBAL') return 'global'
  if (region || planType?.toUpperCase() === 'REGIONAL') return 'regional'
  return 'local'
}

function normalizeCountry(country: string | null, region: string | null, coverage: CoverageType): string {
  if (coverage === 'global') return 'GLOBAL'
  if (coverage === 'regional') return (region || country || 'UNKNOWN').toUpperCase()
  return (country || region || 'UNKNOWN').toUpperCase()
}

function normalizeDataLabel(dataGB: number): string {
  if (dataGB >= 1000) return 'UNLIMITED'
  if (dataGB >= 100) return `${Math.round(dataGB / 100) * 100}GB`
  if (dataGB >= 10) return `${Math.round(dataGB / 5) * 5}GB`
  return `${dataGB}GB`
}

function normalizeValidityDays(days: number): number {
  if (days >= 365) return 365
  if (days >= 180) return 180
  if (days >= 90) return 90
  if (days >= 30) return 30
  if (days >= 14) return 14
  if (days >= 7) return 7
  if (days >= 3) return 3
  if (days >= 1) return 1
  return days
}

export function buildComparableKey(params: {
  country: string | null
  region: string | null
  planType: string | null
  dataGB: number
  validityDays: number
}): string {
  const coverage = detectCoverageType(params.country, params.region, params.planType)
  const nc = normalizeCountry(params.country, params.region, coverage)
  const dl = normalizeDataLabel(params.dataGB)
  const nd = normalizeValidityDays(params.validityDays)
  return `${coverage}:${nc}:${dl}:${nd}`
}

export function computeEffectiveCost(providerCostPrice: number, adminCostPrice: number | null): {
  effectiveCostPrice: number | null
  costSource: 'PROVIDER' | 'ADMIN_OVERRIDE' | 'MISSING'
} {
  if (adminCostPrice != null && adminCostPrice > 0) {
    return { effectiveCostPrice: adminCostPrice, costSource: 'ADMIN_OVERRIDE' }
  }
  if (providerCostPrice > 0) {
    return { effectiveCostPrice: providerCostPrice, costSource: 'PROVIDER' }
  }
  return { effectiveCostPrice: null, costSource: 'MISSING' }
}

export { calculatePackageProfit }

async function computeAndSyncEffectiveCosts(pps: any[]): Promise<void> {
  for (const pp of pps) {
    const rawCost = Number(pp.costPrice)
    const adminCost = pp.adminCostPrice ? Number(pp.adminCostPrice) : null
    const { effectiveCostPrice, costSource } = computeEffectiveCost(rawCost, adminCost)
    await prisma.providerPackage.update({
      where: { id: pp.id },
      data: { effectiveCostPrice, costSource },
    })
    pp.effectiveCostPrice = effectiveCostPrice
    pp.costSource = costSource
  }
}

export async function recalculateComparableGroup(
  comparableKey: string,
  pipelineRunIdInput?: string,
): Promise<{
  groupsProcessed: number
  winners: number
  alternatives: number
  excluded: number
  missingCost: number
  soloWinners: number
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    throw new Error('Unauthorized')
  }

  const pipelineRunId = pipelineRunIdInput || await startPipelineRun({ trigger: 'EVENT' as any })
  const startTime = Date.now()

  try {
    const group = await prisma.providerPackage.findMany({
      where: { comparableKey, isAvailable: true },
      include: {
        provider: { select: { id: true, status: true, priority: true, code: true } },
        publishedAs: { select: { id: true, archivedAt: true, hiddenFromCatalog: true } },
      },
    })

    await computeAndSyncEffectiveCosts(group)

    const result = await rankGroup(group as any, comparableKey)

    await recordStageFromCounts({
      pipelineRunId, stage: 'GROUP_RECALCULATION', startTime,
      total: group.length,
      passed: result.winners + result.alternatives,
      failed: result.excluded + result.missingCost,
      skipped: group.length - result.winners - result.alternatives - result.excluded - result.missingCost,
      metadata: { comparableKey, ...result },
    })

    if (!pipelineRunIdInput) {
      await completePipelineRun(pipelineRunId, result.excluded > 0 ? 'PARTIAL' : 'SUCCESS', result.winners)
    }

    return result
  } catch (error: any) {
    if (!pipelineRunIdInput) {
      await failPipelineRun(pipelineRunId, error.message || 'Group recalculation failed')
    }
    throw error
  }
}

async function rankGroup(
  group: any[],
  comparableKey: string,
): Promise<{
  groupsProcessed: number
  winners: number
  alternatives: number
  excluded: number
  missingCost: number
  soloWinners: number
}> {
  const eligible: { pp: any; effectiveCost: number }[] = []
  const ineligible: any[] = []
  let excluded = 0
  let missingCost = 0

  for (const pp of group) {
    const cost = pp.effectiveCostPrice ? Number(pp.effectiveCostPrice) : null
    const isExcluded = pp.excludedFromCheapest || pp.provider.status === 'INACTIVE' || pp.provider.status === 'ARCHIVED'
    const esim = pp.publishedAs
    const isArchived = esim?.archivedAt

    if (isExcluded || isArchived) {
      ineligible.push(pp)
      continue
    }

    if (cost == null || cost <= 0) {
      missingCost++
      ineligible.push(pp)
      continue
    }

    eligible.push({ pp, effectiveCost: cost })
  }

  for (const pp of ineligible) {
    const isMissingCost = pp.excludedFromCheapest === false
      && !['INACTIVE', 'ARCHIVED'].includes(pp.provider.status)
      && !pp.publishedAs?.archivedAt
      && (pp.effectiveCostPrice == null || Number(pp.effectiveCostPrice) <= 0)
    const reason = isMissingCost ? 'Missing effective cost'
      : pp.excludedFromCheapest ? 'Excluded by admin'
      : pp.provider.status === 'INACTIVE' || pp.provider.status === 'ARCHIVED' ? 'Provider inactive'
      : 'Archived'
    await prisma.providerPackage.update({
      where: { id: pp.id },
      data: { cheapestReason: reason, cheapestRank: null, isCheapestCandidate: false },
    })
    if (!pp.excludedFromCheapest && !isMissingCost) excluded++
  }

  if (eligible.length === 0) {
    return { groupsProcessed: 0, winners: 0, alternatives: 0, excluded, missingCost, soloWinners: 0 }
  }

  eligible.sort((a, b) => {
    if (a.effectiveCost !== b.effectiveCost) return a.effectiveCost - b.effectiveCost
    const aPrio = a.pp.provider.priority || 0
    const bPrio = b.pp.provider.priority || 0
    if (aPrio !== bPrio) return bPrio - aPrio
    return a.pp.id.localeCompare(b.pp.id)
  })

  const isSolo = eligible.length === 1
  let winners = 0
  let alternatives = 0
  let soloWinners = 0

  for (let i = 0; i < eligible.length; i++) {
    const rank = i + 1
    const { pp } = eligible[i]
    const isWinner = rank === 1
    const reason = isWinner
      ? isSolo ? 'Solo eligible plan' : 'Cheapest eligible plan'
      : `Alternative #${rank}`

    await prisma.providerPackage.update({
      where: { id: pp.id },
      data: {
        cheapestRank: rank,
        isCheapestCandidate: isWinner,
        cheapestReason: reason,
      },
    })

    if (isWinner) {
      winners++
      if (isSolo) soloWinners++

      console.log('[CHEAPEST_PLAN_SELECTION]', JSON.stringify({
        groupKey: comparableKey,
        candidateCount: eligible.length,
        selectedPlanId: pp.id,
        selectedCost: pp.effectiveCostPrice ? Number(pp.effectiveCostPrice) : eligible[i].effectiveCost,
      }))
    } else {
      alternatives++
    }
  }

  return { groupsProcessed: 1, winners, alternatives, excluded, missingCost, soloWinners }
}

export async function recalculateCheapestPlans(): Promise<{
  groupsProcessed: number
  winners: number
  alternatives: number
  excluded: number
  missingCost: number
  soloWinners: number
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    throw new Error('Unauthorized')
  }

  const pipelineRunId = await startPipelineRun({ trigger: 'MANUAL' })
  const cheapestStartTime = Date.now()

  try {
  const allPps = await prisma.providerPackage.findMany({
    where: { isAvailable: true },
    include: {
      provider: { select: { id: true, status: true, priority: true, code: true } },
      publishedAs: { select: { id: true, archivedAt: true, hiddenFromCatalog: true } },
    },
  })

  for (const pp of allPps) {
    const coverage = detectCoverageType(pp.country, pp.region, pp.planType)
    const nc = normalizeCountry(pp.country, pp.region, coverage)
    const dl = normalizeDataLabel(pp.dataGB)
    const nd = normalizeValidityDays(pp.validityDays)
    const comparableKey = `${coverage}:${nc}:${dl}:${nd}`

    const rawProviderCost = Number(pp.costPrice)
    const adminCost = pp.adminCostPrice ? Number(pp.adminCostPrice) : null
    const { effectiveCostPrice, costSource } = computeEffectiveCost(rawProviderCost, adminCost)

    await prisma.providerPackage.update({
      where: { id: pp.id },
      data: {
        comparableKey,
        normalizedCountry: nc,
        normalizedDataLabel: dl,
        normalizedValidityDays: nd,
        normalizedCoverageType: coverage,
        effectiveCostPrice,
        costSource,
        cheapestRank: null,
        isCheapestCandidate: false,
        cheapestReason: costSource === 'MISSING' ? 'Missing effective cost' : null,
      },
    })

    pp.comparableKey = comparableKey as any
    ;(pp as any).normalizedCountry = nc
    ;(pp as any).normalizedDataLabel = dl
    ;(pp as any).normalizedValidityDays = nd
    ;(pp as any).normalizedCoverageType = coverage
    ;(pp as any).effectiveCostPrice = effectiveCostPrice
    ;(pp as any).costSource = costSource
  }

  const byKey = new Map<string, typeof allPps>()
  for (const pp of allPps) {
    const key = pp.comparableKey || ''
    if (!key) continue
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(pp)
  }

  let totalGroups = 0
  let totalWinners = 0
  let totalAlternatives = 0
  let totalExcluded = 0
  let totalMissingCost = 0
  let totalSoloWinners = 0

  for (const [key, group] of byKey) {
    const result = await rankGroup(group, key)
    totalGroups += result.groupsProcessed
    totalWinners += result.winners
    totalAlternatives += result.alternatives
    totalExcluded += result.excluded
    totalMissingCost += result.missingCost
    totalSoloWinners += result.soloWinners
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'CHEAPEST_RECALCULATED',
      entity: 'ProviderPackage',
      details: `Cheapest plans recalculated: ${totalGroups} groups, ${totalWinners} cheapest, ${totalSoloWinners} solo, ${totalAlternatives} alternatives, ${totalExcluded} excluded, ${totalMissingCost} missing cost`,
    },
  })

  revalidatePath('/admin/imported-plans')

  const stagePassed = totalWinners + totalAlternatives
  const stageFailed = totalExcluded + totalMissingCost
  await recordStageFromCounts({
    pipelineRunId, stage: 'CHEAPEST_SELECTION', startTime: cheapestStartTime,
    total: allPps.length,
    passed: stagePassed,
    failed: stageFailed,
    skipped: allPps.length - stagePassed - stageFailed,
    metadata: { groupsProcessed: totalGroups, winners: totalWinners, soloWinners: totalSoloWinners, alternatives: totalAlternatives, excluded: totalExcluded, missingCost: totalMissingCost },
  })
  await completePipelineRun(pipelineRunId, totalExcluded > 0 ? 'PARTIAL' : 'SUCCESS', totalWinners)

  return { groupsProcessed: totalGroups, winners: totalWinners, alternatives: totalAlternatives, excluded: totalExcluded, missingCost: totalMissingCost, soloWinners: totalSoloWinners }
  } catch (error: any) {
    await failPipelineRun(pipelineRunId, error.message || 'Cheapest recalculation failed')
    throw error
  }
}

export async function reconcileComparableGroup(comparableKey: string): Promise<{
  groupsProcessed: number
  winners: number
  alternatives: number
  excluded: number
  missingCost: number
  soloWinners: number
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    throw new Error('Unauthorized')
  }

  const pipelineRunId = await startPipelineRun({ trigger: 'EVENT' as any })
  const startTime = Date.now()

  try {
    const group = await prisma.providerPackage.findMany({
      where: { comparableKey, isAvailable: true },
      include: {
        provider: { select: { id: true, status: true, priority: true, code: true } },
        publishedAs: { select: { id: true, archivedAt: true, hiddenFromCatalog: true } },
      },
    })

    const result = await rankGroup(group as any, comparableKey)

    await recordStageFromCounts({
      pipelineRunId, stage: 'GROUP_RECALCULATION', startTime,
      total: group.length,
      passed: result.winners + result.alternatives,
      failed: result.excluded + result.missingCost,
      skipped: group.length - result.winners - result.alternatives - result.excluded - result.missingCost,
      metadata: { comparableKey, ...result, reconciled: true },
    })
    await completePipelineRun(pipelineRunId, result.excluded > 0 ? 'PARTIAL' : 'SUCCESS', result.winners)

    return result
  } catch (error: any) {
    await failPipelineRun(pipelineRunId, error.message || 'Reconciliation failed')
    throw error
  }
}

export async function markCheapestReady(): Promise<{ updated: number }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const pipelineRunId = await startPipelineRun({ trigger: 'MANUAL' })
  const startTime = Date.now()

  try {
  const candidates = await prisma.providerPackage.findMany({
    where: { isCheapestCandidate: true, readyToPublish: false },
  })

  for (const pp of candidates) {
    await prisma.providerPackage.update({
      where: { id: pp.id },
      data: { readyToPublish: true },
    })
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'CHEAPEST_PLAN_PUBLISHED',
      entity: 'ProviderPackage',
      details: `Marked ${candidates.length} cheapest plans as ready to publish`,
    },
  })

  await recordStageFromCounts({
    pipelineRunId, stage: 'READY_FOR_PUBLISH', startTime,
    total: candidates.length, passed: candidates.length, failed: 0, skipped: 0,
  })
  await completePipelineRun(pipelineRunId, 'SUCCESS', candidates.length)

  revalidatePath('/admin/imported-plans')
  return { updated: candidates.length }
  } catch (error: any) {
    await failPipelineRun(pipelineRunId, error.message || 'Mark ready failed')
    throw error
  }
}

export async function publishCheapestOnly(): Promise<{ published: number; skipped: number }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const pipelineRunId = await startPipelineRun({ trigger: 'MANUAL' })
  const startTime = Date.now()

  try {
  const candidates = await prisma.providerPackage.findMany({
    where: { isCheapestCandidate: true, readyToPublish: true },
    include: { publishedAs: true, provider: true },
  })

  let published = 0
  let skipped = 0

  for (const pp of candidates) {
    const esim = pp.publishedAs
    const hasCost = pp.effectiveCostPrice != null && Number(pp.effectiveCostPrice) > 0
    const hasPrice = esim?.priceUSD != null && Number(esim.priceUSD) > 0

    if (!hasCost || !hasPrice) { skipped++; continue }

    if (esim) {
      await prisma.eSIMPackage.update({
        where: { id: esim.id },
        data: { source: 'CATALOG_PRODUCT', isActive: true, hiddenFromCatalog: false, archivedAt: null },
      })
    } else {
      await prisma.eSIMPackage.create({
        data: {
          name: pp.name, dataGB: pp.dataGB, validityDays: pp.validityDays,
          providerName: pp.provider.code, providerId: pp.providerId,
          providerPlanId: pp.providerPlanId, providerPackageId: pp.id,
          source: 'CATALOG_PRODUCT', isActive: true, hiddenFromCatalog: false,
          costPriceUSD: pp.effectiveCostPrice ? Number(pp.effectiveCostPrice) : undefined,
          priceUSD: 0, localPrice: 0, currency: 'USD',
        },
      })
    }
    published++
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'CHEAPEST_PLAN_PUBLISHED',
      entity: 'ProviderPackage',
      details: `Publish cheapest only: ${published} published, ${skipped} skipped (missing cost/price)`,
    },
  })

  await recordStageFromCounts({
    pipelineRunId, stage: 'PUBLISH', startTime,
    total: candidates.length, passed: published, failed: 0, skipped,
    metadata: { published, skipped },
  })
  await completePipelineRun(pipelineRunId, skipped > 0 && published === 0 ? 'FAILED' : skipped > 0 ? 'PARTIAL' : 'SUCCESS', published)

  revalidatePath('/admin/imported-plans')
  revalidatePath('/admin/packages')
  return { published, skipped }
  } catch (error: any) {
    await failPipelineRun(pipelineRunId, error.message || 'Publish cheapest failed')
    throw error
  }
}

export async function excludeFromCheapest(providerPackageId: string, reason: string): Promise<void> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const pp = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    include: { provider: { select: { code: true } } },
  })

  await prisma.providerPackage.update({
    where: { id: providerPackageId },
    data: { excludedFromCheapest: true, exclusionReason: reason || 'Excluded by admin', cheapestRank: null, isCheapestCandidate: false, cheapestReason: 'Excluded by admin' },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'IMPORTED_PLAN_EXCLUDED_FROM_CHEAPEST',
      entity: 'ProviderPackage', entityId: providerPackageId,
      details: `Excluded from cheapest: ${reason || 'No reason'}`,
    },
  })

  const { emitEvent } = await import('@/lib/catalog-events')
  emitEvent({
    eventType: 'PACKAGE_UPDATED',
    providerId: pp?.providerId ?? null,
    providerCode: pp?.provider?.code ?? null,
    packageId: providerPackageId,
    comparableKey: pp?.comparableKey ?? null,
    changedFields: ['excludedFromCheapest'],
    trigger: 'USER_ACTION',
    userId: session.user.id,
  })

  revalidatePath('/admin/imported-plans')
}

export async function includeInCheapest(providerPackageId: string): Promise<void> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const pp = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    include: { provider: { select: { code: true } } },
  })

  await prisma.providerPackage.update({
    where: { id: providerPackageId },
    data: { excludedFromCheapest: false, exclusionReason: null },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'IMPORTED_PLAN_INCLUDED_IN_CHEAPEST',
      entity: 'ProviderPackage', entityId: providerPackageId,
      details: `Included in cheapest comparison`,
    },
  })

  const { emitEvent } = await import('@/lib/catalog-events')
  emitEvent({
    eventType: 'PACKAGE_UPDATED',
    providerId: pp?.providerId ?? null,
    providerCode: pp?.provider?.code ?? null,
    packageId: providerPackageId,
    comparableKey: pp?.comparableKey ?? null,
    changedFields: ['excludedFromCheapest'],
    trigger: 'USER_ACTION',
    userId: session.user.id,
  })

  revalidatePath('/admin/imported-plans')
}
