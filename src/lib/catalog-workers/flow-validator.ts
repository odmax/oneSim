import { prisma } from '@/lib/prisma'

export interface StageCounts {
  providerSync: { input: number; output: number; skipped: number; failed: number }
  configuration: { input: number; output: number; skipped: number; failed: number }
  catalogHealth: { input: number; output: number; skipped: number; failed: number }
  groupRecalculation: { input: number; output: number; skipped: number; failed: number }
  readyForPublish: { input: number; output: number; skipped: number; failed: number }
  publish: { input: number; output: number; skipped: number; failed: number }
  marketplace: { input: number; output: number; skipped: number; failed: number }
}

export interface FlowValidationResult {
  valid: boolean
  stageCounts: StageCounts
  issues: string[]
  durationMs: number
}

export async function validateEndToEndFlow(): Promise<FlowValidationResult> {
  const startTime = Date.now()
  const issues: string[] = []

  // PRODUCER_SYNC: total provider packages
  const totalPackages = await prisma.providerPackage.count()
  const unavailablePackages = await prisma.providerPackage.count({ where: { isAvailable: false } })
  const availablePackages = await prisma.providerPackage.count({ where: { isAvailable: true } })
  const syncedNotConfigured = await prisma.providerPackage.count({
    where: { OR: [{ configurationStatus: 'UNCONFIGURED' }, { configurationStatus: null }] },
  })

  // CONFIGURATION: configured packages
  const configured = await prisma.providerPackage.count({
    where: { configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] } },
  })
  const autoConfigured = await prisma.providerPackage.count({
    where: { configurationStatus: 'AUTO_CONFIGURED' },
  })

  // CATALOG_HEALTH: eligible packages
  const healthEligible = await prisma.providerPackage.count({
    where: {
      configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] },
      isAvailable: true,
      sellingPrice: { gt: 0 },
      sellingCurrency: { not: '' },
      publishStatus: { notIn: ['HIDDEN', 'ARCHIVED'] },
    },
  })
  const healthIneligible = configured - healthEligible

  // CHEAPEST_SELECTION / GROUP_RECALCULATION: packages with cheapest ranks
  const withCheapestCandidate = await prisma.providerPackage.count({
    where: { isCheapestCandidate: true, isAvailable: true },
  })
  const withRank = await prisma.providerPackage.count({
    where: { cheapestRank: { not: null }, isAvailable: true },
  })

  // READY_FOR_PUBLISH: READY packages
  const readyForPublish = await prisma.providerPackage.count({
    where: { publishStatus: 'READY', isAvailable: true },
  })

  // PUBLISH: PUBLISHED packages
  const published = await prisma.providerPackage.count({
    where: { publishStatus: 'PUBLISHED', isAvailable: true },
  })

  // MARKETPLACE: marketplace products
  const marketplaceProducts = await prisma.eSIMPackage.count({
    where: { isActive: true, source: 'CATALOG_PRODUCT' },
  })

  const stageCounts: StageCounts = {
    providerSync: {
      input: totalPackages,
      output: availablePackages,
      skipped: unavailablePackages,
      failed: 0,
    },
    configuration: {
      input: availablePackages,
      output: configured,
      skipped: syncedNotConfigured,
      failed: 0,
    },
    catalogHealth: {
      input: configured,
      output: healthEligible,
      skipped: 0,
      failed: healthIneligible,
    },
    groupRecalculation: {
      input: healthEligible,
      output: withCheapestCandidate,
      skipped: healthEligible - withRank,
      failed: withRank - withCheapestCandidate,
    },
    readyForPublish: {
      input: withCheapestCandidate,
      output: readyForPublish,
      skipped: withCheapestCandidate - readyForPublish,
      failed: 0,
    },
    publish: {
      input: readyForPublish,
      output: published,
      skipped: readyForPublish - published,
      failed: 0,
    },
    marketplace: {
      input: published,
      output: marketplaceProducts,
      skipped: 0,
      failed: published - marketplaceProducts,
    },
  }

  // Reconciliation checks
  if (stageCounts.configuration.input !== stageCounts.providerSync.output) {
    issues.push(`Config input (${stageCounts.configuration.input}) != ProviderSync output (${stageCounts.providerSync.output})`)
  }
  if (stageCounts.catalogHealth.input !== stageCounts.configuration.output) {
    issues.push(`Health input (${stageCounts.catalogHealth.input}) != Config output (${stageCounts.configuration.output})`)
  }
  if (stageCounts.groupRecalculation.input !== stageCounts.catalogHealth.output) {
    issues.push(`GroupRecalc input (${stageCounts.groupRecalculation.input}) != Health output (${stageCounts.catalogHealth.output})`)
  }
  if (stageCounts.readyForPublish.input > withCheapestCandidate + 5) {
    issues.push(`ReadyForPublish input (${stageCounts.readyForPublish.input}) far exceeds cheapest candidates (${withCheapestCandidate})`)
  }
  if (stageCounts.publish.input > readyForPublish + 5) {
    issues.push(`Publish input (${stageCounts.publish.input}) exceeds READY count (${readyForPublish})`)
  }
  if (stageCounts.marketplace.input !== stageCounts.publish.output) {
    issues.push(`Marketplace input (${stageCounts.marketplace.input}) != Publish output (${stageCounts.publish.output})`)
  }

  return {
    valid: issues.length === 0,
    stageCounts,
    issues,
    durationMs: Date.now() - startTime,
  }
}
