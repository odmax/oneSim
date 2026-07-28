/**
 * OneSIM Smart Pricing Engine — Type Definitions
 *
 * This module is the single source of truth for all pricing types.
 * Every pricing calculation in the platform flows through these types.
 */

// ─── Core Pricing Strategy ───────────────────────────────────────────

export type PricingStrategy =
  | 'MARKUP_PERCENT'
  | 'MARGIN_PERCENT'
  | 'FIXED_SELLING_PRICE'
  | 'FIXED_PROFIT'

// ─── Pricing Input ───────────────────────────────────────────────────

/**
 * Required inputs for a pricing calculation.
 * `cost` and `value` are the arithmetic inputs.
 * `strategy` determines the formula applied.
 */
export interface PricingInput {
  /** The wholesale / provider cost for one unit */
  cost: number
  /** The pricing strategy to apply */
  strategy: PricingStrategy
  /**
   * The numeric parameter for the strategy:
   * - MARKUP_PERCENT    → markup percentage (e.g. 25 = 25%)
   * - MARGIN_PERCENT    → margin percentage (e.g. 20 = 20%)
   * - FIXED_SELLING_PRICE → the final selling price
   * - FIXED_PROFIT       → the desired profit per unit
   */
  value: number
}

// ─── Pricing Context (future extension point) ────────────────────────

/**
 * Contextual metadata that may influence pricing decisions
 * in future phases. Most fields are currently unused.
 *
 * By accepting this object now, new pricing features
 * can be added without changing method signatures.
 */
export interface PricingContext {
  /** Provider identifier */
  providerId?: string | null
  /** Provider display name */
  providerName?: string | null
  /** ISO country code */
  country?: string | null
  /** Geographic region */
  region?: string | null
  /** ISO 4217 currency code (e.g. USD, EUR) */
  currency?: string | null
  /** Product type (NEW_ESIM, TOP_UP, etc.) */
  productType?: string | null
  /** Plan category (PREMIUM, STANDARD, LIFETIME) */
  planType?: string | null
  /** Data allowance in GB */
  dataGB?: number | null
  /** Validity period in days */
  validityDays?: number | null
  /** Business/tenant identifier */
  businessId?: string | null
  /** Business pricing tier */
  businessTier?: string | null
  /** Current cost price before rules */
  costPrice?: number | null
  /** Current selling price before rules */
  sellingPrice?: number | null
}

// ─── Pricing Result ──────────────────────────────────────────────────

/**
 * The canonical output of every pricing calculation.
 * All values are rounded to platform precision (2dp for money, 2dp for %).
 */
export interface PricingResult {
  /** The wholesale cost */
  cost: number
  /** Strategy that produced this result */
  strategy: PricingStrategy
  /** Final selling price */
  sellingPrice: number
  /** Profit = sellingPrice - cost */
  profit: number
  /** Profit / Cost × 100 */
  markupPercent: number
  /** Profit / Selling Price × 100 */
  marginPercent: number
}

// ─── Derived Pricing (reverse calculation) ───────────────────────────

/**
 * Result of deriving pricing metrics from a known cost and selling price.
 */
export interface DerivedPricing {
  cost: number
  sellingPrice: number
  profit: number
  markupPercent: number
  marginPercent: number
}

// ─── Validation ──────────────────────────────────────────────────────

export interface PricingValidation {
  valid: boolean
  errors: string[]
}

// ─── Explanation ─────────────────────────────────────────────────────

/**
 * Structured trace of every step in a pricing calculation.
 * Designed for debugging, audit support, rule previews, and simulations.
 * NOT intended for customer-facing UI.
 */
export interface PricingExplanation {
  /** The strategy applied */
  strategy: PricingStrategy
  /** The raw input cost */
  costPrice: number
  /** The strategy input value (markup%, margin%, fixed price, or fixed profit) */
  inputValue: number
  /** The computed selling price */
  sellingPrice: number
  /** The computed profit */
  profit: number
  /** The markup percentage (profit / cost) */
  markupPercent: number
  /** The margin percentage (profit / selling) */
  marginPercent: number
  /** Ordered list of steps performed */
  calculationSteps: string[]
  /** Contextual metadata (subset of PricingContext that was used) */
  context?: Partial<PricingContext>
}

