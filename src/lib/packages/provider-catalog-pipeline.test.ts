import { describe, it, expect } from 'vitest'
import {
  buildProviderCatalogView,
  classifyProviderCatalogRows,
  sortProviderCatalogRows,
  type ProviderCatalogStateCounts,
} from './provider-catalog-pipeline'
import type { ProviderPackageAdminState } from './provider-package-state'

const VIEW_STATES: ProviderPackageAdminState[] = ['READY', 'NEEDS_CONFIGURATION', 'NEEDS_PRICING', 'UNAVAILABLE_QUARANTINED', 'DRAFT_UNPUBLISHED', 'BLOCKED_OTHER']

function readyRow(id: string, overrides: Record<string, any> = {}): any {
  return {
    id,
    createdAt: new Date(2026, 0, (parseInt(String(id).replace(/\D/g, '') || '1', 10) + 1)),
    costStatus: 'VALID',
    pricingStatus: 'READY',
    publishStatus: 'PUBLISHED',
    configurationStatus: 'CONFIGURED',
    activePriceSnapshotId: 'snap-' + id,
    sellingPrice: { toString: () => '9.99' },
    costPrice: { toString: () => '3.00' },
    isAvailable: true,
    provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'CHOICE' },
    ...overrides,
  }
}

function perRowTallies(rows: any[]): Record<ProviderPackageAdminState, number> {
  const m = { READY: 0, NEEDS_CONFIGURATION: 0, NEEDS_PRICING: 0, UNAVAILABLE_QUARANTINED: 0, DRAFT_UNPUBLISHED: 0, BLOCKED_OTHER: 0 } as Record<ProviderPackageAdminState, number>
  for (const c of classifyProviderCatalogRows(rows)) m[c.state]++
  return m
}

