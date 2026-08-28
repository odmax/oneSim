/**
 * Provider pricing reconciliation — canonical classification + conservative apply.
 *
 * This service is the portable (testable) heart of the AirHub pricing
 * reconciliation tool. It classifies every ProviderPackage against the current
 * DB state using the same semantics as the canonical pricing pipeline, and it
 * applies ONLY the conservative, deterministic fixes that the shared
 * provider-sync cost-change path already performs:
 *
 *   - derive selling via the canonical rule → recalculatePackagePrice()
 *   - fresh snapshot
 *   - retail sync via the existing catalog-price sync (never duplicate rows)
 *   - never auto-publish, never delete, never fabricate a selling price
 *   - never create a retail row for a PUBLISHED package that already lacks one
 *     (South-Africa-style anomaly stays manual)
 *
 * It does NOT hard-code provider names, plan ids, or markup values.
 */

import { prisma } from '@/lib/prisma'
import { recalculatePackagePrice } from '@/lib/pricing/price-recalculation-service'
import { syncProviderPackageToPublishedProducts } from '@/lib/services/catalog-price-sync'
import {
  hasEstablishedPricingPolicy,
  costMateriallyChanged,
  PRICING_STATUS,
  COST_CHANGE_TOLERANCE,
} from '@/lib/pricing/pricing-state'
import type { ProviderPackage, PackageConfigurationRule, ESIMPackage, PackagePriceSnapshot } from '@prisma/client'

export type ReconciliationClassification =
  | 'OK'
  | 'UNPRICED_RULE_AVAILABLE'
  | 'UNPRICED_NO_RULE'
  | 'BELOW_COST_REPRICE'
  | 'STALE_SNAPSHOT_COST'
  | 'RETAIL_PARITY_MISMATCH'
  | 'MISSING_RETAIL'
  | 'MISSING_SNAPSHOT'
  | 'COST_UNAVAILABLE'
  | 'REQUIRES_PRICING'

export interface ResolvedRule {
  ruleAvailable: boolean
  resolvedRuleId: string | null
  resolvedRuleName?: string | null
  resolvedMarkupPercent?: number | null
}

export interface PackageReconciliationResult {
  id: string
  providerPlanId: string
  name: string
  costPrice: number
  sellingPrice: number | null
  markupPercent: number | null
  pricingStatus: string | null
  publishStatus: string | null
  configurationStatus: string | null
  autoConfiguredByRuleId?: string | null
  activeSnapshotId: string | null
  hasActiveSnapshot: boolean
  hasRetail: boolean
  historicalPriceSnapshot: number | null
  historicalSnapshotCost: number | null
  retailPriceUSD: number | null
  rule: ResolvedRule
  classifications: ReconciliationClassification[]
  applyAllowed: boolean
  proposedAction: string
  reason: string
  establishedPolicy: boolean
}

export interface ReconciliationSummary {
  providerId: string
  providerCode: string
  providerName: string
  total: number
  counts: Record<ReconciliationClassification, number>
  rows: PackageReconciliationResult[]
  failures: Array<{ providerPlanId: string; classification: string; error: string }>
  applied: number
  unchanged: number
}

/**
 * Resolve the applicable active pricing rule for a provider.
 * Mirrors the canonical resolution used by recalculatePackagePrice():
 * the highest-priority active rule scoped to the provider.
 */
export async function resolveProviderPricingRule(providerId: string): Promise<ResolvedRule> {
  const rule = await prisma.packageConfigurationRule.findFirst({
    where: { providerId, isActive: true },
    orderBy: { priority: 'desc' },
  })
  if (!rule) return { ruleAvailable: false, resolvedRuleId: null }
  return {
    ruleAvailable: true,
    resolvedRuleId: rule.id,
    resolvedRuleName: rule.name ?? null,
    resolvedMarkupPercent: rule.markupPercent != null ? Number(rule.markupPercent) : null,
  }
}

function snapCost(snap: PackagePriceSnapshot | null | undefined): number | null {
  if (!snap) return null
  const eff = snap.effectiveCostAmount != null ? Number(snap.effectiveCostAmount) : null
  if (eff != null && eff > 0) return eff
  const orig = snap.originalCostAmount != null ? Number(snap.originalCostAmount) : null
  return orig != null && orig > 0 ? orig : null
}

export type ClassificationInput = {
  costPrice: number
  sellingPrice: number | null
  markupPercent: number | null
  pricingStatus: string | null
  publishStatus: string | null
  configurationStatus: string | null
  activeSnapshotId: string | null
  activeSnapshot: { effectiveCostAmount?: unknown; originalCostAmount?: unknown } | null
  retailLinked: boolean
  retailPriceUSD: number | null
  rule: ResolvedRule
  autoConfiguredByRuleId?: string | null
}

