/**
 * OneSIM Provider Intelligence Service — Phase 2B
 * =================================================
 *
 * THIS MODULE ANALYSES PROVIDER PROFITABILITY — IT NEVER WRITES TO THE DATABASE.
 *
 * ## Responsibilities
 * - Compare provider packages within the same comparable group.
 * - Use the Pricing Engine to compute profit/margin for each provider.
 * - Rank providers by cost, profit, and margin.
 * - Generate a recommendation with a human-readable reason.
 * - Flag providers with indicators (CHEAPEST, BEST_MARGIN, etc.).
 *
 * ## What does NOT belong here
 * - Database access (no Prisma imports).
 * - Publishing or catalog updates.
 * - Provider API health checks (those live in operations-service).
 *
 * ## Dependency Direction
 * This module depends on:
 * - `./types.ts` (DTOs)
 * - `./pricing-engine.ts` (arithmetic)
 * It NEVER imports from Prisma, server actions, or catalog services.
 *
 * @module provider-intelligence
 */

import type {
  ProviderComparison,
  ProviderRecommendation,
  ProviderIndicator,
} from './types'
import { roundMoney, roundPercentage } from './pricing-engine'

/**
 * Input to the intelligence analysis: one package per provider.
 */
export interface ProviderIntelligenceInput {
  packageId: string
  packageName: string
  providerId: string
  providerCode: string
  providerName: string
  providerStatus: string
  costPrice: number
  /** The effective cost (admin override > provider cost) */
  effectiveCostPrice?: number | null
  dataGB: number
  validityDays: number
  currentProviderPackageId?: string | null
}

/**
 * Run provider intelligence for a group of equivalent packages.
 *
 * All packages should share the same `comparableKey` (same country,
 * coverage type, data bucket, validity bucket). The selling price
 * is assumed to be identical across the group (catalog price).
 *
 * @param packages - Array of packages from different providers, same comparableKey
 * @param catalogSellingPrice - Current catalog selling price (null if unset)
 * @param comparableKey - The group key for context
 * @returns ProviderRecommendation with rankings and indicators
 */
