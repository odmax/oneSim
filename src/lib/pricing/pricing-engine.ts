/**
 * OneSIM Smart Pricing Engine
 * ============================
 *
 * This module is the **single source of truth** for all pricing
 * arithmetic in the OneSIM Africa platform.
 *
 * ## Purpose
 * - Centralise every pricing calculation into one place.
 * - Eliminate duplicated formulas scattered across server actions.
 * - Provide a stable, testable foundation for future pricing features.
 *
 * ## Responsibilities
 * - **Pure arithmetic**: cost × markup, margin derivation, profit calculation.
 * - **Validation**: reject invalid inputs before calculation.
 * - **Rounding**: consistent 2dp money and percentage rounding.
 * - **Explanation**: structured trace of every calculation step.
 * - **Simulation**: preview pricing without side effects.
 *
 * ## What does NOT belong here
 * - Database queries (no Prisma imports).
 * - Rule matching (see `pricing-rule-matcher.ts` in `@/lib/packages/`).
 * - Provider sync logic.
 * - Catalog publishing logic.
 * - Authentication or authorisation.
 * - UI rendering.
 *
 * ## Strategies
 *
 * | Strategy           | Selling Price              | Profit       |
 * |--------------------|----------------------------|------------- |
 * | MARKUP_PERCENT     | cost × (1 + value/100)     | sell - cost  |
 * | MARGIN_PERCENT     | cost / (1 - value/100)     | sell - cost  |
 * | FIXED_SELLING_PRICE| value                      | sell - cost  |
 * | FIXED_PROFIT       | cost + value               | value        |
 *
 * ## Examples
 *
 * ```ts
 * // 25% markup on $100
 * calculatePricing({ cost: 100, strategy: 'MARKUP_PERCENT', value: 25 })
 * // → { sellingPrice: 125, profit: 25, markupPercent: 25, marginPercent: 20 }
 *
 * // 20% margin on $100
 * calculatePricing({ cost: 100, strategy: 'MARGIN_PERCENT', value: 20 })
 * // → { sellingPrice: 125, profit: 25, markupPercent: 25, marginPercent: 20 }
 *
 * // Reverse: derive from cost + selling price
 * derivePricing(100, 150)
 * // → { profit: 50, markupPercent: 50, marginPercent: 33.33 }
 * ```
 *
 * ## Future extension points
 * - `PriceConstraints` (floor/ceiling) — additive validation step
 * - `ProviderPricingOverride` — inject before calculation
 * - `CurrencyConversion` — apply to cost before calculation
 * - `taxRate` in `PricingOptions` — apply after calculation
 * - `regionalPricing` / `businessPricing` / `promotions` — apply as modifiers
 *
 * @module pricing-engine
 */

import type {
  PricingStrategy,
  PricingInput,
  PricingContext,
  PricingResult,
  DerivedPricing,
  PricingValidation,
  PricingExplanation,
  PricingOptions,
} from './types'

export type {
  PricingStrategy,
  PricingInput,
  PricingContext,
  PricingResult,
  DerivedPricing,
  PricingValidation,
  PricingExplanation,
  PricingOptions,
}
export type { PriceConstraints, ProviderPricingOverride, CurrencyConversion } from './types'

// ═══════════════════════════════════════════════════════════════════
// ROUNDING HELPERS
// ═══════════════════════════════════════════════════════════════════

/** Round a monetary value to 2 decimal places (banker's standard). */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

/** Round a percentage value to 2 decimal places. */
export function roundPercentage(value: number): number {
  return Math.round(value * 100) / 100
}

// ═══════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate a pricing input before calculation.
 *
 * Rejects:
 * - NaN / Infinity / -Infinity costs and values
 * - Negative costs or values
 * - Margin >= 100%
 * - Fixed selling price below cost
 * - Zero cost for percentage strategies
 */
