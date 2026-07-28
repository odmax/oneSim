/**
 * OneSIM Catalog Automation Engine — Phase 3A
 * =============================================
 *
 * THIS MODULE ORCHESTRATES EXISTING SERVICES — IT NEVER DUPLICATES LOGIC.
 *
 * ## Responsibilities
 * - Detect changes between provider sync cycles (new/updated/removed packages).
 * - Classify packages (NEW, UPDATED, READY_FOR_REVIEW, UNCHANGED, NEEDS_ATTENTION).
 * - Generate structured automation reports.
 * - Build a review queue for administrator approval.
 *
 * ## What does NOT belong here
 * - Database access (no Prisma imports).
 * - Rule matching, pricing, optimization (delegates to existing engines).
 * - Publishing or catalog updates.
 *
 * ## Dependency Direction
 * This module depends on:
 * - `@/lib/pricing/types.ts` (DTOs)
 * It NEVER imports from Prisma, server actions, or catalog services.
 *
 * @module catalog-automation
 */

import type { PricingRuleSummary, ProviderPackageSummary } from '@/lib/pricing/types'

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type PackageClass = 'NEW' | 'UPDATED' | 'READY_FOR_REVIEW' | 'UNCHANGED' | 'NEEDS_ATTENTION'
export type ChangeField = 'cost' | 'data' | 'validity' | 'country' | 'network' | 'speed' | 'apn' | 'roaming' | 'activation' | 'name' | 'sku'
export type ReviewAction = 'CONFIGURE' | 'REVIEW_PRICING' | 'SWITCH_PROVIDER' | 'ARCHIVE' | 'PUBLISH' | 'NO_ACTION'

export interface ChangeDiff {
  field: ChangeField
  before: string | number | null
  after: string | number | null
  significant: boolean
}

export interface PackageChange {
  packageId: string
  packageName: string
  providerId: string
  providerName: string
  providerCode: string
  /** What kind of change occurred */
  event: 'new' | 'updated' | 'removed' | 'unchanged'
  /** Detailed field-level diffs */
  changes: ChangeDiff[]
  /** Significant changes (cost, data, validity, country) */
  hasSignificantChanges: boolean
}

export interface ClassifiedPackage {
  packageId: string
  packageName: string
  providerName: string
  classification: PackageClass
  /** Human-readable reason for classification */
  reason: string
  /** Change summary (if any) */
  change?: PackageChange
  /** Recommended action for the admin */
  suggestedAction: ReviewAction
  /** Confidence in the classification (0-100) */
  confidence: number
  /** Whether this is ready for the review queue */
  needsReview: boolean
}

export interface AutomationReport {
  /** When the automation ran */
  generatedAt: Date
  /** Counts by event type */
  changeSummary: {
    newPackages: number
    updatedPackages: number
    removedPackages: number
    unchangedPackages: number
  }
  /** Counts by classification */
  classificationSummary: {
    readyForReview: number
    needsAttention: number
    newPackages: number
    updatedPackages: number
    unchanged: number
  }
  /** Prices that changed */
  pricingChanges: {
    count: number
    averageChangePercent: number | null
    increases: number
    decreases: number
  }
  /** Estimated impact */
  estimatedImpact: {
    estimatedProfitImpact: number | null
    estimatedCostSavings: number | null
    currency: string
  }
}

export interface ReviewQueueItem {
  packageId: string
  packageName: string
  providerName: string
  classification: PackageClass
  reason: string
  suggestedAction: ReviewAction
  changes: ChangeDiff[]
  confidence: number
  /** Optional recommendation from optimization engine */
  recommendedProvider?: string
}

export interface AutomationResult {
  report: AutomationReport
  /** All classified packages */
  packages: ClassifiedPackage[]
  /** Packages needing review */
  reviewQueue: ReviewQueueItem[]
  /** Duration in ms */
  durationMs: number
}

// ═══════════════════════════════════════════════════════════════════
// ENGINE
// ═══════════════════════════════════════════════════════════════════

const SIGNIFICANT_FIELDS: Set<ChangeField> = new Set(['cost', 'data', 'validity', 'country'])