describe('buildProviderCatalogView — canonical state pipeline', () => {
  const rows = [
    readyRow('r1'), readyRow('r2'), readyRow('r3'),
    readyRow('q1', { isAvailable: false, configurationStatus: 'UNCONFIGURED', publishStatus: 'PUBLISHED' }),
    readyRow('q2', { isAvailable: false }),
    readyRow('c1', { configurationStatus: 'UNCONFIGURED' }),
    readyRow('c2', { configurationStatus: 'PARTIAL' }),
    readyRow('p1', { pricingStatus: 'COST_UNAVAILABLE' }),
    readyRow('p2', { sellingPrice: { toString: () => '0' } }),
    readyRow('d1', { publishStatus: 'DRAFT' }),
    readyRow('d2', { publishStatus: 'READY' }),
  ]

  it('each tab count equals the canonical per-row classifier tally over the COMPLETE population', () => {
    const expected = perRowTallies(rows)
    expect(Object.entries(expected).filter(([, n]) => n > 0).map(([s]) => s).sort()).toEqual(['DRAFT_UNPUBLISHED', 'NEEDS_CONFIGURATION', 'NEEDS_PRICING', 'READY', 'UNAVAILABLE_QUARANTINED'])

    const view = buildProviderCatalogView({ rows, pageSize: 3 })
    expect(view.counts.total).toBe(rows.length)
    for (const s of VIEW_STATES) expect(view.counts[s]).toBe(expected[s])
  })

  it('tab counts are GLOBAL, never page-local', () => {
    const view = buildProviderCatalogView({ rows, state: 'READY', page: 2, pageSize: 1 })
    expect(view.pageRows.length).toBe(1)
    expect(view.counts.READY).toBe(3)
    expect(view.total).toBe(3)
    expect(view.totalPages).toBe(3)
  })

  it('every returned row matches the selected tab', () => {
    const tabs: ProviderPackageAdminState[] = ['READY', 'NEEDS_CONFIGURATION', 'NEEDS_PRICING', 'UNAVAILABLE_QUARANTINED', 'DRAFT_UNPUBLISHED']
    for (const state of tabs) {
      const v = buildProviderCatalogView({ rows, state, pageSize: 50 })
      for (const c of v.pageRows) expect(c.state).toBe(state)
    }
  })

  it('Unavailable takes precedence over every other state', () => {
    expect(buildProviderCatalogView({ rows, state: 'UNAVAILABLE_QUARANTINED', pageSize: 50 }).orderedIds.sort()).toEqual(['q1', 'q2'])
    expect(buildProviderCatalogView({ rows, state: 'READY', pageSize: 50 }).orderedIds).not.toContain('q1')
    expect(buildProviderCatalogView({ rows, state: 'READY', pageSize: 50 }).orderedIds).not.toContain('q2')
  })

  it('Ready tab never returns unavailable/config/pricing/draft rows', () => {
    const view = buildProviderCatalogView({ rows, state: 'READY', pageSize: 50 })
    expect(view.pageRows).toHaveLength(3)
    for (const c of view.pageRows) {
      expect(c.ready).toBe(true)
      expect(c.state).toBe('READY')
      expect(c.row.isAvailable).not.toBe(false)
      expect(c.row.configurationStatus).toBe('CONFIGURED')
      expect(c.row.pricingStatus).toBe('READY')
      expect(c.row.publishStatus).toBe('PUBLISHED')
    }
  })

  it('pagination across a state filter has no missing or duplicate IDs', () => {
    const many = Array.from({ length: 137 }, (_, i) => readyRow('r' + String(i).padStart(3, '0')))
    const first = buildProviderCatalogView({ rows: many, state: 'READY', page: 1, pageSize: 50 })
    const ids: string[] = []
    for (let p = 1; p <= first.totalPages; p++) {
      ids.push(...buildProviderCatalogView({ rows: many, state: 'READY', page: p, pageSize: 50 }).pageRows.map(c => c.row.id))
    }
    expect(ids).toHaveLength(137)
    expect(new Set(ids).size).toBe(137)
    expect([...ids].sort()).toEqual([...first.orderedIds].sort())
  })

  it('deterministic ordering across calls (createdAt desc, id tiebreaker)', () => {
    const a = sortProviderCatalogRows(classifyProviderCatalogRows(rows)).map(c => c.row.id)
    const b = sortProviderCatalogRows(classifyProviderCatalogRows(rows)).map(c => c.row.id)
    expect(a).toEqual(b)
    // createdAt desc puts the newest (latest slice() digit) first
    expect(a[0]).toBe('r3')
  })

  it('changing tabs yields a fresh first page for the new state (no carry-over), page clamps', () => {
    const readyPage1 = buildProviderCatalogView({ rows, state: 'READY', page: 1, pageSize: 1 })
    const pricingPage1 = buildProviderCatalogView({ rows, state: 'NEEDS_PRICING', page: 1, pageSize: 1 })
    expect(readyPage1.pageRows[0].row.id).toBe('r3')
    expect(pricingPage1.pageRows[0].row.id).toBe('p2')
    // a new tab's page 1 is its own first page regardless of the previous tab's page
    const afterCarry = buildProviderCatalogView({ rows, state: 'NEEDS_PRICING', page: 3, pageSize: 1 })
    // 2 items → page 3 clamps to the last valid page (2), never carrying into another tab
    expect(afterCarry.pageRows).toHaveLength(1)
    expect(afterCarry.pageRows[0].row.id).toBe('p1')
    expect(buildProviderCatalogView({ rows, state: 'NEEDS_PRICING', page: 2, pageSize: 1 }).pageRows[0].row.id).toBe('p1')
    // page clamps to the tab's own bounds (no wrap-around to another tab)
    expect(buildProviderCatalogView({ rows, state: 'READY', page: 99, pageSize: 1 }).pageRows).toHaveLength(1)
  })

  it('emits counts for every canonical state key', () => {
    const view = buildProviderCatalogView({ rows, pageSize: 3 })
    for (const s of VIEW_STATES) expect(view.counts).toHaveProperty(s)
    const countsKeys = Object.keys(view.counts as ProviderCatalogStateCounts)
    for (const s of VIEW_STATES) expect(countsKeys).toContain(s)
  })
})