export function validatePricingInput(input: PricingInput): PricingValidation {
  const errors: string[] = []

  if (typeof input.cost !== 'number' || isNaN(input.cost) || !isFinite(input.cost)) {
    errors.push('Cost must be a valid finite number')
    return { valid: false, errors }
  }
  if (typeof input.value !== 'number' || isNaN(input.value) || !isFinite(input.value)) {
    errors.push('Value must be a valid finite number')
    return { valid: false, errors }
  }

  if (input.cost < 0) errors.push('Cost cannot be negative')
  if (input.value < 0) errors.push('Value cannot be negative')

  if (input.cost === 0 && (input.strategy === 'MARGIN_PERCENT' || input.strategy === 'MARKUP_PERCENT')) {
    errors.push('Cost cannot be zero for percentage-based pricing strategies')
  }

  if (input.strategy === 'MARGIN_PERCENT' && input.value >= 100) {
    errors.push(`Margin percentage (${input.value}%) must be less than 100%. Selling price would be infinite or undefined.`)
  }

  if (input.strategy === 'FIXED_SELLING_PRICE' && input.cost > 0 && input.value < input.cost) {
    errors.push(`Fixed selling price (${input.value}) cannot be below cost (${input.cost})`)
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Validate a cost + selling price pair.
 * Used for reverse derivation.
 */
export function validatePricing(
  cost: number,
  sellingPrice: number,
  strategy?: PricingStrategy,
): PricingValidation {
  const errors: string[] = []

  if (typeof cost !== 'number' || isNaN(cost) || !isFinite(cost)) {
    errors.push('Cost must be a valid finite number')
    return { valid: false, errors }
  }
  if (typeof sellingPrice !== 'number' || isNaN(sellingPrice) || !isFinite(sellingPrice)) {
    errors.push('Selling price must be a valid finite number')
    return { valid: false, errors }
  }

  if (cost < 0) errors.push('Cost cannot be negative')
  if (sellingPrice < 0) errors.push('Selling price cannot be negative')

  if (strategy && cost === 0 && (strategy === 'MARGIN_PERCENT' || strategy === 'MARKUP_PERCENT')) {
    errors.push('Cost cannot be zero for percentage-based pricing')
  }

  if (sellingPrice < cost && cost > 0) {
    errors.push(`Selling price (${sellingPrice}) is below cost (${cost})`)
  }

  return { valid: errors.length === 0, errors }
}

// ═══════════════════════════════════════════════════════════════════
// INTERNAL PIPELINE
// ═══════════════════════════════════════════════════════════════════

/** Internal pipeline step: all strategies flow through this */
function pipelineCalculate(input: PricingInput): { sellingPrice: number } {
  const { cost, strategy, value } = input

  switch (strategy) {
    case 'MARKUP_PERCENT':
      return { sellingPrice: cost * (1 + value / 100) }
    case 'MARGIN_PERCENT':
      return { sellingPrice: cost / (1 - value / 100) }
    case 'FIXED_SELLING_PRICE':
      return { sellingPrice: value }
    case 'FIXED_PROFIT':
      return { sellingPrice: cost + value }
    default: {
      const _exhaustive: never = strategy
      return { sellingPrice: cost }
    }
  }
}

/** Internal pipeline step: derive profit, markup%, margin% from cost + selling */
function pipelineDerive(cost: number, sellingPrice: number): {
  profit: number
  markupPercent: number
  marginPercent: number
} {
  const profit = sellingPrice - cost
  const markupPercent = cost > 0 ? (profit / cost) * 100 : 0
  const marginPercent = sellingPrice > 0 ? (profit / sellingPrice) * 100 : 0
  return { profit, markupPercent, marginPercent }
}

/** Internal pipeline step: round all values to platform precision */
function pipelineRound(raw: {
  cost: number
  sellingPrice: number
  profit: number
  markupPercent: number
  marginPercent: number
}): {
  cost: number
  sellingPrice: number
  profit: number
  markupPercent: number
  marginPercent: number
} {
  return {
    cost: roundMoney(raw.cost),
    sellingPrice: roundMoney(raw.sellingPrice),
    profit: roundMoney(raw.profit),
    markupPercent: roundPercentage(raw.markupPercent),
    marginPercent: roundPercentage(raw.marginPercent),
  }
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API — CALCULATE
// ═══════════════════════════════════════════════════════════════════

/**
 * Calculate pricing from cost and strategy.
 *
 * This is the **primary entry point** for forward pricing calculations.
 * All server actions that compute a selling price must call this function.
 *
 * @example
 * calculatePricing({ cost: 100, strategy: 'MARKUP_PERCENT', value: 25 })
 * // → { cost: 100, strategy: 'MARKUP_PERCENT', sellingPrice: 125, profit: 25, markupPercent: 25, marginPercent: 20 }
 */
export function calculatePricing(
  input: PricingInput,
  _context?: PricingContext,
): PricingResult {
  const { sellingPrice } = pipelineCalculate(input)
  const { profit, markupPercent, marginPercent } = pipelineDerive(input.cost, sellingPrice)
  const rounded = pipelineRound({
    cost: input.cost,
    sellingPrice,
    profit,
    markupPercent,
    marginPercent,
  })

  return {
    cost: rounded.cost,
    strategy: input.strategy,
    sellingPrice: rounded.sellingPrice,
    profit: rounded.profit,
    markupPercent: rounded.markupPercent,
    marginPercent: rounded.marginPercent,
  }
}

/**
 * Derive profit, markup%, and margin% from known cost and selling price.
 *
 * This is the **primary entry point** for reverse pricing calculations.
 * Used when the admin sets a selling price manually and the system
 * needs to compute markup/margin for display and audit.
 *
 * @example
 * derivePricing(100, 150)
 * // → { cost: 100, sellingPrice: 150, profit: 50, markupPercent: 50, marginPercent: 33.33 }
 */
export function derivePricing(
  cost: number,
  sellingPrice: number,
): DerivedPricing {
  const { profit, markupPercent, marginPercent } = pipelineDerive(cost, sellingPrice)
  const rounded = pipelineRound({ cost, sellingPrice, profit, markupPercent, marginPercent })

  return {
    cost: rounded.cost,
    sellingPrice: rounded.sellingPrice,
    profit: rounded.profit,
    markupPercent: rounded.markupPercent,
    marginPercent: rounded.marginPercent,
  }
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API — EXPLANATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Calculate pricing with a structured step-by-step explanation.
 *
 * Designed for debugging, audit support, rule previews, and simulation tooling.
 * The `calculationSteps` array provides a human-readable trace of every operation.
 *
 * @example
 * const { result, explanation } = explainPricing({ cost: 4, strategy: 'MARKUP_PERCENT', value: 25 })
 * // explanation.calculationSteps → ["Validated input", "Applied MARKUP_PERCENT", ...]
 */
export function explainPricing(
  input: PricingInput,
  context?: PricingContext,
): { result: PricingResult; explanation: PricingExplanation } {
  const steps: string[] = []

  const validation = validatePricingInput(input)
  steps.push(validation.valid ? 'Validated input' : `Validation failed: ${validation.errors.join('; ')}`)

  if (!validation.valid) {
    return {
      result: { cost: input.cost, strategy: input.strategy, sellingPrice: 0, profit: 0, markupPercent: 0, marginPercent: 0 },
      explanation: {
        strategy: input.strategy,
        costPrice: input.cost,
        inputValue: input.value,
        sellingPrice: 0,
        profit: 0,
        markupPercent: 0,
        marginPercent: 0,
        calculationSteps: steps,
        context: context ? { ...context } : undefined,
      },
    }
  }

  const strategyLabels: Record<PricingStrategy, string> = {
    MARKUP_PERCENT: `Applied MARKUP_PERCENT: sellingPrice = ${input.cost} × (1 + ${input.value}/100)`,
    MARGIN_PERCENT: `Applied MARGIN_PERCENT: sellingPrice = ${input.cost} / (1 - ${input.value}/100)`,
    FIXED_SELLING_PRICE: `Applied FIXED_SELLING_PRICE: sellingPrice = ${input.value}`,
    FIXED_PROFIT: `Applied FIXED_PROFIT: sellingPrice = ${input.cost} + ${input.value}`,
  }
  steps.push(strategyLabels[input.strategy])

  const { sellingPrice } = pipelineCalculate(input)
  steps.push(`Calculated selling price: ${roundMoney(sellingPrice)}`)

  const { profit, markupPercent, marginPercent } = pipelineDerive(input.cost, sellingPrice)
  steps.push(`Calculated profit: ${roundMoney(profit)}`)
  steps.push(`Derived markup: ${roundPercentage(markupPercent)}%`)
  steps.push(`Derived margin: ${roundPercentage(marginPercent)}%`)

  const rounded = pipelineRound({ cost: input.cost, sellingPrice, profit, markupPercent, marginPercent })
  steps.push('Rounded all values to 2 decimal places')

  return {
    result: {
      cost: rounded.cost,
      strategy: input.strategy,
      sellingPrice: rounded.sellingPrice,
      profit: rounded.profit,
      markupPercent: rounded.markupPercent,
      marginPercent: rounded.marginPercent,
    },
    explanation: {
      strategy: input.strategy,
      costPrice: input.cost,
      inputValue: input.value,
      sellingPrice: rounded.sellingPrice,
      profit: rounded.profit,
      markupPercent: rounded.markupPercent,
      marginPercent: rounded.marginPercent,
      calculationSteps: steps,
      context: context ? { ...context } : undefined,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API — SIMULATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Simulate a pricing calculation without side effects.
 *
 * Internally identical to `calculatePricing()` but exposes a stable API
 * that future phases will extend for:
 * - Rule preview ("what would this rule do?")
 * - Batch preview ("what happens if I apply this to 500 plans?")
 * - What-if analysis
 * - Provider sync preview
 * - Undo preview
 *
 * @example
 * simulatePricing({ cost: 4, strategy: 'MARKUP_PERCENT', value: 25 })
 * // Same result as calculatePricing, but semantically a preview
 */
export function simulatePricing(
  input: PricingInput,
  context?: PricingContext,
): PricingResult {
  return calculatePricing(input, context)
}

/**
 * Simulate pricing with a full explanation.
 *
 * Same as `simulatePricing()` but returns the step-by-step trace.
 */
export function simulatePricingWithExplanation(
  input: PricingInput,
  context?: PricingContext,
): { result: PricingResult; explanation: PricingExplanation } {
  return explainPricing(input, context)
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API — CONVENIENCE HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute the selling price from cost + markup percentage.
 * Convenience wrapper for the common "mark up by X%" pattern.
 *
 * @returns The rounded selling price, or 0 if cost ≤ 0 or markup < 0.
 */
export function markSellingPriceByPercent(cost: number, markupPercent: number): number {
  if (cost <= 0 || markupPercent < 0) return 0
  return roundMoney(cost * (1 + markupPercent / 100))
}

/**
 * Compute the markup percentage from a known cost and selling price.
 * Convenience wrapper for the common "what's the current markup?" pattern.
 *
 * @returns The rounded markup percentage, or undefined if inputs are invalid.
 */
export function computeMarkupFromCostAndSell(cost: number, sellingPrice: number): number | undefined {
  if (cost <= 0 || sellingPrice <= 0) return undefined
  return roundPercentage(((sellingPrice - cost) / cost) * 100)
}

/**
 * Compute the margin percentage from a known cost and selling price.
 *
 * @returns The rounded margin percentage, or undefined if sellingPrice ≤ 0.
 */
export function computeMarginFromCostAndSell(cost: number, sellingPrice: number): number | undefined {
  if (sellingPrice <= 0) return undefined
  return roundPercentage(((sellingPrice - cost) / sellingPrice) * 100)
}

/**
 * Compute the profit (margin amount) from cost and selling price.
 *
 * @returns The rounded profit, or undefined if inputs are invalid.
 */
export function computeMarginAmount(cost: number, sellingPrice: number): number | undefined {
  if (cost <= 0 || sellingPrice <= 0) return undefined
  return roundMoney(sellingPrice - cost)
}

// ═══════════════════════════════════════════════════════════════════
// FUTURE HOOKS (structural placeholders — not yet active)
// ═══════════════════════════════════════════════════════════════════

/**
 * Apply price constraints (floor/ceiling) to a calculated price.
 *
 * **Not yet integrated into the main pipeline.**
 * When activated, this will be called after calculation and before rounding.
 *
 * @internal
 */
export function applyPriceConstraints(
  price: number,
  constraints?: PricingOptions['constraints'],
): number {
  if (!constraints) return price
  let result = price
  if (constraints.minimumPrice != null && result < constraints.minimumPrice) {
    result = constraints.minimumPrice
  }
  if (constraints.maximumPrice != null && result > constraints.maximumPrice) {
    result = constraints.maximumPrice
  }
  return roundMoney(result)
}

/**
 * Apply tax to a price.
 *
 * **Not yet integrated into the main pipeline.**
 *
 * @param price - pre-tax price
 * @param taxRate - tax rate as decimal (e.g. 0.2 for 20% VAT)
 * @returns post-tax price
 *
 * @internal
 */
export function applyTax(price: number, taxRate: number): number {
  return roundMoney(price * (1 + taxRate))
}

/**
 * Convert a price between currencies.
 *
 * **Not yet integrated into the main pipeline.**
 *
 * @internal
 */
export function convertCurrency(price: number, rate: number): number {
  return roundMoney(price * rate)
}

/**
 * Apply a discount to a price.
 *
 * **Not yet integrated into the main pipeline.**
 *
 * @param price - original price
 * @param discountPercent - discount percentage (e.g. 10 for 10% off)
 * @returns discounted price
 *
 * @internal
 */
export function applyDiscount(price: number, discountPercent: number): number {
  if (discountPercent >= 100) return 0
  return roundMoney(price * (1 - discountPercent / 100))
}
