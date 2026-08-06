import { prisma } from '@/lib/prisma'
import { buildComparisonKey, type ComparisonKeyInput } from './comparison-key'
import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'
import type { Prisma } from '@prisma/client'

export interface ProviderPlanCandidate {
  providerPackageId: string
  name: string
  providerId: string
  providerName: string
  providerCode: string | null
  costPrice: number
  costCurrency: string
  normalizedCostUSD: number
  sellingPrice: number
  sellingCurrency: string
  configurationStatus: string | null
  publishStatus: string | null
  pricingStatus: string | null
  activePriceSnapshotId: string | null
  comparisonKey: string
  country: string | null
  region: string | null
  dataGB: number
  validityDays: number
  voiceMinutes: number | null
  smsCount: number | null
  planType: string | null
  eligible: boolean
  exclusionReasons: string[]
}

export interface SelectionResult {
  selected: boolean
  comparisonKey: string
  winner: ProviderPlanCandidate | null
  alternatives: ProviderPlanCandidate[]
  excludedPlans: ProviderPlanCandidate[]
  selectionReason: string
  winnerPackageId: string | null
}

/**
 * Load all configured provider plans, build comparison keys, assess eligibility,
 * group by comparison key, and select the cheapest eligible provider plan per group.
 *
 * Eligibility requirements:
 * - provider operational (ACTIVE/DEGRADED/TESTING)
 * - provider has PURCHASE capability
 * - configurationStatus in CONFIGURED/AUTO_CONFIGURED
 * - not archived
 * - cost exists and is positive (costPrice > 0 or adminCostPrice > 0)
 * - costStatus is VALID or OVERRIDDEN
 * - currency exists
 * - data and validity values are positive
 * - not manually excluded (excludedFromAutoPick)
 */
export async function selectCheapestPlanPerComparisonGroup(): Promise<Map<string, SelectionResult>> {
  const allPlans = await prisma.providerPackage.findMany({
    where: {
      publishStatus: { not: 'ARCHIVED' },
    },
    include: {
      provider: {
        select: { id: true, name: true, code: true, status: true, enabledCapabilities: true, catalogPriority: true, activationSuccessRate: true },
      },
    },
    orderBy: { name: 'asc' },
  })

  const operationalStatuses = ['ACTIVE', 'DEGRADED', 'TESTING']

  const candidates: ProviderPlanCandidate[] = allPlans.map(pp => {
    const input: ComparisonKeyInput = {
      country: pp.country, region: pp.region,
      dataGB: pp.dataGB, validityDays: pp.validityDays,
      voiceMinutes: (pp as any).voiceMinutes, smsCount: (pp as any).smsCount,
      planType: (pp as any).planType,
    }
    const comparisonKey = buildComparisonKey(input)
    const costPrice = Number(pp.costPrice || 0)
    const adminCost = pp.adminCostPrice ? Number(pp.adminCostPrice) : 0
    const effectiveCost = adminCost > 0 ? adminCost : costPrice
    const sellPrice = Number(pp.sellingPrice || 0)
    const configured = ['CONFIGURED', 'AUTO_CONFIGURED'].includes(pp.configurationStatus || '')
    const provider = pp.provider
    const caps = (provider?.enabledCapabilities || []) as string[]

    const exclusionReasons: string[] = []
    if (!provider) exclusionReasons.push('No provider linked')
    else {
      if (!operationalStatuses.includes(provider.status)) exclusionReasons.push(`Provider ${provider.status}`)
      if (!caps.includes('PURCHASE')) exclusionReasons.push('Missing PURCHASE capability')
    }
    if (!configured) exclusionReasons.push(`Not configured (${pp.configurationStatus})`)
    if (effectiveCost <= 0) exclusionReasons.push('No effective cost')
    if (!['VALID', 'OVERRIDDEN'].includes(pp.costStatus || '')) exclusionReasons.push(`Cost status ${pp.costStatus}`)
    if (!pp.currency) exclusionReasons.push('Missing currency')
    if (!pp.dataGB || pp.dataGB <= 0) exclusionReasons.push('Missing data amount')
    if (!pp.validityDays || pp.validityDays <= 0) exclusionReasons.push('Missing validity')
    if (pp.excludedFromAutoPick) exclusionReasons.push('Excluded from auto-pick')

    const eligible = exclusionReasons.length === 0

    return {
      providerPackageId: pp.id,
      name: pp.name,
      providerId: pp.providerId,
      providerName: provider?.name || 'Unknown',
      providerCode: provider?.code || null,
      costPrice: effectiveCost,
      costCurrency: pp.currency || 'USD',
      normalizedCostUSD: effectiveCost, // simplified — assumes USD base
      sellingPrice: sellPrice,
      sellingCurrency: pp.sellingCurrency || 'USD',
      configurationStatus: pp.configurationStatus,
      publishStatus: pp.publishStatus,
      pricingStatus: pp.pricingStatus,
      activePriceSnapshotId: pp.activePriceSnapshotId,
      comparisonKey,
      country: pp.country,
      region: pp.region,
      dataGB: pp.dataGB,
      validityDays: pp.validityDays,
      voiceMinutes: (pp as any).voiceMinutes ?? null,
      smsCount: (pp as any).smsCount ?? null,
      planType: (pp as any).planType ?? null,
      eligible,
      exclusionReasons,
    }
  })

  // Group by comparison key
  const groups = new Map<string, ProviderPlanCandidate[]>()
  for (const c of candidates) {
    if (!groups.has(c.comparisonKey)) groups.set(c.comparisonKey, [])
    groups.get(c.comparisonKey)!.push(c)
  }

  // Select cheapest per group
  const results = new Map<string, SelectionResult>()
  for (const [key, group] of groups) {
    const eligible = group.filter(c => c.eligible)
    const excluded = group.filter(c => !c.eligible)

    if (eligible.length === 0) {
      results.set(key, {
        selected: false,
        comparisonKey: key,
        winner: null,
        alternatives: [],
        excludedPlans: excluded,
        selectionReason: 'No eligible plans',
        winnerPackageId: null,
      })
      continue
    }

    // Sort by effective cost ascending, then tie-break
    eligible.sort((a, b) => {
      if (a.normalizedCostUSD !== b.normalizedCostUSD) return a.normalizedCostUSD - b.normalizedCostUSD
      // Tie-break: prefer published, then catalog priority, then higher success rate, then stable ID
      const aPub = a.publishStatus === 'PUBLISHED' ? 1 : 0
      const bPub = b.publishStatus === 'PUBLISHED' ? 1 : 0
      if (bPub !== aPub) return bPub - aPub
      return a.providerPackageId.localeCompare(b.providerPackageId)
    })

    const winner = eligible[0]
    const alternatives = eligible.slice(1)

    results.set(key, {
      selected: true,
      comparisonKey: key,
      winner,
      alternatives,
      excludedPlans: excluded,
      selectionReason: `Cheapest effective cost: $${winner.normalizedCostUSD.toFixed(4)} (${winner.providerName})`,
      winnerPackageId: winner.providerPackageId,
    })
  }

  return results
}
