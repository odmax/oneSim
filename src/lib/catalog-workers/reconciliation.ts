import { prisma } from '@/lib/prisma'
import { startPipelineRun, recordStageFromCounts, completePipelineRun, failPipelineRun } from '@/lib/catalog-pipeline'

const RECONCILIATION_WORKER_ID = 'recon-worker'

export interface ReconciliationResult {
  groupsChecked: number
  groupsRepaired: number
  packagesUpdated: number
  errors: string[]
  dryRun?: boolean
  wouldRepair?: number
  wouldPublish?: number
  wouldUnpublish?: number
  wouldDeactivate?: number
}

async function getActiveComparableKeys(): Promise<string[]> {
  const keys = await prisma.providerPackage.findMany({
    where: { isAvailable: true, comparableKey: { not: null } },
    select: { comparableKey: true },
    distinct: ['comparableKey'],
  })
  return keys.map(k => k.comparableKey!).filter(Boolean)
}

async function repairGroup(comparableKey: string, pipelineRunId: string, dryRun = false): Promise<{
  repaired: boolean
  packagesUpdated: number
  wouldRepair: boolean
  wouldPublish: boolean
  wouldUnpublish: boolean
  wouldDeactivate: boolean
  error?: string
}> {
  try {
    const { recalculateComparableGroup } = await import('@/lib/packages/cheapest-utils')
    const result = await recalculateComparableGroup(comparableKey, dryRun ? undefined : pipelineRunId)

    const winner = await prisma.providerPackage.findFirst({
      where: { comparableKey, isCheapestCandidate: true, isAvailable: true },
      include: { publishedAs: true, provider: { select: { code: true } } },
    })

    let packagesUpdated = result.winners + result.alternatives
    let wouldRepair = false
    let wouldPublish = false
    let wouldUnpublish = false
    let wouldDeactivate = false

    if (winner) {
      const esim = winner.publishedAs
      const needsRepair = !esim || !!esim.archivedAt || !!esim.hiddenFromCatalog
      wouldRepair = needsRepair
      wouldPublish = needsRepair && (!esim || !!esim.archivedAt)

      if (!dryRun && needsRepair) {
        const updateData: any = {
          name: winner.name, dataGB: winner.dataGB, validityDays: winner.validityDays,
          providerName: winner.provider?.code || '',
          providerId: winner.providerId, providerPlanId: winner.providerPlanId,
          providerPackageId: winner.id, source: 'CATALOG_PRODUCT',
          isActive: true, hiddenFromCatalog: false,
          priceUSD: Number(winner.sellingPrice) || 0,
          localPrice: Number(winner.sellingPrice) || 0,
          currency: winner.sellingCurrency || 'USD',
          costPriceUSD: winner.effectiveCostPrice ? Number(winner.effectiveCostPrice) : undefined,
        }
        await prisma.eSIMPackage.upsert({
          where: { providerPackageId: winner.id },
          create: updateData,
          update: updateData,
        })
        packagesUpdated++
      }
    }

    return { repaired: true, packagesUpdated, wouldRepair, wouldPublish, wouldUnpublish, wouldDeactivate }
  } catch (err: any) {
    return { repaired: false, packagesUpdated: 0, wouldRepair: false, wouldPublish: false, wouldUnpublish: false, wouldDeactivate: false, error: err.message }
  }
}

export async function runHourlyReconciliation(dryRun = false): Promise<ReconciliationResult> {
  const pipelineRunId = dryRun ? 'dry-run' : await startPipelineRun({ trigger: 'SCHEDULED' as any })
  const startTime = Date.now()
  const errors: string[] = []
  let wouldRepair = 0
  let wouldPublish = 0
  let wouldUnpublish = 0
  let wouldDeactivate = 0

  try {
    const keys = await getActiveComparableKeys()
    let groupsRepaired = 0
    let packagesUpdated = 0

    for (const key of keys) {
      try {
        if (dryRun) {
          const { recalculateComparableGroup } = await import('@/lib/packages/cheapest-utils')
          const result = await recalculateComparableGroup(key, undefined)
          const winner = await prisma.providerPackage.findFirst({
            where: { comparableKey: key, isCheapestCandidate: true, isAvailable: true },
            include: { publishedAs: true },
          })
          if (winner) {
            const esim = winner.publishedAs
            if (!esim || esim.archivedAt) wouldRepair++
            if (!esim || esim.archivedAt || esim.hiddenFromCatalog) {
              const { recalculateComparableGroup } = await import('@/lib/packages/cheapest-utils')
              const dryResult = await recalculateComparableGroup(key, undefined)
              packagesUpdated += dryResult.winners + dryResult.alternatives
            }
          }
          packagesUpdated += result.winners + result.alternatives
        } else {
          const { recalculateComparableGroup } = await import('@/lib/packages/cheapest-utils')
          const result = await recalculateComparableGroup(key, pipelineRunId)

          const winner = await prisma.providerPackage.findFirst({
            where: { comparableKey: key, isCheapestCandidate: true, isAvailable: true },
            include: { publishedAs: true },
          })

          if (winner) {
            const esim = winner.publishedAs
            const needsRepair = !esim || esim.archivedAt || esim.hiddenFromCatalog
            if (needsRepair) {
              const repairResult = await repairGroup(key, pipelineRunId, false)
              groupsRepaired++
              packagesUpdated += repairResult.packagesUpdated
            }
          }

          packagesUpdated += result.winners + result.alternatives
        }
      } catch (err: any) {
        errors.push(`Group ${key}: ${err.message}`)
      }
    }

    if (!dryRun) {
      await recordStageFromCounts({
        pipelineRunId, stage: 'GROUP_RECALCULATION', startTime,
        total: keys.length, passed: keys.length - errors.length, failed: errors.length, skipped: 0,
        metadata: { reconciliation: 'hourly', dryRun, groupsRepaired, packagesUpdated },
      })
      await completePipelineRun(pipelineRunId, errors.length > 0 ? 'PARTIAL' : 'SUCCESS', packagesUpdated)
    }

    return { groupsChecked: keys.length, groupsRepaired, packagesUpdated, errors, dryRun, wouldRepair, wouldPublish, wouldUnpublish, wouldDeactivate }
  } catch (err: any) {
    if (!dryRun) await failPipelineRun(pipelineRunId, err.message || 'Hourly reconciliation failed')
    return { groupsChecked: 0, groupsRepaired: 0, packagesUpdated: 0, errors: [err.message], dryRun }
  }
}

