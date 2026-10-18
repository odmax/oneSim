/**
 * Business Buy eSIM catalog pagination + deterministic ordering.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Buy grid must render EVERY customer-visible plan without silently
 * truncating the catalog. Pagination is a render-window (Load More) over the
 * full eligible dataset, so search/filter/sort always operate over ALL plans
 * — never a page. Ordering is deterministic (price/data/validity primary key +
 * the package `id` as the tiebreaker) so pages never duplicate or skip items
 * across renders, and filters reset pagination to the first window.
 *
 * PURE — used by the client component and unit-tested directly.
 */

export interface BuyCatalogPackage {
  id: string
  unitPrice?: number
  priceUSD?: unknown
  dataGB?: number
  validityDays?: number
  [key: string]: unknown
}

export type BuySortMode = 'price-asc' | 'price-desc' | 'data-desc' | 'validity-desc'

/** Render window size. Not a server limit — just how many cards render. */
export const CATALOG_PAGE_SIZE = 24

export function priceOf(p: BuyCatalogPackage): number {
  if (typeof p.unitPrice === 'number') return p.unitPrice
  const raw = p.priceUSD
  const n = typeof raw === 'number' ? raw : parseFloat(String((raw as any)?.toString?.() ?? raw ?? '0'))
  return isNaN(n) || !isFinite(n) ? 0 : n
}

/** Deduplicate by id (custom packages can map through multiple sources). */
export function deduplicateById<T extends { id: string }>(packages: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const p of packages) {
    if (!seen.has(p.id)) {
      seen.add(p.id)
      out.push(p)
    }
  }
  return out
}

/**
 * Stable deterministic ordering with a numeric primary key and `id` as the
 * final tiebreaker — equal prices never swap order between renders, so pages
 * are stable and no item is duplicated or lost at page boundaries.
 */
export function stableSortPackages<T extends BuyCatalogPackage>(packages: T[], mode: BuySortMode): T[] {
  const list = deduplicateById(packages)
  return [...list].sort((a, b) => {
    let cmp: number
    switch (mode) {
      case 'data-desc':
        cmp = (b.dataGB || 0) - (a.dataGB || 0)
        break
      case 'validity-desc':
        cmp = (b.validityDays || 0) - (a.validityDays || 0)
        break
      case 'price-desc':
        cmp = priceOf(b) - priceOf(a)
        break
      default:
        cmp = priceOf(a) - priceOf(b)
        break
    }
    if (cmp !== 0) return cmp
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** Render `rendered` items from an already-sorted list. */
export function takeWindow<T>(sorted: T[], rendered: number): T[] {
  return sorted.slice(0, Math.max(0, rendered))
}

/* ------------------------------------------------------------------------ */
/*  Paging controller state (pure) — used by CountrySearchPage               */
/* ------------------------------------------------------------------------ */

export interface BuyCatalogFiltersSnapshot {
  search: string
  countryCode: string | null
  validityDays: number
  sortMode: BuySortMode
  aiResultsActive: boolean
}

export interface BuyCatalogPagingState {
  filters: BuyCatalogFiltersSnapshot
  visibleCount: number
}

export function initialBuyCatalogPaging(): BuyCatalogPagingState {
  return {
    filters: { search: '', countryCode: null, validityDays: 0, sortMode: 'price-asc', aiResultsActive: false },
    visibleCount: CATALOG_PAGE_SIZE,
  }
}

/** Apply new filter values; ANY change resets pagination to the first window. */
export function buyCatalogApplyFilters(
  state: BuyCatalogPagingState,
  next: Partial<BuyCatalogFiltersSnapshot>,
): BuyCatalogPagingState {
  return { filters: { ...state.filters, ...next }, visibleCount: CATALOG_PAGE_SIZE }
}

export function buyCatalogLoadMore(state: BuyCatalogPagingState): BuyCatalogPagingState {
  return { ...state, filters: { ...state.filters }, visibleCount: state.visibleCount + CATALOG_PAGE_SIZE }
}

/** True when the pending filter window would render every item (nothing more to load). */
export function hasMore(sorted: unknown[], visibleCount: number): boolean {
  return visibleCount < sorted.length
}