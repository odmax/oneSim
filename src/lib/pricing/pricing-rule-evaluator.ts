/**
 * OneSIM Pricing Rule Evaluator
 * ==============================
 *
 * THIS MODULE DECIDES WHICH RULE WINS — IT NEVER CALCULATES PRICES.
 *
 * ## Responsibilities
 * - Match package configuration rules against provider packages.
 * - Evaluate rule priority for tiebreaking.
 * - Return a `RuleEvaluationResult` containing the winning strategy,
 *   the pricing parameter, and which conditions matched.
 *
 * ## What does NOT belong here
 * - Arithmetic (no markup%, margin%, profit, selling price calculations).
 * - Database access (no Prisma imports).
 * - Catalog publishing logic.
 * - Server actions.
 *
 * ## Dependency Direction
 * This module depends ONLY on `./types.ts`.
 * It NEVER imports from pricing-engine, Prisma, or server actions.
 *
 * @module pricing-rule-evaluator
 */

import type {
  PricingStrategy,
  PricingRuleSummary,
  ProviderPackageSummary,
  RuleEvaluationResult,
  PricingEvaluationResult,
} from './types'

/**
 * Determine which pricing strategy a rule represents.
 *
 * Rules store `markupPercent` and/or `fixedPrice`.
 * The presence of these fields determines the strategy.
 */
export function inferPricingStrategy(rule: PricingRuleSummary): PricingStrategy {
  const fp = toNumber(rule.fixedPrice)
  const mp = toNumber(rule.markupPercent)
  if (fp != null && fp > 0) return 'FIXED_SELLING_PRICE'
  if (mp != null && mp > 0) return 'MARKUP_PERCENT'
  return 'MARKUP_PERCENT'
}

/**
 * Extract the numeric pricing parameter from a rule.
 *
 * - MARKUP_PERCENT → markupPercent
 * - FIXED_SELLING_PRICE → fixedPrice
 */
export function extractPricingValue(rule: PricingRuleSummary): number | null {
  const fp = toNumber(rule.fixedPrice)
  const mp = toNumber(rule.markupPercent)
  if (fp != null && fp > 0) return fp
  if (mp != null && mp > 0) return mp
  return null
}

function toNumber(val: unknown): number | null {
  if (val == null) return null
  if (typeof val === 'number') return val
  if (typeof val === 'string') { const n = parseFloat(val); return isNaN(n) ? null : n }
  // Prisma Decimal or other object with toString()
  try { const n = parseFloat((val as any).toString()); return isNaN(n) ? null : n } catch { return null }
}

/**
 * Resolve the effective cost price for a package under a rule.
 *
 * Precedence:
 *   1. Rule's costPrice (admin override — always wins if > 0)
 *   2. Package's effectiveCostPrice (admin-level override)
 *   3. Package's costPrice (provider cost)
 *
 * This is the SINGLE canonical cost-resolution function.
 * Both preview and execution must use it.
 */
export function resolveEffectiveCost(
  ruleCostPrice: number | null,
  pkgCostPrice: number,
  pkgAdminCostPrice?: number | null,
  pkgEffectiveCost?: number | null,
): number {
  // Rule override takes absolute precedence
  if (ruleCostPrice != null && ruleCostPrice > 0) return ruleCostPrice
  // Package-level admin override
  if (pkgAdminCostPrice != null && pkgAdminCostPrice > 0) return pkgAdminCostPrice
  // Computed effective cost
  if (pkgEffectiveCost != null && pkgEffectiveCost > 0) return pkgEffectiveCost
  // Fallback to provider cost
  return pkgCostPrice
}

/** Export toNumber for use by other cost-resolution callers */
export { toNumber }

/**
 * Determine if a rule matches a provider package.
 *
 * This is the ONE canonical place where rule matching logic lives.
 * Both `apply-rules-workflow.ts` and `package-rules.ts` use this function.
 *
 * Matching criteria (all must pass):
 * 1. Provider ID (if rule specifies one)
 * 2. Country (if rule specifies one)
 * 3. Region (if rule specifies one)
 * 4. Data GB within [min, max] range
 * 5. Validity days within [min, max] range
 *
 * Accepts Prisma objects or plain objects — only requires the 5 matching fields.
 */
export function doesRuleMatchPackage(
  rule: PricingRuleSummary,
  pkg: {
    providerId?: string | null
    country?: string | null
    region?: string | null
    dataGB?: number | null
    validityDays?: number | null
  },
): boolean {
  if (rule.providerId && rule.providerId !== pkg.providerId) return false
  if (rule.country && rule.country !== pkg.country) return false
  if (rule.region && rule.region !== pkg.region) return false
  if (rule.dataMinGB != null && (pkg.dataGB == null || pkg.dataGB < rule.dataMinGB)) return false
  if (rule.dataMaxGB != null && (pkg.dataGB != null && pkg.dataGB > rule.dataMaxGB)) return false
  if (rule.validityMinDays != null && (pkg.validityDays == null || pkg.validityDays < rule.validityMinDays)) return false
  if (rule.validityMaxDays != null && (pkg.validityDays != null && pkg.validityDays > rule.validityMaxDays)) return false
  return true
}

/**
 * Build a human-readable list of conditions that caused a match.
 */
