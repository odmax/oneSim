import { describe, it, expect } from 'vitest'
import {
  stableSortPackages,
  deduplicateById,
  takeWindow,
  priceOf,
  initialBuyCatalogPaging,
  buyCatalogApplyFilters,
  buyCatalogLoadMore,
  hasMore,
  CATALOG_PAGE_SIZE,
} from './catalog-pagination'

function pkg(id: string, price: number, dataGB = 1, validityDays = 30): any {
  return { id, unitPrice: price, priceUSD: price, dataGB, validityDays, displayName: `p${id}` }
}

describe('stableSortPackages — deterministic ordering with ID tiebreaker', () => {
  it('orders by price asc and uses id as the tiebreaker for equal prices', () => {
    const list = [
      pkg('b', 10),
      pkg('a', 10),
      pkg('z', 5),
    ]
    const sorted = stableSortPackages(list, 'price-asc')
    expect(sorted.map(p => p.id)).toEqual(['z', 'a', 'b'])
  })

  it('data-desc uses dataGB desc then id', () => {
    const sorted = stableSortPackages([pkg('b', 1, 5), pkg('a', 1, 5), pkg('c', 1, 20)], 'data-desc')
    expect(sorted.map(p => p.id)).toEqual(['c', 'a', 'b'])
  })

  it('validity-desc uses validityDays desc then id', () => {
    const sorted = stableSortPackages([pkg('b', 1, 1, 7), pkg('a', 1, 1, 7), pkg('c', 1, 1, 60)], 'validity-desc')
    expect(sorted.map(p => p.id)).toEqual(['c', 'a', 'b'])
  })

  it('is deterministic across repeated calls (stable page boundaries)', () => {
    const list = [pkg('b', 10), pkg('a', 10), pkg('c', 10), pkg('z', 5)]
    const first = stableSortPackages(list, 'price-asc')
    const second = stableSortPackages(list, 'price-asc')
    expect(first.map(p => p.id)).toEqual(second.map(p => p.id))
  })
})

describe('deduplicateById + pagination window', () => {
  it('deduplicates by id', () => {
    const out = deduplicateById([pkg('a', 1), pkg('a', 1), pkg('b', 2)])
    expect(out.map(p => p.id)).toEqual(['a', 'b'])
  })

  it('all 64 eligible products are reachable across pages with no duplicates', () => {
    const all = Array.from({ length: 64 }, (_, i) => pkg(`id-${String(i).padStart(2, '0')}`, 1 + (i % 10)))
    const sorted = stableSortPackages(all, 'price-asc')
    expect(sorted).toHaveLength(64)

    // Load More windows are cumulative render windows; the NEW items revealed
    // by each wider window must never repeat an already-rendered id.
    const seen = new Set<string>()
    let rendered = CATALOG_PAGE_SIZE
    for (; ; rendered += CATALOG_PAGE_SIZE) {
      for (const p of takeWindow(sorted, rendered)) seen.add(p.id)
      if (rendered >= sorted.length) break
    }
    // the last window must be exactly length 64 (or fewer if the data is smaller)
    expect(seen.size).toBe(64)
    expect([...seen].sort()).toEqual(all.map(p => p.id).sort())
  })

  it('stable page boundaries: first 24 are always the same 24', () => {
    const all = Array.from({ length: 64 }, (_, i) => pkg(`id-${i}`, (i * 7) % 13))
    const sortedA = stableSortPackages(all, 'price-asc')
    const sortedB = stableSortPackages(all, 'price-asc')
    expect(takeWindow(sortedA, CATALOG_PAGE_SIZE).map(p => p.id)).toEqual(takeWindow(sortedB, CATALOG_PAGE_SIZE).map(p => p.id))
  })
})

describe('search beyond page one', () => {
  it('an item past the first window is reachable after filters reduce the result set', () => {
    const all = Array.from({ length: 64 }, (_, i) => pkg(`id-${i}`, 1, 1, 30))
    // Give only the LAST sorted item an unusual name
    const sorted = stableSortPackages(all.map((p, i) => (i === 63 ? { ...p, displayName: 'Zanzibar Special' } : p)), 'price-asc')
    const filtered = sorted.filter(p => (p.displayName as string).toLowerCase().includes('zanzibar'))
    expect(filtered).toHaveLength(1)
    // Even the FIRST window contains it because filters run over the whole set
    expect(takeWindow(filtered, CATALOG_PAGE_SIZE).map(p => p.id)).toContain(filtered[0].id)
  })
})

describe('paging controller — reset pagination on filter change', () => {
  it('loads more in fixed windows', () => {
    let state = initialBuyCatalogPaging()
    expect(state.visibleCount).toBe(CATALOG_PAGE_SIZE)
    state = buyCatalogLoadMore(state)
    expect(state.visibleCount).toBe(CATALOG_PAGE_SIZE * 2)
  })

  it('ANY filter change resets pagination to the first window', () => {
    let state = initialBuyCatalogPaging()
    state = buyCatalogLoadMore(state)
    state = buyCatalogLoadMore(state)
    expect(state.visibleCount).toBe(CATALOG_PAGE_SIZE * 3)
    state = buyCatalogApplyFilters(state, { search: 'mal' })
    expect(state.visibleCount).toBe(CATALOG_PAGE_SIZE)
    expect(state.filters.search).toBe('mal')
    state = buyCatalogLoadMore(state)
    state = buyCatalogApplyFilters(state, { sortMode: 'data-desc' })
    expect(state.visibleCount).toBe(CATALOG_PAGE_SIZE)
  })

  it('hasMore is false only when the whole set is rendered', () => {
    const all = Array.from({ length: 60 }, (_, i) => pkg(`id-${i}`, i))
    expect(hasMore(all, CATALOG_PAGE_SIZE)).toBe(true)
    expect(hasMore(all, 60)).toBe(false)
  })
})

describe('priceOf', () => {
  it('prefers unitPrice and falls back to priceUSD strings', () => {
    expect(priceOf({ id: '1', unitPrice: 9.99 })).toBe(9.99)
    expect(priceOf({ id: '1', priceUSD: { toString: () => '9.99' } })).toBe(9.99)
    expect(priceOf({ id: '1' })).toBe(0)
  })
})