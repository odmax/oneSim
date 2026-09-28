/**
 * Pure payload builder for the Provider Catalog "Configure Package" modal.
 *
 * WHY THIS EXISTS
 * ---------------
 * The previous implementation sent every pre-filled form field on every save.
 * For an already-PUBLISHED package this re-forced the canonical publish
 * pipeline on each edit (finalize → recalculate-from-rules → new snapshot →
 * republish), so the second edit failed or silently discarded the admin's
 * price ("edited successfully only once"). It also parsed prices with
 * `parseFloat`, corrupting `21,49` → `21`.
 *
 * This module builds a DELTA payload (only the fields the operator actually
 * changed) with explicit locale-safe decimal parsing. `publishStatus` is only
 * included when it really changed, so re-saving a published product is an
 * ordinary configuration edit, never an implicit republish.
 *
 * PURE — no React, no server, no prisma. Fully unit-testable.
 */

import { parseDecimalInput } from './decimal-input'
import type { PricingMutationIntent } from '@/lib/pricing/pricing-engine'

/** Persisted snapshot of an editable provider package row (client prop shape). */
export interface EditablePackageSnapshot {
  costPrice?: { toString(): string } | string | number | null
  sellingPrice?: { toString(): string } | string | number | null
  sellingCurrency?: string | null
  markupPercent?: { toString(): string } | string | number | null
  pricingMode?: string | null
  publishStatus?: string | null
  configurationStatus?: string | null
  notes?: string | null
}

/** Current modal form field values (all strings as typed). */
export interface EditFormValues {
  costPrice?: string
  sellingPrice?: string
  sellingCurrency?: string
  markupPercent?: string
  pricingMode?: string
  publishStatus?: string
  configurationStatus?: string
  notes?: string
  pricingIntent?: PricingMutationIntent
}

export interface SingleEditPayload {
  data: Record<string, unknown>
  hasChanges: boolean
  /** Fields that held text which could not be parsed as a finite number. */
  parsingIssues: string[]
}

/** Stringify a persisted Decimal-ish value for a form diff. */
function persistString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return String((v as any).toString?.() ?? '')
}

function parseNumberField(
  typed: string | undefined,
  persisted: unknown,
  label: string,
  issues: string[],
): { changed: boolean; value?: number } {
  const raw = (typed ?? '').trim()
  if (raw === '') return { changed: false }
  const persistedText = persistString(persisted)
  // Character-identical to the persisted value → not a real edit (also avoids a
  // misleading "edited" intent for pre-filled values).
  if (raw === persistedText) return { changed: false }
  const n = parseDecimalInput(raw)
  if (n === null) {
    issues.push(label)
    return { changed: false }
  }
  return { changed: true, value: n }
}

export function buildSinglePackageEditPayload(
  pkg: EditablePackageSnapshot,
  form: EditFormValues,
): SingleEditPayload {
  const data: Record<string, unknown> = {}
  const issues: string[] = []
  let pricingFieldChanged = false

  const cost = parseNumberField(form.costPrice, pkg.costPrice, 'Cost Price', issues)
  const selling = parseNumberField(form.sellingPrice, pkg.sellingPrice, 'Selling Price', issues)
  const markup = parseNumberField(form.markupPercent, pkg.markupPercent, 'Markup %', issues)

  if (cost.changed) {
    data.costPrice = cost.value
    pricingFieldChanged = true
  }
  if (selling.changed) {
    data.sellingPrice = selling.value
    pricingFieldChanged = true
  }
  if (markup.changed) {
    data.markupPercent = markup.value
    pricingFieldChanged = true
  }

  if (form.sellingCurrency !== (pkg.sellingCurrency || '')) {
    data.sellingCurrency = form.sellingCurrency || ''
  }
  if (form.pricingMode !== (pkg.pricingMode || '')) {
    data.pricingMode = form.pricingMode || ''
  }
  // publishStatus is DELTA-ONLY. For an already-published package the modal
  // re-fills 'PUBLISHED', so unless the operator actively changes it here it
  // is never sent — preventing implicit re-publish on repeated edits.
  if (form.publishStatus !== (pkg.publishStatus || '')) {
    data.publishStatus = form.publishStatus || ''
  }
  if (form.configurationStatus !== (pkg.configurationStatus || '')) {
    data.configurationStatus = form.configurationStatus || ''
  }
  if (form.notes !== (pkg.notes || '')) {
    data.notes = form.notes ?? ''
  }

  // Authority intent is meaningful ONLY when a pricing field actually changed.
  if (pricingFieldChanged && form.pricingIntent && form.pricingIntent !== 'NONE') {
    data.pricingIntent = form.pricingIntent
  }

  return { data, hasChanges: Object.keys(data).length > 0, parsingIssues: issues }
}

/**
 * Quantity clamp for the Buy eSIM card: 1..100, integer, no NaN/infinity.
 * Explicitly de-duplicates the "2.5"→?? and empty→1 cases.
 */
export function clampQuantity(value: string | number): number {
  const n = typeof value === 'string' ? Math.round(Number(value.replace(',', '.'))) : Math.round(value)
  if (!Number.isFinite(n)) return 1
  return Math.min(100, Math.max(1, n))
}