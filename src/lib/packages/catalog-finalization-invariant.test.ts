import { describe, it, expect, vi } from 'vitest'
import { getPackagePurchaseReadiness } from './purchase-readiness'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    packagePriceSnapshot: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    packageConfigurationRule: { findFirst: vi.fn() },
    providerPackageFee: { findMany: vi.fn().mockResolvedValue([]) },
    exchangeRate: { findFirst: vi.fn() },
  },
}))

describe('catalog finalization invariant', () => {
  const makeProviderPkg = (overrides: Record<string, any> = {}) => ({
    costStatus: 'VALID',
    pricingStatus: 'READY',
    publishStatus: 'PUBLISHED',
    configurationStatus: 'CONFIGURED',
    activePriceSnapshotId: 'snap_01',
    sellingPrice: '10.00',
    costPrice: '3.00',
    ...overrides,
  })

  const makeReadyProvider = () => ({
    status: 'ACTIVE',
    enabledCapabilities: ['PURCHASE'],
    code: 'AIRHUB',
  })

  it('CONFIGURED + PUBLISHED + active package = readiness true', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: 'CATALOG_PRODUCT', providerPackageId: 'pp_01' },
      providerPkg: makeProviderPkg(),
      provider: makeReadyProvider(),
    })
    expect(r.ready).toBe(true)
  })

  it('CONFIGURED but missing snapshot = readiness false (invariant violation)', () => {
    const r = getPackagePurchaseReadiness({
      providerPkg: makeProviderPkg({ activePriceSnapshotId: null }),
      provider: makeReadyProvider(),
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('No active price snapshot')
  })

  it('CONFIGURED but COST_UNAVAILABLE = readiness false', () => {
    const r = getPackagePurchaseReadiness({
      providerPkg: makeProviderPkg({ pricingStatus: 'COST_UNAVAILABLE' }),
      provider: makeReadyProvider(),
    })
    expect(r.ready).toBe(false)
  })

  it('PUBLISHED but no selling price = readiness false', () => {
    const r = getPackagePurchaseReadiness({
      providerPkg: makeProviderPkg({ sellingPrice: '0' }),
      provider: makeReadyProvider(),
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('No valid selling price')
  })

  it('PUBLISHED but provider inactive = readiness false', () => {
    const r = getPackagePurchaseReadiness({
      providerPkg: makeProviderPkg(),
      provider: { status: 'INACTIVE', enabledCapabilities: ['PURCHASE'], code: 'AIRHUB' },
    })
    expect(r.ready).toBe(false)
  })

  it('CONFIGURED but provider missing PURCHASE = readiness false', () => {
    const r = getPackagePurchaseReadiness({
      providerPkg: makeProviderPkg(),
      provider: { status: 'ACTIVE', enabledCapabilities: ['STATUS'], code: 'AIRHUB' },
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('Provider does not support PURCHASE')
  })

  it('invariant: every CONFIGURED+PUBLISHED combo should be ready', () => {
    const scenarios = [
      { pkg: makeProviderPkg(), provider: makeReadyProvider(), expect: true },
      { pkg: makeProviderPkg({ costStatus: 'MISSING' }), provider: makeReadyProvider(), expect: false },
      { pkg: makeProviderPkg({ pricingStatus: 'COST_UNAVAILABLE' }), provider: makeReadyProvider(), expect: false },
      { pkg: makeProviderPkg({ activePriceSnapshotId: null }), provider: makeReadyProvider(), expect: false },
      { pkg: makeProviderPkg({ sellingPrice: '0' }), provider: makeReadyProvider(), expect: false },
      { pkg: makeProviderPkg({ publishStatus: 'DRAFT' }), provider: makeReadyProvider(), expect: false },
      { pkg: makeProviderPkg({ configurationStatus: 'UNCONFIGURED' }), provider: makeReadyProvider(), expect: false },
    ]
    for (const s of scenarios) {
      const r = getPackagePurchaseReadiness({ providerPkg: s.pkg, provider: s.provider })
      expect(r.ready).toBe(s.expect)
    }
  })

  it('valid configured package becomes ready via readiness helper', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: 'CATALOG_PRODUCT', providerPackageId: 'pp_01' },
      providerPkg: makeProviderPkg(),
      provider: makeReadyProvider(),
    })
    expect(r.ready).toBe(true)
    expect(r.reasons).toHaveLength(0)
  })

  it('AirHub configured+published: ready', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: 'CATALOG_PRODUCT', providerPackageId: 'pp_01' },
      providerPkg: makeProviderPkg(),
      provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'AIRHUB' },
    })
    expect(r.ready).toBe(true)
  })

  it('Choice configured+published: ready', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: 'CATALOG_PRODUCT', providerPackageId: 'pp_01' },
      providerPkg: makeProviderPkg(),
      provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'CHOICE' },
    })
    expect(r.ready).toBe(true)
  })

  it('iBASIS with cost override configured+published: ready', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: 'CATALOG_PRODUCT', providerPackageId: 'pp_01' },
      providerPkg: makeProviderPkg({ costStatus: 'OVERRIDDEN' }),
      provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'IBASIS' },
    })
    expect(r.ready).toBe(true)
  })

  it('Telna configured+published: ready', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: 'CATALOG_PRODUCT', providerPackageId: 'pp_01' },
      providerPkg: makeProviderPkg(),
      provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'TELNA' },
    })
    expect(r.ready).toBe(true)
  })

  it('Custom configured+published: ready', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: 'CATALOG_PRODUCT', providerPackageId: 'pp_01' },
      providerPkg: makeProviderPkg(),
      provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'CUSTOM' },
    })
    expect(r.ready).toBe(true)
  })

  it('future provider configured+published: ready', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: 'CATALOG_PRODUCT', providerPackageId: 'pp_01' },
      providerPkg: makeProviderPkg(),
      provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'FUTURE_V2' },
    })
    expect(r.ready).toBe(true)
  })

  it('cannot be CONFIGURED without active snapshot', () => {
    const r = getPackagePurchaseReadiness({
      providerPkg: makeProviderPkg({ activePriceSnapshotId: null, configurationStatus: 'CONFIGURED' }),
      provider: makeReadyProvider(),
    })
    expect(r.ready).toBe(false)
    // configurationStatus itself not a readiness reason but missing snapshot is
    expect(r.reasons).toContain('No active price snapshot')
  })

  it('cannot be PUBLISHED when readiness=false', () => {
    const r = getPackagePurchaseReadiness({
      providerPkg: makeProviderPkg({ publishStatus: 'PUBLISHED', activePriceSnapshotId: null }),
      provider: makeReadyProvider(),
    })
    expect(r.ready).toBe(false)
  })

  it('every CONFIGURED+PUBLISHED package appears on Buy eSIM (readiness === true)', () => {
    // Simulate all provider types
    const providers = [
      { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'AIRHUB' },
      { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'CHOICE' },
      { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'IBASIS' },
      { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'TELNA' },
      { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'CUSTOM' },
      { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'ANY_FUTURE' },
    ]
    for (const prov of providers) {
      const r = getPackagePurchaseReadiness({
        pkg: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: 'CATALOG_PRODUCT', providerPackageId: 'pp_01' },
        providerPkg: makeProviderPkg(),
        provider: prov,
      })
      expect(r.ready).toBe(true)
    }
  })

  it('readiness helper is single source of truth — same config = same result', () => {
    const input = {
      pkg: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: 'CATALOG_PRODUCT', providerPackageId: 'pp_01' },
      providerPkg: makeProviderPkg(),
      provider: makeReadyProvider(),
    }
    const r1 = getPackagePurchaseReadiness(input)
    const r2 = getPackagePurchaseReadiness(input)
    expect(r1.ready).toBe(r2.ready)
    expect(r1.reasons).toEqual(r2.reasons)
  })
})
