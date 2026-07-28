/**
 * OneSIM Provider Optimization Engine — Phase 2C
 * ================================================
 *
 * THIS MODULE RANKS PROVIDERS AGAINST BUSINESS RULES — IT NEVER WRITES TO THE DATABASE.
 *
 * ## Responsibilities
 * - Layer on top of Provider Intelligence (comparison data).
 * - Apply configurable optimization strategies and rules.
 * - Generate confidence scores for every recommendation.
 * - Produce detailed justification reasons.
 * - Support batch optimization across many packages.
 *
 * ## What does NOT belong here
 * - Database access (no Prisma imports).
 * - Provider fetching (receives data from calling server action).
 * - Catalog updates or publishing.
 *
 * ## Dependency Direction
 * This module depends on:
 * - `./types.ts` (DTOs)
 * - `./provider-intelligence.ts` (analysis foundation)
 * - `./pricing-engine.ts` (rounding helpers)
 * It NEVER imports from Prisma, server actions, or catalog services.
 *
 * @module provider-optimization
 */

import type {
  OptimizationStrategy,
  OptimizationRules,
  OptimizationResult,
  BatchOptimizationResult,
  ProviderComparison,
  ProviderRecommendation,
} from './types'
import type { ProviderIntelligenceInput } from './provider-intelligence'
import { analyzeProviderGroup } from './provider-intelligence'
import { roundMoney, roundPercentage } from './pricing-engine'

export type { OptimizationStrategy, OptimizationRules, OptimizationResult, BatchOptimizationResult }

const DEFAULT_RULES: OptimizationRules = {
  strategy: 'LOWEST_COST',
  minMarginPercent: 5,
  allowSwitching: true,
}

/**
 * Optimize a single package group — find the best provider
 * given business rules and strategy.
 */