// ─── Price Constraints (future hooks — not yet active) ───────────────

/**
 * Price boundaries that may be enforced in future phases.
 * The engine currently ignores these — they are structural placeholders.
 */
export interface PriceConstraints {
  /** Absolute floor — selling price must be >= this */
  minimumPrice?: number | null
  /** Absolute ceiling — selling price must be <= this */
  maximumPrice?: number | null
  /** Minimum markup % allowed */
  minimumMarkup?: number | null
  /** Maximum markup % allowed */
  maximumMarkup?: number | null
}

// ─── Provider Override (future hook) ─────────────────────────────────

/**
 * Per-provider pricing overrides. Not yet active.
 */
export interface ProviderPricingOverride {
  providerId: string
  fixedPrice?: number | null
  markupPercent?: number | null
  marginPercent?: number | null
  fixedProfit?: number | null
  minimumPrice?: number | null
  maximumPrice?: number | null
}

// ─── Currency Conversion (future hook) ───────────────────────────────

/**
 * Exchange rate for currency conversion. Not yet active.
 */
export interface CurrencyConversion {
  fromCurrency: string
  toCurrency: string
  rate: number
}

// ─── Future Extension Hooks ──────────────────────────────────────────

/**
 * All optional future capabilities in one place.
 * None are currently implemented — they are structural placeholders.
 */
export interface PricingOptions {
  /** Price floor and ceiling */
  constraints?: PriceConstraints
  /** Per-provider overrides */
  providerOverrides?: ProviderPricingOverride[]
  /** Currency conversion */
  currencyConversion?: CurrencyConversion
  /** Tax rate to apply (e.g. 0.2 for 20% VAT) */
  taxRate?: number
  /** Regional pricing modifiers */
  regionalPricing?: { region: string; modifier: number }[]
  /** Business-specific pricing */
  businessPricing?: { businessId: string; discountPercent: number }[]
  /** Active promotions */
  promotions?: { code: string; discountPercent: number }[]
}

// ═══════════════════════════════════════════════════════════════════
// EVENT DTOS — Phase 1.5 Architecture
// ═══════════════════════════════════════════════════════════════════

/**
 * Minimal package summary used by the rule evaluator.
 * The evaluator never touches the database — it receives this DTO.
 */
export interface ProviderPackageSummary {
  id: string
  name: string
  providerId: string | null
  country: string | null
  region: string | null
  dataGB: number
  validityDays: number
  costPrice: number
  sellingPrice: number | null
  markupPercent: number | null
  configurationStatus: string | null
  publishStatus: string | null
  autoConfiguredByRuleId: string | null
  lastConfiguredAt: Date | null
}

/**
 * Simplified version of ProviderPackageSummary for data that comes
 * directly from Prisma (Decimal fields are `{ toString(): string }`).
 */
export interface ProviderPackageRow {
  id: string
  name: string
  costPrice: { toString(): string }
  sellingPrice: { toString(): string } | null
  markupPercent: { toString(): string } | null
  sellingCurrency: string | null
  pricingMode: string | null
  publishStatus: string | null
  configurationStatus: string | null
  autoConfiguredByRuleId: string | null
  lastConfiguredAt: Date | null
  providerId: string | null
  country: string | null
  region: string | null
  dataGB: number
  validityDays: number
}

/**
 * Summary of a `PackageConfigurationRule` passed to the evaluator.
 */
export interface PricingRuleSummary {
  id: string
  name: string
  providerId: string | null
  country: string | null
  region: string | null
  productType: string | null
  dataMinGB: number | null
  dataMaxGB: number | null
  validityMinDays: number | null
  validityMaxDays: number | null
  costPrice: number | null
  markupPercent: number | null
  fixedPrice: number | null
  sellingCurrency: string
  publishStatus: string | null
  priority: number
  isActive: boolean
}