/**
 * Compare two snapshots of the same package and detect what changed.
 */
export function detectChanges(
  packageId: string,
  packageName: string,
  providerId: string,
  providerName: string,
  providerCode: string,
  before: Partial<Record<ChangeField, string | number | null>> | null,
  after: Partial<Record<ChangeField, string | number | null>>,
): PackageChange {
  const fields: ChangeField[] = ['cost', 'data', 'validity', 'country', 'network', 'speed', 'apn', 'roaming', 'activation', 'name', 'sku']
  const changes: ChangeDiff[] = []
  let event: PackageChange['event'] = 'unchanged'

  if (!before) {
    event = 'new'
  } else if (after === null || (after as any)._removed) {
    event = 'removed'
  } else {
    let hasAnyChange = false
    for (const field of fields) {
      const b = before[field]
      const a = after[field]
      if (b !== a) {
        hasAnyChange = true
        changes.push({
          field,
          before: b ?? null,
          after: a ?? null,
          significant: SIGNIFICANT_FIELDS.has(field),
        })
      }
    }
    if (hasAnyChange) event = 'updated'
  }

  const hasSignificantChanges = changes.some(c => c.significant)

  return { packageId, packageName, providerId, providerName, providerCode, event, changes, hasSignificantChanges }
}

/**
 * Classify a package based on its change event and state.
 */
export function classifyPackage(
  change: PackageChange,
  hasPricing: boolean,
  hasProviderIntel: boolean,
  isAlreadyPublished: boolean,
): ClassifiedPackage {
  let classification: PackageClass
  let reason: string
  let suggestedAction: ReviewAction
  let confidence = 50
  let needsReview = false

  if (change.event === 'new') {
    classification = 'NEW'
    reason = 'Newly imported provider package'
    suggestedAction = 'CONFIGURE'
    confidence = 80
    needsReview = true
  } else if (change.event === 'removed') {
    classification = 'NEEDS_ATTENTION'
    reason = 'Package has been removed from provider catalog'
    suggestedAction = 'ARCHIVE'
    confidence = 90
    needsReview = true
  } else if (change.event === 'unchanged') {
    classification = 'UNCHANGED'
    reason = 'No changes detected'
    suggestedAction = 'NO_ACTION'
    needsReview = false
  } else if (change.hasSignificantChanges && change.changes.some(c => c.field === 'cost')) {
    if (!hasPricing) {
      classification = 'NEEDS_ATTENTION'
      reason = `Cost changed from ${change.changes.find(c => c.field === 'cost')?.before} to ${change.changes.find(c => c.field === 'cost')?.after} — requires repricing`
      suggestedAction = 'REVIEW_PRICING'
      confidence = 70
      needsReview = true
    } else {
      classification = 'UPDATED'
      reason = `Cost changed (${change.changes.find(c => c.field === 'cost')?.before} → ${change.changes.find(c => c.field === 'cost')?.after}), pricing already configured`
      suggestedAction = 'REVIEW_PRICING'
      confidence = 60
      needsReview = true
    }
  } else if (change.hasSignificantChanges) {
    classification = 'UPDATED'
    reason = `Significant attribute changes: ${change.changes.filter(c => c.significant).map(c => c.field).join(', ')}`
    suggestedAction = 'CONFIGURE'
    confidence = 65
    needsReview = true
  } else if (change.event === 'updated') {
    classification = 'READY_FOR_REVIEW'
    reason = 'Minor changes detected — review recommended'
    suggestedAction = 'NO_ACTION'
    confidence = 30
    needsReview = isAlreadyPublished
  } else {
    classification = 'UNCHANGED'
    reason = 'No significant changes'
    suggestedAction = 'NO_ACTION'
    needsReview = false
  }

  return {
    packageId: change.packageId,
    packageName: change.packageName,
    providerName: change.providerName,
    classification,
    reason,
    change,
    suggestedAction,
    confidence,
    needsReview,
  }
}