export function optimizePackage(
  packages: ProviderIntelligenceInput[],
  catalogSellingPrice: number | null,
  comparableKey: string | null,
  rules: OptimizationRules = DEFAULT_RULES,
  currency: string = 'USD',
): OptimizationResult {
  // ── 1. Run provider intelligence to get comparisons ──
  const intelligence = analyzeProviderGroup(packages, catalogSellingPrice, comparableKey, currency)

  const firstPkg = packages[0]
  const packageId = firstPkg?.packageId || 'unknown'
  const packageName = firstPkg?.packageName || 'Unknown'

  // ── 2. Apply safety & optimization rule filters ──
  let candidates = [...intelligence.comparisons]

  // Safety: exclude providers with no pricing
  candidates = candidates.filter(c => c.costPrice > 0)

  // Safety: exclude disabled/archived providers (status filter)
  candidates = candidates.filter(c =>
    c.providerStatus !== 'INACTIVE' && c.providerStatus !== 'ARCHIVED'
  )

  // Optimization: exclude specific providers
  if (rules.excludedProviderIds && rules.excludedProviderIds.length > 0) {
    candidates = candidates.filter(c => !rules.excludedProviderIds!.includes(c.providerId))
  }

  // Optimization: exclude providers with invalid pricing
  const sellPrice = catalogSellingPrice
  if (sellPrice != null && sellPrice > 0) {
    candidates = candidates.filter(c => !c.indicators.includes('NO_PRICING'))
  }

  // Optimization: minimum margin filter
  if (rules.minMarginPercent != null && rules.minMarginPercent > 0) {
    candidates = candidates.filter(c =>
      c.marginPercent == null || c.marginPercent >= rules.minMarginPercent!
    )
  }

  // Optimization: maximum acceptable cost
  if (rules.maxAcceptableCost != null && rules.maxAcceptableCost > 0) {
    candidates = candidates.filter(c => c.costPrice <= rules.maxAcceptableCost!)
  }

  // ── 3. Skip if no valid candidates ──
  if (candidates.length === 0) {
    return buildSkipResult(packageId, packageName, intelligence, comparableKey, rules, currency, 'No valid providers after applying optimization rules and filters')
  }

  // ── 4. Apply strategy to rank candidates ──
  const currentProvider = intelligence.currentProvider
  let selected: ProviderComparison

  switch (rules.strategy) {
    case 'LOWEST_COST':
      selected = candidates.reduce((best, c) => c.costPrice < best.costPrice ? c : best)
      break
    case 'HIGHEST_MARGIN':
      if (sellPrice == null || sellPrice <= 0) {
        return buildSkipResult(packageId, packageName, intelligence, comparableKey, rules, currency, 'Cannot apply HIGHEST_MARGIN — no selling price set')
      }
      selected = candidates.reduce((best, c) => (c.marginPercent ?? -Infinity) > (best.marginPercent ?? -Infinity) ? c : best)
      if (selected.marginPercent == null) {
        return buildSkipResult(packageId, packageName, intelligence, comparableKey, rules, currency, 'No providers have valid margin data')
      }
      break
    case 'HIGHEST_PROFIT':
      if (sellPrice == null || sellPrice <= 0) {
        return buildSkipResult(packageId, packageName, intelligence, comparableKey, rules, currency, 'Cannot apply HIGHEST_PROFIT — no selling price set')
      }
      selected = candidates.reduce((best, c) => (c.profit ?? -Infinity) > (best.profit ?? -Infinity) ? c : best)
      if (selected.profit == null) {
        return buildSkipResult(packageId, packageName, intelligence, comparableKey, rules, currency, 'No providers have valid profit data')
      }
      break
    case 'KEEP_CURRENT':
      if (currentProvider && candidates.some(c => c.packageId === currentProvider.packageId)) {
        selected = currentProvider
      } else if (candidates.length > 0) {
        selected = candidates.reduce((best, c) => c.costPrice < best.costPrice ? c : best)
      } else {
        return buildSkipResult(packageId, packageName, intelligence, comparableKey, rules, currency, 'No valid providers and no current provider')
      }
      break
    case 'CUSTOM':
      // Prefer preferred providers, then fall back to lowest cost
      if (rules.preferredProviderIds && rules.preferredProviderIds.length > 0) {
        const preferred = candidates.find(c => rules.preferredProviderIds!.includes(c.providerId))
        if (preferred) {
          selected = preferred
          break
        }
      }
      selected = candidates.reduce((best, c) => c.costPrice < best.costPrice ? c : best)
      break
    default:
      selected = candidates.reduce((best, c) => c.costPrice < best.costPrice ? c : best)
  }

  // ── 5. Compute differences ──
  const costDifference = currentProvider ? roundMoney(currentProvider.costPrice - selected.costPrice) : null
  const profitDifference = currentProvider?.profit != null && selected.profit != null
    ? roundMoney(selected.profit - currentProvider.profit) : null
  const marginDifference = currentProvider?.marginPercent != null && selected.marginPercent != null
    ? roundPercentage(selected.marginPercent - currentProvider.marginPercent) : null

  // ── 6. Should we switch? ──
  let shouldSwitch = false
  if (currentProvider && selected.packageId !== currentProvider.packageId) {
    shouldSwitch = rules.allowSwitching
  } else if (!currentProvider) {
    shouldSwitch = true
  }

  // ── 7. Generate reasons ──
  const reasons: string[] = generateReasons(selected, currentProvider, candidates, costDifference, profitDifference, marginDifference, rules)

  // ── 8. Compute confidence ──
  const confidence = computeConfidence(selected, currentProvider, candidates, rules, sellPrice)

  // ── 9. Reason string ──
  const reason = shouldSwitch
    ? `Switch to ${selected.providerName} (saves $${Math.abs(costDifference ?? 0).toFixed(2)}, ${(marginDifference ?? 0) >= 0 ? '+' : ''}${(marginDifference ?? 0).toFixed(1)}% margin)`
    : currentProvider && selected.packageId === currentProvider.packageId
      ? `Already on optimal provider (${selected.providerName})`
      : !rules.allowSwitching
        ? `Recommendation available but switching is disabled`
        : 'No change needed'

  return {
    packageId,
    packageName,
    comparableKey,
    currentProvider: currentProvider ? {
      providerId: currentProvider.providerId,
      providerName: currentProvider.providerName,
      costPrice: currentProvider.costPrice,
      profit: currentProvider.profit,
      marginPercent: currentProvider.marginPercent,
    } : null,
    recommendedProvider: {
      providerId: selected.providerId,
      providerName: selected.providerName,
      costPrice: selected.costPrice,
      profit: selected.profit,
      marginPercent: selected.marginPercent,
    },
    shouldSwitch,
    reason,
    reasons,
    confidence: Math.min(100, Math.max(0, confidence)),
    costDifference,
    profitDifference,
    marginDifference,
  }
}

/** Build a skipped result with a skip reason. */
function buildSkipResult(
  packageId: string, packageName: string,
  intelligence: ProviderRecommendation,
  comparableKey: string | null,
  rules: OptimizationRules, currency: string, skipReason: string,
): OptimizationResult {
  const current = intelligence.currentProvider
  return {
    packageId, packageName, comparableKey,
    currentProvider: current ? {
      providerId: current.providerId,
      providerName: current.providerName,
      costPrice: current.costPrice,
      profit: current.profit,
      marginPercent: current.marginPercent,
    } : null,
    recommendedProvider: null,
    shouldSwitch: false,
    reason: skipReason,
    reasons: [skipReason],
    confidence: 0,
    costDifference: null,
    profitDifference: null,
    marginDifference: null,
    skipReason,
  }
}