/**
 * Deterministic, multi-finding classification from current state. The returned
 * array may contain more than one finding when independent defects coexist
 * (e.g. MISSING_SNAPSHOT + MISSING_RETAIL).
 */
export function classifyPackage(input: ClassificationInput): ReconciliationClassification[] {
  const findings: ReconciliationClassification[] = []
  const hasRule = input.rule.ruleAvailable
  const costValid = Number(input.costPrice) > 0
  const priced = input.sellingPrice != null && Number(input.sellingPrice) > 0

  // Cost unavailable — terminal; never attempt pricing.
  if (!costValid) {
    findings.push('COST_UNAVAILABLE')
    return findings
  }

  // New semantic state from pricing-state (cost-valid but no pricing policy).
  if (input.pricingStatus === PRICING_STATUS.REQUIRES_PRICING) {
    findings.push('REQUIRES_PRICING')
  }

  if (!priced) {
    // Cost-valid but not priced.
    if (input.pricingStatus === PRICING_STATUS.REQUIRES_PRICING) return findings
    findings.push(hasRule ? 'UNPRICED_RULE_AVAILABLE' : 'UNPRICED_NO_RULE')
    return findings
  }

  // Priced row.
  const selling = Number(input.sellingPrice)
  if (selling < Number(input.costPrice)) {
    findings.push('BELOW_COST_REPRICE')
  }

  if (input.activeSnapshot) {
    const sc = snapCost(input.activeSnapshot as any)
    if (sc != null && costMateriallyChanged(sc, Number(input.costPrice))) {
      findings.push('STALE_SNAPSHOT_COST')
    }
  } else {
    // Priced / PUBLISHED package without an active snapshot.
    const publishedOrPolicy = input.publishStatus === 'PUBLISHED'
      || hasEstablishedPricingPolicy({
        markupPercent: input.markupPercent,
        sellingPrice: input.sellingPrice,
        activePriceSnapshotId: input.activeSnapshotId,
        publishStatus: input.publishStatus,
        configurationStatus: input.configurationStatus,
        autoConfiguredByRuleId: input.autoConfiguredByRuleId,
      })
    if (publishedOrPolicy) findings.push('MISSING_SNAPSHOT')
  }

  if (input.publishStatus === 'PUBLISHED' && !input.retailLinked) {
    findings.push('MISSING_RETAIL')
  }

  if (input.retailLinked && input.retailPriceUSD != null && Math.abs(input.retailPriceUSD - selling) >= COST_CHANGE_TOLERANCE) {
    findings.push('RETAIL_PARITY_MISMATCH')
  }

  return findings.length > 0 ? findings : ['OK']
}

const AUTO_APPLY_CLASSES: ReconciliationClassification[] = [
  // NOTE: UNPRICED_RULE_AVAILABLE is intentionally NOT here. A matching active
  // PackageConfigurationRule proves a policy COULD be applied, not that an
  // administrator configured THIS package. Auto-pricing unconfigured inventory
  // from a matching rule violates the OneSIM multi-provider architecture
  // (inventory exposure ≠ product). These rows are report-only.
  'BELOW_COST_REPRICE',
  'STALE_SNAPSHOT_COST',
  'RETAIL_PARITY_MISMATCH',
]

const NEVER_AUTO_APPLY: ReconciliationClassification[] = [
  'UNPRICED_RULE_AVAILABLE',
  'UNPRICED_NO_RULE',
  'MISSING_RETAIL',
  'COST_UNAVAILABLE',
  'REQUIRES_PRICING',
]

export function isAutoApplicable(classifications: ReconciliationClassification[]): boolean {
  // A package is never auto-applied if any never-auto class is present. This
  // makes MISSING_RETAIL block retail-creating mutations, and makes
  // UNPRICED_RULE_AVAILABLE / UNPRICED_NO_RULE report-only regardless of any
  // other auto class.
  if (classifications.some(c => NEVER_AUTO_APPLY.includes(c))) return false
  return classifications.some(c => AUTO_APPLY_CLASSES.includes(c))
}

/**
 * Build the reconciliation result for one package. Pure with respect to the
 * provided data — the caller fetches DB rows and passes them in.
 */
