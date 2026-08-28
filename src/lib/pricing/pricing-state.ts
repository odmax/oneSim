/**
 * Canonical pricing-state semantics for provider-cost ingestion.
 *
 * Single source of truth for what `pricingStatus` means after a provider sync
 * writes a cost:
 *
 *   COST_UNAVAILABLE       — no valid provider cost (costStatus MISSING/INVALID).
 *   REQUIRES_PRICING       — cost is valid, but there is NO established pricing
 *                            policy yet (no rule, no markup, no selling, no
 *                            snapshot, not configured/published). Selling must
 *                            NOT be fabricated from cost alone.
 *   REQUIRES_RECALCULATION — cost is valid, an established pricing policy
 *                            exists, and the provider cost materially changed;
 *                            the canonical repricing engine must run.
 *   READY                  — only produced by the canonical recalc service after
 *                            selling/snapshot are derived (never from cost alone).
 *
 * This keeps the sync path honest: cost-valid ≠ priced.
 */

/** Cost-change tolerance used to avoid repricing churn on negligible deltas. */
export const COST_CHANGE_TOLERANCE = 0.005

export const PRICING_STATUS = {
  COST_UNAVAILABLE: 'COST_UNAVAILABLE',
  REQUIRES_PRICING: 'REQUIRES_PRICING',
  REQUIRES_RECALCULATION: 'REQUIRES_RECALCULATION',
  READY: 'READY',
  CALCULATION_FAILED: 'CALCULATION_FAILED',
  MARGIN_BELOW_MINIMUM: 'MARGIN_BELOW_MINIMUM',
  EXCHANGE_RATE_MISSING: 'EXCHANGE_RATE_MISSING',
} as const

export type PricingStatus = (typeof PRICING_STATUS)[keyof typeof PRICING_STATUS]

/** Lifecycle/config states that imply an established pricing policy exists. */
const POLICY_LIFECYCLE_STATES = ['READY', 'PUBLISHED', 'CONFIGURED', 'AUTO_CONFIGURED']

export interface PricingPolicyEvidence {
  autoConfiguredByRuleId?: string | null
  markupPercent?: unknown
  sellingPrice?: unknown
  activePriceSnapshotId?: string | null
  publishStatus?: string | null
  configurationStatus?: string | null
}

/**
 * True when an existing package carries evidence that a pricing policy was
 * established (rule-derived or manually configured), so a cost change should
 * trigger the canonical repricing path rather than staying unpriced.
 */
export function hasEstablishedPricingPolicy(existing: PricingPolicyEvidence | null | undefined): boolean {
  if (!existing) return false
  if (existing.autoConfiguredByRuleId) return true
  const markup = existing.markupPercent != null ? Number(existing.markupPercent) : 0
  if (markup > 0) return true
  const selling = existing.sellingPrice != null ? Number(existing.sellingPrice) : 0
  if (selling > 0) return true
  if (existing.activePriceSnapshotId) return true
  if (existing.publishStatus && POLICY_LIFECYCLE_STATES.includes(existing.publishStatus)) return true
  if (existing.configurationStatus && POLICY_LIFECYCLE_STATES.includes(existing.configurationStatus)) return true
  return false
}

/** True when the provider cost materially changed within the platform tolerance. */
export function costMateriallyChanged(
  previousCost: unknown,
  newCost: unknown,
): boolean {
  const prev = previousCost == null ? 0 : Number(previousCost)
  const next = newCost == null ? 0 : Number(newCost)
  return Math.abs(prev - next) > COST_CHANGE_TOLERANCE
}

/**
 * Resolve the correct pricing status after a provider cost write.
 *
 * - invalid/missing cost            → COST_UNAVAILABLE
 * - valid cost, no pricing policy   → REQUIRES_PRICING
 * - valid cost, policy, cost changed → REQUIRES_RECALCULATION (canonical recalc
 *   then sets READY; the sync must trigger it)
 * - valid cost, policy, cost stable  → preserve existing READY (no churn), else
 *   REQUIRES_RECALCULATION so the policy is honored via recalc.
 */
export function resolvePricingStateOnCostSync(input: {
  costStatus: string
  providerCost: unknown
  previousCost: unknown
  existingPolicy: PricingPolicyEvidence | null | undefined
  existingPricingStatus?: string | null
}): PricingStatus {
  if (input.costStatus === 'MISSING' || input.costStatus === 'INVALID') {
    return PRICING_STATUS.COST_UNAVAILABLE
  }
  const hasPolicy = hasEstablishedPricingPolicy(input.existingPolicy)
  if (!hasPolicy) {
    return PRICING_STATUS.REQUIRES_PRICING
  }
  if (costMateriallyChanged(input.previousCost, input.providerCost)) {
    return PRICING_STATUS.REQUIRES_RECALCULATION
  }
  // Policy exists and cost is stable: keep an already-derived READY; otherwise
  // surface the need to establish pricing via the canonical recalc.
  if (input.existingPricingStatus === PRICING_STATUS.READY) return PRICING_STATUS.READY
  return PRICING_STATUS.REQUIRES_RECALCULATION
}