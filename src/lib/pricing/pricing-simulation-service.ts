/**
 * OneSIM Pricing Simulation Service — Phase 2A
 * =============================================
 *
 * THIS MODULE SIMULATES PRICING — IT NEVER WRITES TO THE DATABASE.
 *
 * ## Responsibilities
 * - Receive a rule + batch of packages.
 * - Use the Rule Evaluator to determine which packages match.
 * - Use the Pricing Engine to compute what-if selling prices.
 * - Compare before/after pricing for each package.
 * - Generate an aggregated impact summary and validation warnings.
 *
 * ## What does NOT belong here
 * - Database access (no Prisma imports).
 * - Persistence (no writing to ProviderPackage or ESIMPackage).
 * - Rule CRUD or catalog publishing.
 *
 * ## Dependency Direction
 * This module depends on:
 * - `./types.ts` (DTOs)
 * - `./pricing-rule-evaluator.ts` (matching)
 * - `./pricing-engine.ts` (arithmetic)
 * It NEVER imports from Prisma, server actions, or catalog services.
 *
 * @module pricing-simulation-service
 */

import type {
  SimulationRequest,
  SimulationResult,
  PackageSimulation,
  RuleImpactSummary,
  SimulationWarning,
  PricingRuleSummary,
  RuleEvaluationResult,
} from './types'
import { evaluateRule } from './pricing-rule-evaluator'
import { calculatePricing, roundMoney, roundPercentage } from './pricing-engine'

/**
 * Run a full pricing simulation for a rule against a batch of packages.
 *
 * Each package is evaluated against the rule. Matched packages have their
 * what-if selling price computed via the Pricing Engine. Before/after
 * comparisons are generated for every matched package.
 *
 * ZERO database writes.
 */
