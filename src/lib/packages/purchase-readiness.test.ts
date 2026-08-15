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

describe('getPackagePurchaseReadiness — mode semantics (PURCHASE default vs PRE_PUBLISH)', () => {
  const base = (overrides: Record<string, any> = {}) => makeProviderPkg({ publishStatus: 'READY', ...overrides })

  it('default mode is PURCHASE (strict): READY package is NOT purchasable', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: base(), provider: makeProvider() })
    expect(r.ready).toBe(false)
    expect(r.reasons.some(x => x.includes('not published'))).toBe(true)
  })

  it('explicit PURCHASE mode requires PUBLISHED', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: base(), provider: makeProvider(), mode: 'PURCHASE' })
    expect(r.ready).toBe(false)
    expect(r.reasons.some(x => x.includes('not published'))).toBe(true)
  })

  it('PRE_PUBLISH mode accepts READY (source state allowed to transition)', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: base(), provider: makeProvider(), mode: 'PRE_PUBLISH' })
    expect(r.ready).toBe(true)
    expect(r.reasons).toHaveLength(0)
  })

  it('PRE_PUBLISH mode accepts CONFIGURED + DRAFT (eligibility contract)', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: base({ publishStatus: 'DRAFT', configurationStatus: 'CONFIGURED' }), provider: makeProvider(), mode: 'PRE_PUBLISH' })
    expect(r.ready).toBe(true)
  })

  it('PRE_PUBLISH mode accepts AUTO_CONFIGURED + DRAFT (eligibility contract)', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: base({ publishStatus: 'DRAFT', configurationStatus: 'AUTO_CONFIGURED' }), provider: makeProvider(), mode: 'PRE_PUBLISH' })
    expect(r.ready).toBe(true)
  })

  it('PRE_PUBLISH mode accepts UNCONFIGURED + READY (eligibility contract allows READY source)', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: base({ configurationStatus: 'UNCONFIGURED' }), provider: makeProvider(), mode: 'PRE_PUBLISH' })
    expect(r.ready).toBe(true)
  })

  it('PRE_PUBLISH mode blocks UNCONFIGURED + DRAFT', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: base({ publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED' }), provider: makeProvider(), mode: 'PRE_PUBLISH' })
    expect(r.ready).toBe(false)
    expect(r.reasons.some(x => x.includes('not eligible for publication'))).toBe(true)
  })

  it('PRE_PUBLISH mode blocks HIDDEN regardless of configuration', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: base({ publishStatus: 'HIDDEN', configurationStatus: 'CONFIGURED' }), provider: makeProvider(), mode: 'PRE_PUBLISH' })
    expect(r.ready).toBe(false)
  })

  it('PRE_PUBLISH mode blocks ARCHIVED regardless of configuration', () => {
    const r = getPackagePurchaseReadiness({ providerPkg: base({ publishStatus: 'ARCHIVED', configurationStatus: 'CONFIGURED' }), provider: makeProvider(), mode: 'PRE_PUBLISH' })
    expect(r.ready).toBe(false)
  })

  it('PRE_PUBLISH mode still enforces cost/pricing/snapshot/selling/provider requirements', () => {
    // Missing cost → not ready even in PRE_PUBLISH.
    expect(getPackagePurchaseReadiness({ providerPkg: base({ costStatus: 'MISSING' }), mode: 'PRE_PUBLISH' }).ready).toBe(false)
    // Pricing not ready → blocked.
    expect(getPackagePurchaseReadiness({ providerPkg: base({ pricingStatus: 'COST_UNAVAILABLE' }), mode: 'PRE_PUBLISH' }).ready).toBe(false)
    // No snapshot → blocked.
    expect(getPackagePurchaseReadiness({ providerPkg: base({ activePriceSnapshotId: null }), mode: 'PRE_PUBLISH' }).ready).toBe(false)
    // No selling price → blocked.
    expect(getPackagePurchaseReadiness({ providerPkg: base({ sellingPrice: '0' }), mode: 'PRE_PUBLISH' }).ready).toBe(false)
    // Inactive provider → blocked.
    expect(getPackagePurchaseReadiness({ providerPkg: base(), provider: makeProvider({ status: 'INACTIVE' }), mode: 'PRE_PUBLISH' }).ready).toBe(false)
    // Missing PURCHASE capability → blocked.
    expect(getPackagePurchaseReadiness({ providerPkg: base(), provider: makeProvider({ enabledCapabilities: ['STATUS'] }), mode: 'PRE_PUBLISH' }).ready).toBe(false)
  })

  it('PRE_PUBLISH mode is provider-neutral (USMATRIX/CHOICE/AIRHUB/IBASIS identical)', () => {
    for (const code of ['USMATRIX', 'CHOICE', 'AIRHUB', 'IBASIS']) {
      const ready = getPackagePurchaseReadiness({ providerPkg: base(), provider: makeProvider({ code }), mode: 'PRE_PUBLISH' })
      expect(ready.ready).toBe(true)
      expect(ready.reasons).toHaveLength(0)
    }
  })

  it('PURCHASE mode stays provider-neutral and strict', () => {
    for (const code of ['USMATRIX', 'CHOICE', 'AIRHUB', 'IBASIS']) {
      const blocked = getPackagePurchaseReadiness({ providerPkg: base(), provider: makeProvider({ code }), mode: 'PURCHASE' })
      expect(blocked.ready).toBe(false)
      expect(blocked.reasons.some(x => x.includes('not published'))).toBe(true)
      const ok = getPackagePurchaseReadiness({ providerPkg: makeProviderPkg(), provider: makeProvider({ code }), mode: 'PURCHASE' })
      expect(ok.ready).toBe(true)
    }
  })

  it('client-facing callers stay strict: PURCHASE rejects READY even when otherwise valid', () => {
    // Simulates queryPurchasablePackages / purchase / quote flows which pass no mode.
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: 'CATALOG_PRODUCT', providerPackageId: 'pp_01' },
      providerPkg: base(),
      provider: makeProvider(),
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('Package not published (READY)')
  })
})