export function describeMatchedConditions(
  rule: PricingRuleSummary,
  pkg: ProviderPackageSummary,
): string[] {
  const conditions: string[] = []
  if (rule.providerId && rule.providerId === pkg.providerId) conditions.push(`Provider matched`)
  if (rule.country && rule.country === pkg.country) conditions.push(`Country: ${rule.country}`)
  if (rule.region && rule.region === pkg.region) conditions.push(`Region: ${rule.region}`)
  if (rule.dataMinGB != null) conditions.push(`Data ≥ ${rule.dataMinGB}GB`)
  if (rule.dataMaxGB != null) conditions.push(`Data ≤ ${rule.dataMaxGB}GB`)
  if (rule.validityMinDays != null) conditions.push(`Validity ≥ ${rule.validityMinDays}d`)
  if (rule.validityMaxDays != null) conditions.push(`Validity ≤ ${rule.validityMaxDays}d`)
  if (conditions.length === 0) conditions.push('No specific criteria (matches all)')
  return conditions
}

/**
 * Build a human-readable reason why a rule was skipped.
 */
export function describeSkipReason(
  rule: PricingRuleSummary,
  pkg: ProviderPackageSummary,
): string {
  if (rule.providerId && rule.providerId !== pkg.providerId) {
    const expected = rule.providerName ? `${rule.providerName} (${rule.providerId})` : rule.providerId
    return `Provider mismatch (rule expects: ${expected})`
  }
  if (rule.country && rule.country !== pkg.country) {
    return `Country mismatch (expected: ${rule.country}, got: ${pkg.country})`
  }
  if (rule.region && rule.region !== pkg.region) {
    return `Region mismatch (expected: ${rule.region}, got: ${pkg.region})`
  }
  if (rule.dataMinGB != null && pkg.dataGB < rule.dataMinGB) {
    return `Data too low (min: ${rule.dataMinGB}GB, got: ${pkg.dataGB}GB)`
  }
  if (rule.dataMaxGB != null && pkg.dataGB > rule.dataMaxGB) {
    return `Data too high (max: ${rule.dataMaxGB}GB, got: ${pkg.dataGB}GB)`
  }
  if (rule.validityMinDays != null && pkg.validityDays < rule.validityMinDays) {
    return `Validity too short (min: ${rule.validityMinDays}d, got: ${pkg.validityDays}d)`
  }
  if (rule.validityMaxDays != null && pkg.validityDays > rule.validityMaxDays) {
    return `Validity too long (max: ${rule.validityMaxDays}d, got: ${pkg.validityDays}d)`
  }
  return 'Does not match rule criteria'
}

/**
 * Evaluate a single rule against a single package.
 *
 * Returns a complete `RuleEvaluationResult` containing
 * match status, strategy, pricing parameter, priority,
 * matched conditions, and skip reason.
 *
 * This function performs ZERO arithmetic beyond inferring the
 * strategy type from rule fields.
 */
export function evaluateRule(request: {
  rule: PricingRuleSummary
  pkg: ProviderPackageSummary
}): RuleEvaluationResult {
  const { rule, pkg } = request

  const match = doesRuleMatchPackage(rule, pkg)

  if (!match) {
    return {
      matched: false,
      ruleId: rule.id,
      ruleName: rule.name,
      packageId: pkg.id,
      strategy: inferPricingStrategy(rule),
      pricingValue: null,
      priority: rule.priority,
      effectiveCost: null,
      matchedConditions: [],
      skipReason: describeSkipReason(rule, pkg),
    }
  }

  const ruleCostNum = toNumber(rule.costPrice)
  const pkgCostNum = typeof pkg.costPrice === 'number' ? pkg.costPrice : toNumber(pkg.costPrice) ?? 0

  const effectiveCost = ruleCostNum != null && ruleCostNum > 0
    ? ruleCostNum
    : pkgCostNum > 0
      ? pkgCostNum
      : null

  return {
    matched: true,
    ruleId: rule.id,
    ruleName: rule.name,
    packageId: pkg.id,
    strategy: inferPricingStrategy(rule),
    pricingValue: extractPricingValue(rule),
    priority: rule.priority,
    effectiveCost,
    matchedConditions: describeMatchedConditions(rule, pkg),
    skipReason: '',
  }
}

/**
 * Evaluate a list of active rules (sorted by priority, highest first)
 * against a single package and return the winning rule.
 *
 * The first matching rule wins (highest priority → first match).
 */
export function evaluatePackageRules(
  rules: PricingRuleSummary[],
  pkg: ProviderPackageSummary,
): PricingEvaluationResult {
  const evaluations: RuleEvaluationResult[] = []

  for (const rule of rules) {
    const result = evaluateRule({ rule, pkg })
    evaluations.push(result)
    if (result.matched) {
      return { winner: result, evaluations }
    }
  }

  return { winner: null, evaluations }
}

/**
 * Bulk-evaluate rules against multiple packages.
 *
 * Returns a map of packageId → evaluation result.
 */
export function evaluatePackageRulesBulk(
  rules: PricingRuleSummary[],
  packages: ProviderPackageSummary[],
): Map<string, PricingEvaluationResult> {
  const results = new Map<string, PricingEvaluationResult>()
  for (const pkg of packages) {
    results.set(pkg.id, evaluatePackageRules(rules, pkg))
  }
  return results
}

export type {
  PricingRuleSummary,
  ProviderPackageSummary,
  RuleEvaluationResult,
  PricingEvaluationResult,
}
