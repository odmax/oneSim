/**
 * OneSIM Catalog Pipeline Orchestrator — Phase 3B
 * =================================================
 *
 * THIS MODULE ORCHESTRATES EXISTING SERVICES — IT NEVER DUPLICATES LOGIC.
 *
 * ## Pipeline Order
 *   1. Catalog Automation  (change detection + classification)
 *   2. Pricing Simulation  (rule impact preview)
 *   3. Provider Intelligence (provider comparison)
 *   4. Provider Optimization (best provider recommendation)
 *   5. Unified Review Record
 *
 * ## Responsibilities
 * - Sequence the end-to-end processing of provider sync results.
 * - Build a unified review queue combining all service outputs.
 * - Generate a dashboard summary with aggregated metrics.
 * - Guarantee idempotency: same input → same output.
 *
 * ## What does NOT belong here
 * - Database access (no Prisma imports).
 * - Pricing calculations (delegates to pricing-engine).
 * - Rule matching (delegates to rule-evaluator).
 * - Publishing or catalog updates.
 *
 * ## Safety
 * - NEVER publishes automatically.
 * - NEVER switches providers automatically.
 * - NEVER writes to the database.
 *
 * @module catalog-pipeline
 */

import type { AutomationResult, PackageChange, ClassifiedPackage } from '../catalog/catalog-automation'
import type { PricingRuleSummary } from '@/lib/pricing/types'
import type { OptimizationResult, OptimizationRules } from '@/lib/pricing/provider-optimization'

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type PipelineState =
  | 'DETECTED'
  | 'ANALYZED'
  | 'SIMULATED'
  | 'OPTIMIZED'
  | 'READY_FOR_REVIEW'
  | 'SKIPPED'
  | 'ERROR'

export const PIPELINE_ORDER: PipelineState[] = ['DETECTED', 'ANALYZED', 'SIMULATED', 'OPTIMIZED', 'READY_FOR_REVIEW']

export interface PipelineReviewItem {
  packageId: string
  packageName: string
  providerName: string
  /** Pipeline processing state */
  state: PipelineState
  /** Classification from catalog automation */
  classification: string
  /** Reason for classification */
  reason: string
  /** Field-level changes detected */
  changes: { field: string; before: any; after: any; significant: boolean }[]
  /** Current pricing (from catalog) */
  currentSellingPrice: number | null
  /** Simulated pricing (from simulation) */
  simulatedSellingPrice: number | null
  /** Current margin % */
  currentMargin: number | null
  /** Simulated margin % */
  simulatedMargin: number | null
  /** Current provider */
  currentProvider: string | null
  /** Recommended provider (from optimization) */
  recommendedProvider: string | null
  /** Cost difference vs current */
  costDifference: number | null
  /** Profit difference vs current */
  profitDifference: number | null
  /** Confidence in the recommendation */
  confidence: number
  /** Suggested action for admin */
  suggestedAction: string
  /** Validation warnings */
  warnings: string[]
  /** Error message if state is ERROR */
  error?: string
  /** Why this was skipped (if state is SKIPPED) */
  skipReason?: string
}

export interface PipelineResult {
  /** Total packages processed */
  totalProcessed: number
  /** Summary metrics grouped by state */
  byState: Record<PipelineState, number>
  /** Per-package review items */
  reviewItems: PipelineReviewItem[]
  /** Count by suggested action */
  bySuggestedAction: Record<string, number>
  /** Total validation warnings */
  totalWarnings: number
  /** Estimated total revenue impact */
  estimatedRevenueImpact: number | null
  /** Estimated total profit impact */
  estimatedProfitImpact: number | null
  /** Currency */
  currency: string
  /** Duration in ms */
  durationMs: number
  /** Processing log for debugging */
  processingLog: string[]
}

// ═══════════════════════════════════════════════════════════════════
// HELPER — build a review item from a classified package
// ═══════════════════════════════════════════════════════════════════

function initialReviewItem(pkg: ClassifiedPackage): PipelineReviewItem {
  return {
    packageId: pkg.packageId,
    packageName: pkg.packageName,
    providerName: pkg.providerName,
    state: 'DETECTED',
    classification: pkg.classification,
    reason: pkg.reason,
    changes: (pkg.change?.changes || []).map(c => ({ field: c.field, before: c.before, after: c.after, significant: c.significant })),
    currentSellingPrice: null,
    simulatedSellingPrice: null,
    currentMargin: null,
    simulatedMargin: null,
    currentProvider: null,
    recommendedProvider: null,
    costDifference: null,
    profitDifference: null,
    confidence: pkg.confidence,
    suggestedAction: pkg.suggestedAction,
    warnings: [],
  }
}

// ═══════════════════════════════════════════════════════════════════
// ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════

/**
 * Input to the pipeline orchestrator.
 * Accepts automation results + optional simulation/optimization data
 * from the calling server action.
 */