export function simulateRulePricing(request: SimulationRequest): SimulationResult {
  const startTime = Date.now()
  const packages: PackageSimulation[] = []
  const warnings: SimulationWarning[] = []
  let evaluated = 0
  let updated = 0
  let skipped = 0
  let unchanged = 0
  let totalRevenueBefore = 0
  let totalRevenueAfter = 0
  let totalProfitBefore = 0
  let totalProfitAfter = 0
  let marginSumBefore = 0
  let marginSumAfter = 0
  let marginCountBefore = 0
  let marginCountAfter = 0
  const currency = request.rule.sellingCurrency || 'USD'

  for (const pkg of request.packages) {
    evaluated++

    // ── Evaluate rule against package ──
    const evaluation = evaluateRule({
      rule: request.rule,
      pkg: {
        id: pkg.id,
        name: pkg.name,
        providerId: pkg.providerId,
        country: pkg.country,
        region: pkg.region,
        dataGB: pkg.dataGB,
        validityDays: pkg.validityDays,
        costPrice: pkg.costPrice,
        sellingPrice: pkg.sellingPrice,
        markupPercent: pkg.markupPercent,
        configurationStatus: pkg.configurationStatus,
        publishStatus: pkg.publishStatus,
        autoConfiguredByRuleId: pkg.autoConfiguredByRuleId,
        lastConfiguredAt: null,
      },
    })

    if (!evaluation.matched) {
      skipped++
      warnings.push({
        packageId: pkg.id,
        packageName: pkg.name,
        type: 'RULE_MISMATCH' as any,
        message: evaluation.skipReason || 'Package does not match rule criteria',
        currentValue: null,
        newValue: null,
      })
      continue
    }

    // ── Extract current pricing ──
    const currentSell = pkg.sellingPrice
    const currentCost = evaluation.effectiveCost ?? pkg.costPrice

    if (currentCost <= 0) {
      warnings.push({
        packageId: pkg.id,
        packageName: pkg.name,
        type: 'NO_COST',
        message: 'No cost price available — cannot simulate',
        currentValue: null,
        newValue: null,
      })
      skipped++
      continue
    }

    // ── Compute new pricing via Pricing Engine ──
    const strategy = evaluation.strategy
    const pricingValue = evaluation.pricingValue

    if (pricingValue == null || pricingValue <= 0) {
      warnings.push({
        packageId: pkg.id,
        packageName: pkg.name,
        type: 'INVALID_PRICING',
        message: `Rule has no valid pricing parameter (strategy: ${strategy})`,
        currentValue: currentSell,
        newValue: null,
      })
      skipped++
      continue
    }

    const newPricing = calculatePricing({
      cost: currentCost,
      strategy,
      value: pricingValue,
    })

    const newSell = newPricing.sellingPrice
    const newMargin = newPricing.marginPercent
    const newMarkup = newPricing.markupPercent

    // ── Compute current margin/markup ──
    let currentMargin: number | null = null
    let currentMarkup: number | null = null
    if (currentSell != null && currentSell > 0 && currentCost > 0) {
      currentMargin = roundPercentage(((currentSell - currentCost) / currentSell) * 100)
      currentMarkup = roundPercentage(((currentSell - currentCost) / currentCost) * 100)
    }

    // ── Determine status ──
    let status: string
    if (currentSell == null) {
      status = 'new'
    } else if (Math.abs(newSell - currentSell) < 0.01) {
      status = 'no_change'
      unchanged++
    } else if (newSell > currentSell) {
      status = 'increase'
    } else {
      status = 'decrease'
    }

    // ── Validation warnings ──
    if (newSell < currentCost) {
      warnings.push({
        packageId: pkg.id,
        packageName: pkg.name,
        type: 'BELOW_COST',
        message: `New selling price ($${newSell.toFixed(2)}) is below cost ($${currentCost.toFixed(2)})`,
        currentValue: currentSell,
        newValue: newSell,
      })
    }

    if (newMargin < 5) {
      warnings.push({
        packageId: pkg.id,
        packageName: pkg.name,
        type: 'LOW_MARGIN',
        message: `New margin (${newMargin.toFixed(1)}%) is below 5%`,
        currentValue: currentMargin,
        newValue: newMargin,
      })
    }

    if (newMarkup > 500) {
      warnings.push({
        packageId: pkg.id,
        packageName: pkg.name,
        type: 'HIGH_MARKUP',
        message: `New markup (${newMarkup.toFixed(1)}%) exceeds 500%`,
        currentValue: currentMarkup,
        newValue: newMarkup,
      })
    }

    const profitChange = currentSell != null ? newPricing.profit - (currentSell - currentCost) : null

    // ── Aggregate revenue/profit ──
    if (currentSell != null) {
      totalRevenueBefore += currentSell
      totalProfitBefore += currentSell - currentCost
    }
    totalRevenueAfter += newSell
    totalProfitAfter += newPricing.profit

    if (currentMargin != null) {
      marginSumBefore += currentMargin
      marginCountBefore++
    }
    marginSumAfter += newMargin
    marginCountAfter++

    updated++

    packages.push({
      packageId: pkg.id,
      packageName: pkg.name,
      providerName: pkg.providerName ?? null,
      costPrice: currentCost,
      currentSellingPrice: currentSell,
      newSellingPrice: newSell,
      currentMarginPercent: currentMargin,
      newMarginPercent: newMargin,
      currentMarkupPercent: currentMarkup,
      newMarkupPercent: newMarkup,
      profitChange: profitChange != null ? roundMoney(profitChange) : null,
      status,
    })
  }

  const summary: RuleImpactSummary = {
    packagesEvaluated: evaluated,
    packagesUpdated: updated,
    packagesSkipped: skipped,
    packagesUnchanged: unchanged,
    averageMarginBefore: marginCountBefore > 0 ? roundPercentage(marginSumBefore / marginCountBefore) : null,
    averageMarginAfter: marginCountAfter > 0 ? roundPercentage(marginSumAfter / marginCountAfter) : null,
    estimatedRevenueBefore: roundMoney(totalRevenueBefore),
    estimatedRevenueAfter: roundMoney(totalRevenueAfter),
    estimatedProfitBefore: roundMoney(totalProfitBefore),
    estimatedProfitAfter: roundMoney(totalProfitAfter),
    currency,
  }

  return {
    ruleId: request.rule.id,
    ruleName: request.rule.name,
    packages,
    summary,
    warnings,
    durationMs: Date.now() - startTime,
  }
}

export type {
  SimulationRequest,
  SimulationResult,
  PackageSimulation,
  RuleImpactSummary,
  SimulationWarning,
}
