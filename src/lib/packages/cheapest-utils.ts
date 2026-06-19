import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { revalidatePath } from 'next/cache'

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

export async function recalculateCheapestPlans(): Promise<{
  groupsProcessed: number
  winners: number
  alternatives: number
  excluded: number
  missingCost: number
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    throw new Error('Unauthorized')
  }

  // Step 1: Compute comparable keys and effective costs for all active ProviderPackages
  const allPps = await prisma.providerPackage.findMany({
    where: { isAvailable: true },
    include: {
      provider: { select: { id: true, status: true, priority: true, code: true } },
      publishedAs: { select: { id: true, archivedAt: true, hiddenFromCatalog: true } },
    },
  })

  // Update each record with normalized fields
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
        // Reset cheapest fields
        cheapestRank: null,
        isCheapestCandidate: false,
        cheapestReason: costSource === 'MISSING' ? 'Missing effective cost' : null,
      },
    })
  }

  // Step 2: Group by comparableKey and rank
  const byKey = new Map<string, typeof allPps>()
  for (const pp of allPps) {
    const key = pp.comparableKey || `${detectCoverageType(pp.country, pp.region, pp.planType)}:${normalizeCountry(pp.country, pp.region, detectCoverageType(pp.country, pp.region, pp.planType))}:${normalizeDataLabel(pp.dataGB)}:${normalizeValidityDays(pp.validityDays)}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(pp)
  }

  let groupsProcessed = 0
  let winners = 0
  let alternatives = 0
  let excluded = 0
  let missingCost = 0

  for (const [key, group] of byKey) {
    if (group.length < 2) continue // Skip unique plans (no comparison needed)
    groupsProcessed++

    // Separate eligible vs excluded
    const eligible: { pp: typeof allPps[0]; effectiveCost: number }[] = []
    const ineligible: typeof allPps[0][] = []

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

    // Mark excluded
    for (const pp of ineligible) {
      const reason = pp.excludedFromCheapest ? 'Excluded by admin'
        : pp.provider.status === 'INACTIVE' || pp.provider.status === 'ARCHIVED' ? 'Provider inactive'
        : pp.publishedAs?.archivedAt ? 'Archived'
        : 'Missing effective cost'
      await prisma.providerPackage.update({
        where: { id: pp.id },
        data: { cheapestReason: reason, cheapestRank: null, isCheapestCandidate: false },
      })
      if (!pp.excludedFromCheapest) excluded++
    }

    // Sort eligible by: effectiveCost ASC, provider priority DESC, then createdAt ASC
    eligible.sort((a, b) => {
      if (a.effectiveCost !== b.effectiveCost) return a.effectiveCost - b.effectiveCost
      const aPrio = a.pp.provider.priority || 0
      const bPrio = b.pp.provider.priority || 0
      if (aPrio !== bPrio) return bPrio - aPrio
      return new Date(a.pp.createdAt).getTime() - new Date(b.pp.createdAt).getTime()
    })

    // Rank
    for (let i = 0; i < eligible.length; i++) {
      const rank = i + 1
      const { pp } = eligible[i]
      const isWinner = rank === 1
      const reason = isWinner ? 'Cheapest eligible plan' : `Alternative #${rank}`

      await prisma.providerPackage.update({
        where: { id: pp.id },
        data: {
          cheapestRank: rank,
          isCheapestCandidate: isWinner,
          cheapestReason: reason,
        },
      })
      if (isWinner) winners++
      else alternatives++
    }
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'CHEAPEST_RECALCULATED',
      entity: 'ProviderPackage',
      details: `Cheapest plans recalculated: ${groupsProcessed} groups, ${winners} cheapest, ${alternatives} alternatives, ${excluded} excluded, ${missingCost} missing cost`,
    },
  })

  revalidatePath('/admin/imported-plans')
  return { groupsProcessed, winners, alternatives, excluded, missingCost }
}

export async function markCheapestReady(): Promise<{ updated: number }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

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

  revalidatePath('/admin/imported-plans')
  return { updated: candidates.length }
}

export async function publishCheapestOnly(): Promise<{ published: number; skipped: number }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

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

    if (!esim) {
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
    } else {
      await prisma.eSIMPackage.update({
        where: { id: esim.id },
        data: { source: 'CATALOG_PRODUCT', isActive: true, hiddenFromCatalog: false, archivedAt: null },
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

  revalidatePath('/admin/imported-plans')
  revalidatePath('/admin/packages')
  return { published, skipped }
}

export async function excludeFromCheapest(providerPackageId: string, reason: string): Promise<void> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

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

  revalidatePath('/admin/imported-plans')
}

export async function includeInCheapest(providerPackageId: string): Promise<void> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

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

  revalidatePath('/admin/imported-plans')
}