export function analyzeProviderGroup(
  packages: ProviderIntelligenceInput[],
  catalogSellingPrice: number | null,
  comparableKey: string | null = null,
  currency: string = 'USD',
): ProviderRecommendation {
  if (packages.length === 0) {
    return {
      currentProvider: null,
      recommendedProvider: null,
      lowestCostProvider: null,
      highestProfitProvider: null,
      highestMarginProvider: null,
      comparisons: [],
      recommendationReason: 'No provider packages available for comparison',
      estimatedProfitDifference: null,
      estimatedMarginDifference: null,
      estimatedCostSavings: null,
      currency,
      comparableKey,
    }
  }

  // Build comparison objects for each provider
  const comparisons: ProviderComparison[] = packages.map(p => {
    const effectiveCost = p.effectiveCostPrice ?? p.costPrice
    const sell = catalogSellingPrice
    let profit: number | null = null
    let marginPercent: number | null = null
    let markupPercent: number | null = null

    if (sell != null && sell > 0 && effectiveCost > 0) {
      profit = roundMoney(sell - effectiveCost)
      marginPercent = roundPercentage((profit / sell) * 100)
      markupPercent = roundPercentage((profit / effectiveCost) * 100)
    }

    const indicators: ProviderIndicator[] = []
    if (sell == null || sell <= 0) {
      indicators.push('NO_PRICING')
    }

    return {
      providerId: p.providerId,
      providerCode: p.providerCode,
      providerName: p.providerName,
      providerStatus: p.providerStatus,
      packageId: p.packageId,
      packageName: p.packageName,
      costPrice: effectiveCost,
      sellingPrice: sell,
      profit,
      marginPercent,
      markupPercent,
      dataGB: p.dataGB,
      validityDays: p.validityDays,
      isCurrentProvider: p.packageId === p.currentProviderPackageId,
      indicators,
    }
  })

  // ── Apply indicators ──
  const priced = comparisons.filter(c => c.costPrice > 0)

  if (priced.length > 0) {
    // Cheapest
    const cheapest = priced.reduce((best, c) =>
      c.costPrice < best.costPrice ? c : best
    )
    cheapest.indicators.push('CHEAPEST')

    // Best margin
    if (catalogSellingPrice != null && catalogSellingPrice > 0) {
      const bestMargin = priced.reduce((best, c) =>
        (c.marginPercent ?? -Infinity) > (best.marginPercent ?? -Infinity) ? c : best
      )
      if (bestMargin.marginPercent != null) {
        bestMargin.indicators.push('BEST_MARGIN')
      }

      const bestProfit = priced.reduce((best, c) =>
        (c.profit ?? -Infinity) > (best.profit ?? -Infinity) ? c : best
      )
      if (bestProfit.profit != null) {
        bestProfit.indicators.push('BEST_PROFIT')
      }
    }
  }

  // Mark current provider
  const currentProvider = comparisons.find(c => c.isCurrentProvider) || null
  if (currentProvider) {
    currentProvider.indicators.push('CURRENT_PROVIDER')
  }

  // Mark "more expensive" for others
  if (priced.length > 0) {
    const cheapestCost = priced.reduce((min, c) => Math.min(min, c.costPrice), Infinity)
    for (const c of priced) {
      if (Math.abs(c.costPrice - cheapestCost) > 0.01 && !c.isCurrentProvider) {
        c.indicators.push('MORE_EXPENSIVE')
      }
    }
  }

  // ── Determine recommendation ──
  let recommendedProvider: ProviderComparison | null = null
  let recommendationReason = ''
  let estimatedProfitDifference: number | null = null
  let estimatedMarginDifference: number | null = null
  let estimatedCostSavings: number | null = null

  const lowestCostProvider = priced.length > 0
    ? priced.reduce((best, c) => c.costPrice < best.costPrice ? c : best)
    : null
  const highestProfitProvider = priced.length > 0 && catalogSellingPrice != null
    ? priced.reduce((best, c) => (c.profit ?? -Infinity) > (best.profit ?? -Infinity) ? c : best)
    : null
  const highestMarginProvider = priced.length > 0 && catalogSellingPrice != null
    ? priced.reduce((best, c) => (c.marginPercent ?? -Infinity) > (best.marginPercent ?? -Infinity) ? c : best)
    : null

  if (priced.length === 0) {
    recommendationReason = 'No providers have valid pricing data'
  } else if (currentProvider && lowestCostProvider && currentProvider.packageId === lowestCostProvider.packageId) {
    recommendedProvider = currentProvider
    recommendationReason = 'Existing provider is already the cheapest option'
  } else if (currentProvider && highestMarginProvider && currentProvider.packageId === highestMarginProvider.packageId) {
    recommendedProvider = currentProvider
    recommendationReason = 'Existing provider already yields the best margin'
  } else if (currentProvider && currentProvider.indicators.includes('CHEAPEST')) {
    recommendedProvider = currentProvider
    recommendationReason = 'Existing provider is already optimal'
  } else if (priced.length === 1) {
    recommendedProvider = priced[0]
    recommendationReason = 'Only one provider available — no alternatives to compare'
  } else {
    // Default recommendation: cheapest cost provider
    recommendedProvider = lowestCostProvider
    recommendationReason = `Recommended for lowest cost ($${lowestCostProvider!.costPrice.toFixed(2)} vs ${currentProvider ? `$${currentProvider.costPrice.toFixed(2)}` : 'no current'})`

    if (currentProvider && lowestCostProvider) {
      estimatedCostSavings = roundMoney(currentProvider.costPrice - lowestCostProvider.costPrice)
      if (estimatedCostSavings <= 0) {
        estimatedCostSavings = null
      }

      if (catalogSellingPrice != null && catalogSellingPrice > 0) {
        const currentProfit = currentProvider.profit
        const recProfit = lowestCostProvider.profit
        if (currentProfit != null && recProfit != null) {
          estimatedProfitDifference = roundMoney(recProfit - currentProfit)
        }
        const currentMargin = currentProvider.marginPercent
        const recMargin = lowestCostProvider.marginPercent
        if (currentMargin != null && recMargin != null) {
          estimatedMarginDifference = roundPercentage(recMargin - currentMargin)
        }
      }
    }
  }

  // Mark as optimal
  if (recommendedProvider) {
    recommendedProvider.indicators.push('OPTIMAL')
  }

  return {
    currentProvider,
    recommendedProvider,
    lowestCostProvider,
    highestProfitProvider,
    highestMarginProvider,
    comparisons,
    recommendationReason,
    estimatedProfitDifference,
    estimatedMarginDifference,
    estimatedCostSavings,
    currency,
    comparableKey,
  }
}

export type {
  ProviderComparison,
  ProviderRecommendation,
  ProviderIndicator,
}