/**
 * Main automation entry point.
 *
 * Accepts a batch of before/after package snapshots and runs
 * the full automation pipeline:
 *
 *   1. Detect changes (new / updated / removed / unchanged)
 *   2. Classify packages
 *   3. Generate automation report
 *   4. Build review queue
 *
 * All pricing/provider/optimization operations are deferred to
 * their respective engines via the calling server action.
 * This function focuses ONLY on change detection and classification.
 */
export function runCatalogAutomation(
  packages: Array<{
    packageId: string
    packageName: string
    providerId: string
    providerName: string
    providerCode: string
    before: Partial<Record<ChangeField, string | number | null>> | null
    after: Partial<Record<ChangeField, string | number | null>>
    hasPricing: boolean
    isPublished: boolean
  }>,
): AutomationResult {
  const startTime = Date.now()
  const classified: ClassifiedPackage[] = []

  for (const pkg of packages) {
    const change = detectChanges(
      pkg.packageId, pkg.packageName,
      pkg.providerId, pkg.providerName, pkg.providerCode,
      pkg.before, pkg.after,
    )
    const classification = classifyPackage(change, pkg.hasPricing, false, pkg.isPublished)
    classified.push(classification)
  }

  // ── Build report ──
  const newPackages = classified.filter(c => c.classification === 'NEW').length
  const updatedPackages = classified.filter(c => c.classification === 'UPDATED').length
  const needsAttention = classified.filter(c => c.classification === 'NEEDS_ATTENTION').length
  const readyForReview = classified.filter(c => c.classification === 'READY_FOR_REVIEW').length
  const unchanged = classified.filter(c => c.classification === 'UNCHANGED').length

  // Pricing changes
  const pricingChanges = classified.filter(c =>
    c.change?.changes.some(ch => ch.field === 'cost' && ch.significant)
  )
  const increases = pricingChanges.filter(pc => {
    const cost = pc.change!.changes.find(c => c.field === 'cost')
    const b = typeof cost?.before === 'number' ? cost.before : parseFloat(String(cost?.before ?? '0'))
    const a = typeof cost?.after === 'number' ? cost.after : parseFloat(String(cost?.after ?? '0'))
    return a > b
  }).length
  const decreases = pricingChanges.length - increases
  const avgChange = pricingChanges.length > 0 ? pricingChanges.reduce((sum, pc) => {
    const cost = pc.change!.changes.find(c => c.field === 'cost')
    const b = typeof cost?.before === 'number' ? cost.before : parseFloat(String(cost?.before ?? '0'))
    const a = typeof cost?.after === 'number' ? cost.after : parseFloat(String(cost?.after ?? '0'))
    return b > 0 ? sum + ((a - b) / b) * 100 : sum
  }, 0) / pricingChanges.length : null

  const report: AutomationReport = {
    generatedAt: new Date(),
    changeSummary: {
      newPackages: classified.filter(c => c.change?.event === 'new').length,
      updatedPackages: classified.filter(c => c.change?.event === 'updated').length,
      removedPackages: classified.filter(c => c.change?.event === 'removed').length,
      unchangedPackages: classified.filter(c => c.change?.event === 'unchanged').length,
    },
    classificationSummary: {
      readyForReview,
      needsAttention,
      newPackages,
      updatedPackages,
      unchanged,
    },
    pricingChanges: {
      count: pricingChanges.length,
      averageChangePercent: avgChange != null ? Math.round(avgChange * 100) / 100 : null,
      increases,
      decreases,
    },
    estimatedImpact: {
      estimatedProfitImpact: null,
      estimatedCostSavings: null,
      currency: 'USD',
    },
  }

  // ── Build review queue ──
  const reviewQueue: ReviewQueueItem[] = classified
    .filter(c => c.needsReview)
    .map(c => ({
      packageId: c.packageId,
      packageName: c.packageName,
      providerName: c.providerName,
      classification: c.classification,
      reason: c.reason,
      suggestedAction: c.suggestedAction,
      changes: c.change?.changes || [],
      confidence: c.confidence,
    }))

  return {
    report,
    packages: classified,
    reviewQueue,
    durationMs: Date.now() - startTime,
  }
}

// Types are exported inline at the top of this file.