export function reconcileProviderPackage(input: ClassificationInput): PackageReconciliationResult {
  const classifications = classifyPackage(input)
  const applyAllowed = isAutoApplicable(classifications)
  const establishedPolicy = hasEstablishedPricingPolicy({
    markupPercent: input.markupPercent,
    sellingPrice: input.sellingPrice,
    activePriceSnapshotId: input.activeSnapshotId,
    publishStatus: input.publishStatus,
    configurationStatus: input.configurationStatus,
    autoConfiguredByRuleId: input.autoConfiguredByRuleId,
  })

  let proposedAction = 'none (OK)'
  if (classifications.includes('COST_UNAVAILABLE')) {
    proposedAction = 'report only — no cost to price'
  } else if (classifications.includes('MISSING_RETAIL')) {
    proposedAction = 'MANUAL REVIEW — missing retail product; reconciliation will not create one'
  } else if (classifications.includes('REQUIRES_PRICING')) {
    proposedAction = 'keep REQUIRES_PRICING — no fabrication'
  } else if (classifications.includes('UNPRICED_RULE_AVAILABLE')) {
    proposedAction = 'REPORT ONLY — matching pricing rule exists; explicit admin configuration required'
  } else if (classifications.includes('UNPRICED_NO_RULE')) {
    proposedAction = 'REPORT ONLY — no applicable rule; explicit admin configuration required'
  } else if (classifications.includes('MISSING_SNAPSHOT')) {
    proposedAction = 'MANUAL REVIEW — snapshot/policy history insufficient for automatic repair'
  } else if (applyAllowed) {
    if (classifications.includes('STALE_SNAPSHOT_COST') || classifications.includes('BELOW_COST_REPRICE')) {
      proposedAction = 'canonical forward reprice → new current snapshot'
    } else if (classifications.includes('RETAIL_PARITY_MISMATCH')) {
      proposedAction = 'canonical retail parity sync'
    }
  }

  const reason = classifications.join(' + ') || 'OK'

  return {
    id: '', // filled by the orchestration layer
    providerPlanId: '',
    name: '',
    costPrice: Number(input.costPrice),
    sellingPrice: input.sellingPrice != null ? Number(input.sellingPrice) : null,
    markupPercent: input.markupPercent != null ? Number(input.markupPercent) : null,
    pricingStatus: input.pricingStatus,
    publishStatus: input.publishStatus,
    configurationStatus: input.configurationStatus,
    autoConfiguredByRuleId: input.autoConfiguredByRuleId,
    activeSnapshotId: input.activeSnapshotId,
    hasActiveSnapshot: !!input.activeSnapshotId,
    hasRetail: input.retailLinked,
    historicalPriceSnapshot: null,
    historicalSnapshotCost: input.activeSnapshot ? snapCost(input.activeSnapshot as any) : null,
    retailPriceUSD: input.retailPriceUSD,
    rule: input.rule,
    classifications,
    applyAllowed,
    proposedAction,
    reason,
    establishedPolicy,
  }
}

/**
 * Apply the conservative, deterministic fix for one package. Returns an outcome
 * object. Never publishes, never deletes, never creates retail.
 *
 * The mutation gate re-enforces policy here (not just in the report): a row is
 * only mutated when isAutoApplicable() passes AND — for any recalc path — the
 * package carries established package-level pricing/configuration intent.
 */
export async function applyPackageReconciliation(
  packageRow: {
    id: string
    providerPlanId: string
    publishStatus: string | null
    classifications: ReconciliationClassification[]
  },
  pricingResult: PackageReconciliationResult,
): Promise<{ applied: boolean; skipped: boolean; error?: string }> {
  // First gate: the classification set itself must be safe to auto-apply.
  if (!isAutoApplicable(pricingResult.classifications)) {
    return { applied: false, skipped: true }
  }

  // Second gate: any path that derives pricing (BELOW_COST / STALE_SNAPSHOT /
  // missing-snapshot forward reprice) requires established package-level intent.
  // A bare matching PackageConfigurationRule is NOT intent evidence.
  const requiresReprice = pricingResult.classifications.some(c =>
    ['BELOW_COST_REPRICE', 'STALE_SNAPSHOT_COST'].includes(c))
  if (requiresReprice && !pricingResult.establishedPolicy) {
    return { applied: false, skipped: true, error: 'no established package-level pricing policy' }
  }

  // RETAIL_PARITY_MISMATCH alone is retail-only. Everything else goes through
  // the canonical pricing engine (which creates a fresh snapshot).
  const retailOnly = pricingResult.classifications.includes('RETAIL_PARITY_MISMATCH')
    && !pricingResult.classifications.includes('STALE_SNAPSHOT_COST')
    && !pricingResult.classifications.includes('BELOW_COST_REPRICE')
    && !pricingResult.classifications.includes('UNPRICED_RULE_AVAILABLE')

  try {
    if (retailOnly) {
      await syncRetailFromPackage(packageRow.id)
      return { applied: true, skipped: false }
    }

    const result = await recalculatePackagePrice(packageRow.id, 'PROVIDER_COST_CHANGED')
    if (!result.success) {
      return {
        applied: false,
        skipped: true,
        error: result.reason || result.pricingStatus || 'recalculatePackagePrice failed',
      }
    }

    // A repriced PUBLISHED package must keep retail in parity through the
    // canonical sync. Never create a retail row — sync only updates linked rows.
    if (packageRow.publishStatus === 'PUBLISHED') {
      await syncRetailFromPackage(packageRow.id)
    }

    return { applied: true, skipped: false }
  } catch (e: any) {
    return { applied: false, skipped: true, error: e?.message?.substring(0, 300) || 'unknown error' }
  }
}