/** Generate human-readable justification points. */
function generateReasons(
  selected: ProviderComparison,
  current: ProviderComparison | null,
  candidates: ProviderComparison[],
  costDiff: number | null,
  profitDiff: number | null,
  marginDiff: number | null,
  rules: OptimizationRules,
): string[] {
  const reasons: string[] = []

  if (selected.indicators.includes('CHEAPEST')) {
    reasons.push('Lowest cost provider in this group')
  }
  if (selected.indicators.includes('BEST_MARGIN')) {
    reasons.push('Best margin among all alternatives')
  }
  if (selected.indicators.includes('BEST_PROFIT')) {
    reasons.push('Highest absolute profit')
  }

  if (costDiff != null && costDiff > 0) {
    reasons.push(`Saves $${costDiff.toFixed(2)} per activation (lower cost)`)
  } else if (costDiff != null && costDiff < 0) {
    reasons.push(`Costs $${Math.abs(costDiff).toFixed(2)} more but better margin`)
  }

  if (marginDiff != null && marginDiff > 0) {
    reasons.push(`Margin improved by ${marginDiff.toFixed(1)}%`)
  }

  if (profitDiff != null && profitDiff > 0) {
    reasons.push(`+$${profitDiff.toFixed(2)} additional profit per activation`)
  }

  if (current) {
    if (selected.providerId !== current.providerId) {
      reasons.push(`Current provider (${current.providerName}) costs $${current.costPrice.toFixed(2)} vs $${selected.costPrice.toFixed(2)}`)
    } else {
      reasons.push('Already on the optimal provider')
    }
  }

  if (candidates.length > 1) {
    reasons.push(`Compared ${candidates.length} alternative providers`)
  }

  if (rules.strategy === 'KEEP_CURRENT') {
    reasons.push('Strategy set to KEEP_CURRENT')
  }

  if (reasons.length === 0) {
    reasons.push('Provider selected based on configured optimization strategy')
  }

  return reasons
}

/** Compute a confidence score 0-100. */
function computeConfidence(
  selected: ProviderComparison,
  current: ProviderComparison | null,
  candidates: ProviderComparison[],
  rules: OptimizationRules,
  sellPrice: number | null,
): number {
  let score = 50 // baseline

  // Cost advantage
  if (current && selected.costPrice < current.costPrice) {
    const savings = Math.abs(current.costPrice - selected.costPrice) / current.costPrice
    score += Math.min(20, Math.round(savings * 100))
  }

  // Margin advantage
  if (current?.marginPercent != null && selected.marginPercent != null && selected.marginPercent > current.marginPercent) {
    score += Math.min(15, Math.round(selected.marginPercent - current.marginPercent))
  }

  // Provider health
  if (selected.providerStatus === 'ACTIVE') score += 10

  // Multiple alternatives → more confidence this is best
  if (candidates.length >= 3) score += 10
  else if (candidates.length === 2) score += 5

  // Selected is cheapest → strong signal
  if (selected.indicators.includes('CHEAPEST')) score += 10

  // No current provider → high confidence in recommending
  if (!current) score += 15

  // Selling price exists → can compute real margin
  if (sellPrice != null && sellPrice > 0) score += 5

  // Penalty: switching disabled
  if (!rules.allowSwitching && current) score -= 20

  return score
}

/**
 * Batch-optimize multiple comparable groups.
 *
 * Each group is analysed independently via `optimizePackage()`.
 * Returns a `BatchOptimizationResult` with per-package results
 * and an aggregated summary.
 */
export function batchOptimize(
  groups: {
    comparableKey: string | null
    packages: ProviderIntelligenceInput[]
    catalogSellingPrice: number | null
    currency: string
  }[],
  rules: OptimizationRules = DEFAULT_RULES,
): BatchOptimizationResult {
  const startTime = Date.now()
  const results: OptimizationResult[] = []

  for (const group of groups) {
    const result = optimizePackage(
      group.packages,
      group.catalogSellingPrice,
      group.comparableKey,
      rules,
      group.currency,
    )
    results.push(result)
  }

  const requireChange = results.filter(r => r.shouldSwitch).length
  const alreadyOptimal = results.filter(r => !r.shouldSwitch && !r.skipReason).length
  const skipped = results.filter(r => !!r.skipReason).length

  // Estimate savings (simple: per-activation cost difference for switched packages)
  let totalMonthlyCostSavings = 0
  let totalAdditionalMonthlyProfit = 0
  for (const r of results) {
    if (r.costDifference != null && r.costDifference > 0) {
      totalMonthlyCostSavings += r.costDifference
    }
    if (r.profitDifference != null && r.profitDifference > 0) {
      totalAdditionalMonthlyProfit += r.profitDifference
    }
  }

  return {
    strategy: rules.strategy,
    rules,
    results,
    summary: {
      totalAnalyzed: results.length,
      requireChange,
      alreadyOptimal,
      skipped,
      estimatedMonthlyCostSavings: totalMonthlyCostSavings > 0 ? roundMoney(totalMonthlyCostSavings) : null,
      estimatedAdditionalMonthlyProfit: totalAdditionalMonthlyProfit > 0 ? roundMoney(totalAdditionalMonthlyProfit) : null,
      currency: groups[0]?.currency || 'USD',
    },
    durationMs: Date.now() - startTime,
  }
}
