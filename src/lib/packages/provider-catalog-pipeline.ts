/**
 * Canonical Admin Provider Catalog state pipeline.
 *
 * Eliminates state-filter approximation: the SAME canonical
 * classifyProviderPackageState result drives (1) the per-row State chip,
 * (2) the state tab counts, (3) selected-state filtering, and (4) pagination.
 * The COMPLETE applicable ProviderPackage population is classified first;
 * the state filter is applied to that classified population; only then is the
 * deterministic page window sliced. An already-paginated subset is never
 * filtered, so no rows are lost and tab counts are global (never page-local).
 *
 * PURE — no prisma, no server, fully unit-testable.
 */

import { getPackagePurchaseReadiness } from './purchase-readiness'
import { classifyProviderPackageState, type ProviderPackageAdminState } from './provider-package-state'

export type ProviderCatalogAdminTab = ProviderPackageAdminState

export interface ProviderCatalogRowLike {
  id: string
  createdAt?: Date | string | null
  costStatus?: string | null
  pricingStatus?: string | null
  publishStatus?: string | null
  configurationStatus?: string | null
  activePriceSnapshotId?: string | null
  sellingPrice?: unknown
  costPrice?: unknown
  isAvailable?: boolean | null
  provider?: { status?: string | null; enabledCapabilities?: unknown; code?: string | null } | null
}

export interface ClassifiedProviderCatalogRow {
  row: ProviderCatalogRowLike
  ready: boolean
  reasons: string[]
  state: ProviderPackageAdminState
}

export interface ProviderCatalogStateCounts {
  total: number
  READY: number
  NEEDS_CONFIGURATION: number
  NEEDS_PRICING: number
  UNAVAILABLE_QUARANTINED: number
  DRAFT_UNPUBLISHED: number
  BLOCKED_OTHER: number
}

export interface ProviderCatalogView {
  counts: ProviderCatalogStateCounts
  orderedIds: string[]
  total: number
  totalPages: number
  pageRows: ClassifiedProviderCatalogRow[]
}

export function classifyProviderCatalogRows(rows: ProviderCatalogRowLike[]): ClassifiedProviderCatalogRow[] {
  return rows.map(row => {
    const readiness = getPackagePurchaseReadiness({
      providerPkg: {
        costStatus: row.costStatus || null,
        pricingStatus: row.pricingStatus || null,
        publishStatus: row.publishStatus || null,
        configurationStatus: row.configurationStatus || null,
        activePriceSnapshotId: row.activePriceSnapshotId || null,
        sellingPrice: row.sellingPrice,
        costPrice: row.costPrice,
        isAvailable: row.isAvailable ?? undefined,
      } as any,
      provider: row.provider
        ? { status: row.provider.status || '', enabledCapabilities: row.provider.enabledCapabilities, code: row.provider.code || null }
        : null,
    })
    const state = classifyProviderPackageState({
      isAvailable: row.isAvailable,
      purchaseReady: readiness.ready,
      configurationStatus: row.configurationStatus,
      publishStatus: row.publishStatus,
      pricingStatus: row.pricingStatus,
      activePriceSnapshotId: row.activePriceSnapshotId,
      sellingPrice: row.sellingPrice,
      costPrice: row.costPrice,
    })
    return { row, ready: readiness.ready, reasons: readiness.reasons, state }
  })
}

function ts(v: Date | string | null | undefined): number {
  if (!v) return 0
  const n = typeof v === 'string' ? Date.parse(v) : v.getTime()
  return Number.isNaN(n) ? 0 : n
}

/** Deterministic ordering: the same ordering the table always used (createdAt
 *  desc) with the row `id` as the tiebreaker so pages are stable. */
export function sortProviderCatalogRows(classified: ClassifiedProviderCatalogRow[]): ClassifiedProviderCatalogRow[] {
  return [...classified].sort((a, b) => {
    const d = ts(b.row.createdAt) - ts(a.row.createdAt)
    if (d !== 0) return d
    return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0
  })
}

const EMPTY_COUNTS = (): ProviderCatalogStateCounts => ({
  total: 0, READY: 0, NEEDS_CONFIGURATION: 0, NEEDS_PRICING: 0, UNAVAILABLE_QUARANTINED: 0, DRAFT_UNPUBLISHED: 0, BLOCKED_OTHER: 0,
})

export function buildProviderCatalogView(params: {
  rows: ProviderCatalogRowLike[]
  state?: ProviderPackageAdminState | null
  page?: number
  pageSize?: number
}): ProviderCatalogView {
  const { rows, state = null, page = 1, pageSize = 50 } = params
  const classified = classifyProviderCatalogRows(rows)

  const counts = EMPTY_COUNTS()
  counts.total = classified.length
  for (const c of classified) counts[c.state]++

  const filtered = state ? classified.filter(c => c.state === state) : classified
  const ordered = sortProviderCatalogRows(filtered)

  const total = ordered.length
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize)
  const safePage = Math.max(1, Math.min(page, Math.max(1, totalPages || 1)))
  const start = (safePage - 1) * pageSize
  const pageRows = ordered.slice(start, start + pageSize)

  return {
    counts,
    orderedIds: ordered.map(c => c.row.id),
    total,
    totalPages,
    pageRows,
  }
}