/** Canonical retail parity sync for a provider package (updates linked rows only). */
async function syncRetailFromPackage(packageId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const pp = await tx.providerPackage.findUnique({
      where: { id: packageId },
      select: {
        id: true, name: true, dataGB: true, validityDays: true, costPrice: true, currency: true,
        sellingPrice: true, sellingCurrency: true, markupPercent: true, providerPlanId: true,
        providerId: true, publishStatus: true,
      },
    })
    if (!pp) return
    await syncProviderPackageToPublishedProducts(tx, {
      id: pp.id,
      name: pp.name,
      dataGB: pp.dataGB,
      validityDays: pp.validityDays,
      costPrice: pp.costPrice,
      currency: pp.currency,
      sellingPrice: pp.sellingPrice,
      sellingCurrency: pp.sellingCurrency,
      markupPercent: pp.markupPercent,
      providerPlanId: pp.providerPlanId,
      providerId: pp.providerId,
      publishStatus: pp.publishStatus,
    })
  })
}

/**
 * Full reconciliation scan for a provider.
 *
 * @param providerId   exact provider id
 * @param providerCode exact provider code (fail-closed caller must pre-verify)
 * @param options      optional narrowing: planId or single classification
 */
export async function reconcileProviderCatalog(
  providerId: string,
  providerCode: string,
  providerName: string,
  options?: { planId?: string; classification?: ReconciliationClassification },
): Promise<ReconciliationSummary> {
  const rule = await resolveProviderPricingRule(providerId)

  const where: any = { providerId }
  if (options?.planId) where.providerPlanId = options.planId

  const packages = await prisma.providerPackage.findMany({
    where,
    include: {
      activePriceSnapshot: true,
      publishedAs: { select: { priceUSD: true } },
      configuredByRule: { select: { id: true, name: true } },
    },
    orderBy: { providerPlanId: 'asc' },
  })

  const counts: Record<ReconciliationClassification, number> = {
    OK: 0, UNPRICED_RULE_AVAILABLE: 0, UNPRICED_NO_RULE: 0, BELOW_COST_REPRICE: 0,
    STALE_SNAPSHOT_COST: 0, RETAIL_PARITY_MISMATCH: 0, MISSING_RETAIL: 0,
    MISSING_SNAPSHOT: 0, COST_UNAVAILABLE: 0, REQUIRES_PRICING: 0,
  }

  const rows: PackageReconciliationResult[] = []
  for (const pp of packages as any[]) {
    const selling = pp.sellingPrice != null ? Number(pp.sellingPrice) : null
    const hasRetail = !!pp.publishedAs
    let retailPriceUSD: number | null = null
    if (pp.publishedAs?.priceUSD != null) retailPriceUSD = Number(pp.publishedAs.priceUSD)

    const input: ClassificationInput = {
      costPrice: Number(pp.costPrice),
      sellingPrice: selling,
      markupPercent: pp.markupPercent != null ? Number(pp.markupPercent) : null,
      pricingStatus: pp.pricingStatus,
      publishStatus: pp.publishStatus,
      configurationStatus: pp.configurationStatus,
      activeSnapshotId: pp.activePriceSnapshotId,
      activeSnapshot: pp.activePriceSnapshot ?? null,
      retailLinked: hasRetail,
      retailPriceUSD,
      rule,
      autoConfiguredByRuleId: pp.autoConfiguredByRuleId,
    }

    const result = reconcileProviderPackage(input)
    result.id = pp.id
    result.providerPlanId = pp.providerPlanId
    result.name = pp.name

    if (options?.classification && !result.classifications.includes(options.classification)) continue

    for (const c of new Set(result.classifications)) counts[c]++
    rows.push(result)
  }

  return {
    providerId,
    providerCode,
    providerName,
    total: rows.length,
    counts,
    rows,
    failures: [],
    applied: 0,
    unchanged: 0,
  }
}