/**
 * Request to evaluate whether a rule matches a package.
 */
export interface PricingEvaluationRequest {
  rule: PricingRuleSummary
  pkg: ProviderPackageSummary
}

/**
 * Result of evaluating a rule against a package.
 * Contains NO pricing calculations — only matching metadata.
 */
export interface RuleEvaluationResult {
  /** Whether the rule matched this package */
  matched: boolean
  /** The rule that was evaluated */
  ruleId: string
  ruleName: string
  /** The package under evaluation */
  packageId: string
  /** Strategy inferred from rule fields */
  strategy: PricingStrategy
  /** The numeric parameter for the strategy */
  pricingValue: number | null
  /** Rule priority (for tiebreaking) */
  priority: number
  /** Effective cost after rule cost-override (if any) */
  effectiveCost: number | null
  /** Human-readable list of conditions that matched */
  matchedConditions: string[]
  /** Reason for non-match (empty if matched) */
  skipReason: string
}

/**
 * Result after evaluating all applicable rules against a package
 * and selecting the winning rule.
 */
export interface PricingEvaluationResult {
  /** The winning evaluation (highest-priority match) or null if none */
  winner: RuleEvaluationResult | null
  /** All evaluations attempted (for audit) */
  evaluations: RuleEvaluationResult[]
}

/**
 * Request to persist pricing data to the database.
 * Produced by the pricing engine from an evaluation result.
 * Consumed by the pricing update service.
 */
export interface PricingUpdateRequest {
  packageId: string
  sellingPrice: number
  sellingCurrency: string
  markupPercent: number | null
  pricingMode: string
  publishStatus: string
  configurationStatus: string
  autoConfiguredByRuleId: string
  costPrice?: number
}

/**
 * Result of persisting a pricing update.
 */
export interface PricingUpdateResult {
  packageId: string
  success: boolean
  error?: string
}

// ═══════════════════════════════════════════════════════════════════
// SIMULATION DTOS — Phase 2A
// ═══════════════════════════════════════════════════════════════════

/** Per-package simulation comparing current vs new pricing. */
export interface PackageSimulation {
  packageId: string
  packageName: string
  providerName: string | null
  costPrice: number
  currentSellingPrice: number | null
  newSellingPrice: number | null
  currentMarginPercent: number | null
  newMarginPercent: number | null
  currentMarkupPercent: number | null
  newMarkupPercent: number | null
  profitChange: number | null
  /** 'increase' | 'decrease' | 'no_change' | 'new' (was null before) | 'error' */
  status: string
  error?: string
}

/** Aggregated impact summary for the simulation. */
export interface RuleImpactSummary {
  packagesEvaluated: number
  packagesUpdated: number
  packagesSkipped: number
  packagesUnchanged: number
  averageMarginBefore: number | null
  averageMarginAfter: number | null
  estimatedRevenueBefore: number
  estimatedRevenueAfter: number
  estimatedProfitBefore: number
  estimatedProfitAfter: number
  currency: string
}

/** Warnings generated by the simulation. */
export interface SimulationWarning {
  packageId: string
  packageName: string
  type: 'BELOW_COST' | 'LOW_MARGIN' | 'HIGH_MARKUP' | 'NO_COST' | 'INVALID_PRICING' | 'RULE_MISMATCH'
  message: string
  currentValue: number | null
  newValue: number | null
}

/** Top-level result of running a simulation. */
export interface SimulationResult {
  /** The rule that was simulated */
  ruleId: string
  ruleName: string
  /** Per-package before/after comparisons */
  packages: PackageSimulation[]
  /** Aggregated summary */
  summary: RuleImpactSummary
  /** Validation warnings */
  warnings: SimulationWarning[]
  /** Total time for the simulation (ms) */
  durationMs: number
}

/**
 * Request to run a simulation for a specific rule against a set of packages.
 * The calling server action fetches the packages and passes them here.
 */