export interface PipelineInput {
  automation: AutomationResult
  /** Optional: per-package simulation results (pricing engine output) */
  simulations?: Map<string, { sellingPrice: number; marginPercent: number } | null>
  /** Optional: per-package optimization results */
  optimizations?: Map<string, OptimizationResult | null>
  /** Optional: current catalog selling prices */
  catalogPrices?: Map<string, { sellingPrice: number; marginPercent: number; currentProvider: string } | null>
  /** Currency for the report */
  currency?: string
}

/**
 * The main pipeline orchestrator.
 *
 * Takes automation results and optional simulation/optimization data
 * and produces a unified PipelineResult with a complete review queue.
 */
export function runCatalogPipeline(input: PipelineInput): PipelineResult {
  const startTime = Date.now()
  const log: string[] = []
  const currency = input.currency || 'USD'
  const reviewItems: PipelineReviewItem[] = []

  log.push(`Pipeline started at ${new Date().toISOString()}`)
  log.push(`Processing ${input.automation.packages.length} packages`)

  for (const pkg of input.automation.packages) {
    const item = initialReviewItem(pkg)
    item.state = 'ANALYZED'

    // ── Step 3: Attach pricing simulation ──
    const sim = input.simulations?.get(pkg.packageId)
    if (sim) {
      item.simulatedSellingPrice = sim.sellingPrice
      item.simulatedMargin = sim.marginPercent
      item.state = 'SIMULATED'
    }

    // ── Step 4: Attach catalog pricing ──
    const cat = input.catalogPrices?.get(pkg.packageId)
    if (cat) {
      item.currentSellingPrice = cat.sellingPrice
      item.currentMargin = cat.marginPercent
      item.currentProvider = cat.currentProvider
    }

    // ── Step 5: Attach optimization ──
    const opt = input.optimizations?.get(pkg.packageId)
    if (opt) {
      item.recommendedProvider = opt.recommendedProvider?.providerName || null
      item.costDifference = opt.costDifference
      item.profitDifference = opt.profitDifference
      item.confidence = Math.max(item.confidence, opt.confidence)
      item.state = 'OPTIMIZED'
    }

    // ── Determine final state ──
    if (pkg.classification === 'UNCHANGED') {
      item.state = 'SKIPPED'
      item.skipReason = 'No changes detected'
    } else if (pkg.classification === 'NEW' || pkg.classification === 'NEEDS_ATTENTION' || pkg.classification === 'UPDATED') {
      item.state = 'READY_FOR_REVIEW'
    } else if (pkg.classification === 'READY_FOR_REVIEW') {
      item.state = 'READY_FOR_REVIEW'
    }

    // ── Validation warnings ──
    if (item.currentSellingPrice != null && item.simulatedSellingPrice != null && item.simulatedSellingPrice < item.currentSellingPrice) {
      item.warnings.push(`Simulated price ($${item.simulatedSellingPrice.toFixed(2)}) is below current ($${item.currentSellingPrice.toFixed(2)})`)
    }

    if (item.costDifference != null && item.costDifference < 0) {
      item.warnings.push(`Recommended provider costs $${Math.abs(item.costDifference).toFixed(2)} more`)
    }

    reviewItems.push(item)
  }

  // ── Aggregate metrics ──
  const byState: Record<PipelineState, number> = {
    DETECTED: 0, ANALYZED: 0, SIMULATED: 0, OPTIMIZED: 0,
    READY_FOR_REVIEW: 0, SKIPPED: 0, ERROR: 0,
  }
  for (const item of reviewItems) {
    byState[item.state] = (byState[item.state] || 0) + 1
  }

  const bySuggestedAction: Record<string, number> = {}
  for (const item of reviewItems) {
    bySuggestedAction[item.suggestedAction] = (bySuggestedAction[item.suggestedAction] || 0) + 1
  }

  const totalWarnings = reviewItems.reduce((s, i) => s + i.warnings.length, 0)

  // Revenue/profit impact
  let revenueImpact = 0
  let profitImpact = 0
  for (const item of reviewItems) {
    if (item.currentSellingPrice != null && item.simulatedSellingPrice != null) {
      revenueImpact += item.simulatedSellingPrice - item.currentSellingPrice
    }
    if (item.profitDifference != null) {
      profitImpact += item.profitDifference
    }
  }

  log.push(`Pipeline complete: ${reviewItems.length} items, ${byState.READY_FOR_REVIEW} ready for review`)
  log.push(`Duration: ${Date.now() - startTime}ms`)

  return {
    totalProcessed: reviewItems.length,
    byState,
    reviewItems,
    bySuggestedAction,
    totalWarnings,
    estimatedRevenueImpact: revenueImpact !== 0 ? revenueImpact : null,
    estimatedProfitImpact: profitImpact !== 0 ? profitImpact : null,
    currency,
    durationMs: Date.now() - startTime,
    processingLog: log,
  }
}

// Types are exported inline at the top of this file.