export async function runDailyReconciliation(dryRun = false): Promise<ReconciliationResult> {
  const pipelineRunId = dryRun ? 'dry-run' : await startPipelineRun({ trigger: 'SCHEDULED' as any })
  const startTime = Date.now()
  const errors: string[] = []
  let wouldRepair = 0
  let wouldPublish = 0
  let wouldUnpublish = 0
  let wouldDeactivate = 0

  try {
    const keys = await getActiveComparableKeys()
    let groupsRepaired = 0
    let packagesUpdated = 0

    for (const key of keys) {
      try {
        const result = await repairGroup(key, pipelineRunId, dryRun)
        if (result.repaired && !dryRun) groupsRepaired++
        packagesUpdated += result.packagesUpdated
        if (result.wouldRepair) wouldRepair++
        if (result.wouldPublish) wouldPublish++
        if (result.wouldDeactivate) wouldDeactivate++
        if (result.error) errors.push(`Group ${key}: ${result.error}`)
      } catch (err: any) {
        errors.push(`Group ${key}: ${err.message}`)
      }
    }

    if (!dryRun) {
      await recordStageFromCounts({
        pipelineRunId, stage: 'GROUP_RECALCULATION', startTime,
        total: keys.length, passed: keys.length - errors.length, failed: errors.length, skipped: 0,
        metadata: { reconciliation: 'daily', dryRun, groupsRepaired, packagesUpdated },
      })
      await completePipelineRun(pipelineRunId, errors.length > 0 ? 'PARTIAL' : 'SUCCESS', packagesUpdated)
    }

    return { groupsChecked: keys.length, groupsRepaired, packagesUpdated, errors, dryRun, wouldRepair, wouldPublish, wouldUnpublish, wouldDeactivate }
  } catch (err: any) {
    if (!dryRun) await failPipelineRun(pipelineRunId, err.message || 'Daily reconciliation failed')
    return { groupsChecked: 0, groupsRepaired: 0, packagesUpdated: 0, errors: [err.message], dryRun }
  }
}

export async function runWeeklyReconciliation(dryRun = false): Promise<ReconciliationResult> {
  const pipelineRunId = dryRun ? 'dry-run' : await startPipelineRun({ trigger: 'SCHEDULED' as any })
  const startTime = Date.now()
  const errors: string[] = []
  let wouldRepair = 0
  let wouldPublish = 0
  let wouldUnpublish = 0
  let wouldDeactivate = 0

  try {
    const keys = await getActiveComparableKeys()
    let groupsRepaired = 0
    let packagesUpdated = 0
    let groupsWithNoEligible = 0

    for (const key of keys) {
      try {
        const result = await repairGroup(key, pipelineRunId, dryRun)
        if (result.repaired && !dryRun) groupsRepaired++
        packagesUpdated += result.packagesUpdated
        if (result.wouldRepair) wouldRepair++
        if (result.wouldPublish) wouldPublish++
        if (result.wouldDeactivate) wouldDeactivate++
        if (result.error) errors.push(`Group ${key}: ${result.error}`)

        const eligibleCount = await prisma.providerPackage.count({
          where: {
            comparableKey: key,
            isAvailable: true,
            isCheapestCandidate: true,
          },
        })
        if (eligibleCount === 0) {
          if (!dryRun) {
            await prisma.eSIMPackage.updateMany({
              where: {
                providerPackage: { comparableKey: key },
                isActive: true,
              },
              data: { isActive: false, hiddenFromCatalog: true },
            })
          }
          groupsWithNoEligible++
          wouldDeactivate++
        }
      } catch (err: any) {
        errors.push(`Group ${key}: ${err.message}`)
      }
    }

    if (!dryRun) {
      const { runCatalogHealthDiagnostics } = await import('@/lib/catalog-pipeline')
      const health = await runCatalogHealthDiagnostics()

      await recordStageFromCounts({
        pipelineRunId, stage: 'GROUP_RECALCULATION', startTime,
        total: keys.length, passed: keys.length - errors.length, failed: errors.length, skipped: 0,
        metadata: {
          reconciliation: 'weekly', dryRun, groupsRepaired, packagesUpdated,
          groupsWithNoEligible, totalPackages: health.total,
          eligible: health.eligible, ineligible: health.ineligible,
        },
      })
      await completePipelineRun(pipelineRunId, errors.length > 0 ? 'PARTIAL' : 'SUCCESS', packagesUpdated)
    }

    return { groupsChecked: keys.length, groupsRepaired, packagesUpdated, errors, dryRun, wouldRepair, wouldPublish, wouldUnpublish, wouldDeactivate }
  } catch (err: any) {
    if (!dryRun) await failPipelineRun(pipelineRunId, err.message || 'Weekly reconciliation failed')
    return { groupsChecked: 0, groupsRepaired: 0, packagesUpdated: 0, errors: [err.message], dryRun }
  }
}