export interface SimulationRequest {
  rule: PricingRuleSummary
  packages: {
    id: string
    name: string
    costPrice: number
    sellingPrice: number | null
    markupPercent: number | null
    sellingCurrency: string | null
    providerId: string | null
    providerName?: string | null
    country: string | null
    region: string | null
    dataGB: number
    validityDays: number
    publishStatus: string | null
    configurationStatus: string | null
    autoConfiguredByRuleId: string | null
  }[]
}

// ═══════════════════════════════════════════════════════════════════
// PROVIDER INTELLIGENCE DTOS — Phase 2B
// ═══════════════════════════════════════════════════════════════════

export type ProviderIndicator =
  | 'CHEAPEST'
  | 'BEST_MARGIN'
  | 'BEST_PROFIT'
  | 'CURRENT_PROVIDER'
  | 'OPTIMAL'
  | 'MORE_EXPENSIVE'
  | 'NO_PRICING'

export interface ProviderComparison {
  providerId: string
  providerCode: string
  providerName: string
  providerStatus: string
  packageId: string
  packageName: string
  costPrice: number
  /** The catalog selling price (same for all providers in group) */
  sellingPrice: number | null
  profit: number | null
  marginPercent: number | null
  markupPercent: number | null
  dataGB: number
  validityDays: number
  isCurrentProvider: boolean
  indicators: ProviderIndicator[]
}

export interface ProviderRecommendation {
  currentProvider: ProviderComparison | null
  recommendedProvider: ProviderComparison | null
  lowestCostProvider: ProviderComparison | null
  highestProfitProvider: ProviderComparison | null
  highestMarginProvider: ProviderComparison | null
  comparisons: ProviderComparison[]
  recommendationReason: string
  estimatedProfitDifference: number | null
  estimatedMarginDifference: number | null
  estimatedCostSavings: number | null
  currency: string
  comparableKey: string | null
}

// ═══════════════════════════════════════════════════════════════════
// OPTIMIZATION DTOS — Phase 2C
// ═══════════════════════════════════════════════════════════════════

export type OptimizationStrategy =
  | 'LOWEST_COST'
  | 'HIGHEST_MARGIN'
  | 'HIGHEST_PROFIT'
  | 'KEEP_CURRENT'
  | 'CUSTOM'

export interface OptimizationRules {
  strategy: OptimizationStrategy
  minMarginPercent?: number | null
  maxAcceptableCost?: number | null
  preferredProviderIds?: string[]
  excludedProviderIds?: string[]
  allowSwitching: boolean
  /** When KEEP_CURRENT, prefer keeping the current provider if margin >= this */
  keepIfMarginAbove?: number | null
}

export interface OptimizationResult {
  packageId: string
  packageName: string
  comparableKey: string | null
  currentProvider: {
    providerId: string
    providerName: string
    costPrice: number
    profit: number | null
    marginPercent: number | null
  } | null
  recommendedProvider: {
    providerId: string
    providerName: string
    costPrice: number
    profit: number | null
    marginPercent: number | null
  } | null
  /** Should this package be switched? */
  shouldSwitch: boolean
  /** Human-readable reason */
  reason: string
  /** Detailed justification points */
  reasons: string[]
  /** 0-100 confidence score */
  confidence: number
  costDifference: number | null
  profitDifference: number | null
  marginDifference: number | null
  /** Why this package was skipped, if applicable */
  skipReason?: string
}

export interface BatchOptimizationResult {
  strategy: OptimizationStrategy
  rules: OptimizationRules
  /** All per-package results */
  results: OptimizationResult[]
  /** Aggregated summary */
  summary: {
    totalAnalyzed: number
    /** Packages that need switching */
    requireChange: number
    /** Packages already on the optimal provider */
    alreadyOptimal: number
    /** Packages skipped (invalid, excluded, etc.) */
    skipped: number
    estimatedMonthlyCostSavings: number | null
    estimatedAdditionalMonthlyProfit: number | null
    currency: string
  }
  /** Duration in ms */
  durationMs: number
}
