import { describe, it, expect } from 'vitest'
import { getPackagePurchaseReadiness } from './purchase-readiness'

const makeProviderPkg = (overrides: Record<string, any> = {}) => ({
  costStatus: 'VALID',
  pricingStatus: 'READY',
  publishStatus: 'PUBLISHED',
  configurationStatus: 'CONFIGURED',
  activePriceSnapshotId: 'snap_01',
  sellingPrice: '5.00',
  costPrice: '1.00',
  ...overrides,
})

const makeProvider = (overrides: Record<string, any> = {}) => ({
  status: 'ACTIVE',
  enabledCapabilities: ['PURCHASE'],
  code: 'TEST',
  ...overrides,
})

describe('getPackagePurchaseReadiness', () => {
  it('ready package returns ready=true with no reasons', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: 'CATALOG_PRODUCT', providerPackageId: 'pp_01' },
      providerPkg: makeProviderPkg(),
      provider: makeProvider(),
    })
    expect(r.ready).toBe(true)
    expect(r.reasons).toHaveLength(0)
  })

  it('blocks inactive package', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: false },
      providerPkg: makeProviderPkg(),
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('Package is inactive')
  })

  it('blocks hidden from catalog', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { hiddenFromCatalog: true },
      providerPkg: makeProviderPkg(),
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('Package is hidden from catalog')
  })

  it('blocks archived package', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { archivedAt: new Date() },
      providerPkg: makeProviderPkg(),
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('Package is archived')
  })

  it('blocks PROVIDER_PLAN source', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { source: 'PROVIDER_PLAN' },
      providerPkg: makeProviderPkg(),
    })
    expect(r.ready).toBe(false)
    expect(r.reasons.some(x => x.includes('PROVIDER_PLAN'))).toBe(true)
  })

  it('blocks missing provider package link', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { providerPackageId: null },
      providerPkg: makeProviderPkg(),
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('No provider package linked')
  })

  it('blocks null provider package', () => {
    const r = getPackagePurchaseReadiness({
      providerPkg: null,
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('Provider package not found')
  })

  it('blocks COST_UNAVAILABLE cost status', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg({ costStatus: 'MISSING' }) })
    expect(r.ready).toBe(false)
    expect(r.reasons.some(x => x.includes('Cost status'))).toBe(true)
  })

  it('blocks non-READY pricing status', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg({ pricingStatus: 'COST_UNAVAILABLE' }) })
    expect(r.ready).toBe(false)
    expect(r.reasons.some(x => x.includes('Pricing status'))).toBe(true)
  })

  it('blocks unpublished package', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg({ publishStatus: 'DRAFT' }) })
    expect(r.ready).toBe(false)
    expect(r.reasons.some(x => x.includes('not published'))).toBe(true)
  })

  it('blocks unconfigured package', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg({ configurationStatus: 'UNCONFIGURED' }) })
    expect(r.ready).toBe(false)
    expect(r.reasons.some(x => x.includes('Configuration incomplete'))).toBe(true)
  })

  it('blocks zero selling price', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg({ sellingPrice: '0' }) })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('No valid selling price')
  })

  it('blocks missing active snapshot', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg({ activePriceSnapshotId: null }) })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('No active price snapshot')
  })

  it('blocks inactive provider', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg(), provider: makeProvider({ status: 'INACTIVE' }) })
    expect(r.ready).toBe(false)
    expect(r.reasons.some(x => x.includes('Provider is'))).toBe(true)
  })

  it('blocks provider missing PURCHASE capability', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg(), provider: makeProvider({ enabledCapabilities: ['STATUS'] }) })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('Provider does not support PURCHASE')
  })

  it('allows AUTO_CONFIGURED as configured', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg({ configurationStatus: 'AUTO_CONFIGURED' }) })
    expect(r.ready).toBe(true)
  })

  it('allows DEGRADED provider', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg(), provider: makeProvider({ status: 'DEGRADED' }) })
    expect(r.ready).toBe(true)
  })

  it('works without retail pkg info (provider package only mode)', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg(), provider: makeProvider() })
    expect(r.ready).toBe(true)
  })

  it('works without provider info (skip provider checks)', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg() })
    expect(r.ready).toBe(true)
  })

  it('multiple reasons accumulated', () => {
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: false, hiddenFromCatalog: true },
      providerPkg: makeProviderPkg({ costStatus: 'MISSING', pricingStatus: 'COST_UNAVAILABLE' }),
    })
    expect(r.ready).toBe(false)
    expect(r.reasons.length).toBeGreaterThanOrEqual(4)
  })
})
