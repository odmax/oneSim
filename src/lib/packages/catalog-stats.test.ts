import { describe, it, expect } from 'vitest'
import { computeCatalogStats } from './catalog-stats'

function retail(overrides: Record<string, any> = {}): any {
  return {
    id: 'r-1',
    isActive: true,
    hiddenFromCatalog: false,
    archivedAt: null,
    source: 'CATALOG_PRODUCT',
    providerPackageId: 'pp-1',
    priceUSD: { toString: () => '21.49' },
    providerId: 'prov-1',
    providerPackage: {
      publishStatus: 'PUBLISHED',
      costStatus: 'VALID',
      pricingStatus: 'READY',
      configurationStatus: 'CONFIGURED',
      activePriceSnapshotId: 'snap-1',
      sellingPrice: { toString: () => '21.49' },
      costPrice: { toString: () => '5' },
    },
    provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'CHOICE' },
    providerBindings: [],
    ...overrides,
  }
}

const exposed = (map: Record<string, boolean>) => new Map(Object.entries(map))

describe('computeCatalogStats — admin vs customer-visible counts (66/64/2 + customerVisible)', () => {
  function build66View() {
    return [
      // 64 operationally-live products (valid, published, priced)
      ...Array.from({ length: 64 }, (_, i) => retail({ id: `live-${i}`, providerId: 'prov-1' })),
      // 2 needs-pricing: active, not hidden/archived, but not purchase-ready
      retail({ id: 'np-1', providerPackage: { ...retail().providerPackage, sellingPrice: { toString: () => '0' } } }),
      retail({ id: 'np-2', providerPackage: { ...retail().providerPackage, activePriceSnapshotId: null } }),
    ]
  }

  it('reproduces the reported staging profile: 66 total, 64 operational live, 2 needs pricing', () => {
    const stats = computeCatalogStats(build66View(), exposed({ 'prov-1': true }))
    expect(stats.total).toBe(66)
    expect(stats.operationalLive).toBe(64)
    expect(stats.needsPricing).toBe(2)
    expect(stats.draftInactive).toBe(0)
  })

  it('with every provider exposed, customer-visible equals operational live (64)', () => {
    const stats = computeCatalogStats(build66View(), exposed({ 'prov-1': true }))
    expect(stats.customerVisible).toBe(64)
    expect(stats.hiddenLiveReasons).toEqual([])
  })

  it('provider exposure OFF separates customer-visible from operational live with a reason', () => {
    // Staging scenario: provider PURCHASE not exposed to clients → the buy
    // catalog must not offer them, and the dashboard must say why.
    const stats = computeCatalogStats(build66View(), exposed({ 'prov-1': false }))
    expect(stats.operationalLive).toBe(64)
    expect(stats.customerVisible).toBe(0)
    expect(stats.hiddenLiveReasons.some(r => r.reason.includes('not exposed'))).toBe(true)
    expect(stats.hiddenLiveReasons[0].count).toBe(64)
  })

  it('stale-priced products are customer-hidden but operationally live (parity guard)', () => {
    const stale = Array.from({ length: 10 }, (_, i) => retail({
      id: `stale-${i}`,
      priceUSD: { toString: () => '21.00' }, // ≠ selling 21.49
    }))
    const stats = computeCatalogStats(stale, exposed({ 'prov-1': true }))
    expect(stats.operationalLive).toBe(10)
    expect(stats.customerVisible).toBe(0)
    expect(stats.hiddenLiveReasons.some(r => r.reason.startsWith('Stale retail price'))).toBe(true)
  })

  it('draft/inactive/products already excluded from customer surfaces', () => {
    const list = [
      retail({ id: 'inactive', isActive: false }),
      retail({ id: 'hidden', hiddenFromCatalog: true }),
      retail({ id: 'archived', archivedAt: new Date() }),
      retail({ id: 'draft', providerPackage: { ...retail().providerPackage, publishStatus: 'DRAFT' } }),
      retail({ id: 'visible' }),
    ]
    const stats = computeCatalogStats(list, exposed({ 'prov-1': true }))
    expect(stats.total).toBe(5)
    expect(stats.operationalLive).toBe(1) // only 'visible'
    expect(stats.draftInactive).toBe(4)
    expect(stats.customerVisible).toBe(1)
  })

  it('does not count excluded packages as needs-pricing when they are draft/inactive', () => {
    const stats = computeCatalogStats([
      retail({ id: 'inactive', isActive: false, providerPackage: { ...retail().providerPackage, sellingPrice: { toString: () => '0' } } }),
    ], exposed({ 'prov-1': true }))
    expect(stats.draftInactive).toBe(1)
    expect(stats.needsPricing).toBe(0)
  })
})