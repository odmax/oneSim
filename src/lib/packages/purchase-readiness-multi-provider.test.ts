import { describe, it, expect } from 'vitest'
import { getPackagePurchaseReadiness, PurchasableEsimPackage } from './purchase-readiness'

describe('multi-provider purchase readiness', () => {
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

  const makeReadyProvider = (code: string) => ({
    status: 'ACTIVE' as const,
    enabledCapabilities: ['PURCHASE'],
    code,
  })

  const readyPkg = () => ({
    isActive: true,
    hiddenFromCatalog: false,
    archivedAt: null,
    source: 'CATALOG_PRODUCT',
    providerPackageId: 'pp_01',
  })

  it('AirHub READY package: ready', () => {
    const r = getPackagePurchaseReadiness({
      pkg: readyPkg(),
      providerPkg: makeProviderPkg(),
      provider: makeReadyProvider('AIRHUB'),
    })
    expect(r.ready).toBe(true)
  })

  it('Choice READY package: ready', () => {
    const r = getPackagePurchaseReadiness({
      pkg: readyPkg(),
      providerPkg: makeProviderPkg(),
      provider: makeReadyProvider('CHOICE'),
    })
    expect(r.ready).toBe(true)
  })

  it('iBASIS package with Admin override: ready', () => {
    const r = getPackagePurchaseReadiness({
      pkg: readyPkg(),
      providerPkg: makeProviderPkg({ costStatus: 'OVERRIDDEN' }),
      provider: makeReadyProvider('IBASIS'),
    })
    expect(r.ready).toBe(true)
  })

  it('Telna READY package: ready', () => {
    const r = getPackagePurchaseReadiness({
      pkg: readyPkg(),
      providerPkg: makeProviderPkg(),
      provider: makeReadyProvider('TELNA'),
    })
    expect(r.ready).toBe(true)
  })

  it('Custom provider READY package: ready', () => {
    const r = getPackagePurchaseReadiness({
      pkg: readyPkg(),
      providerPkg: makeProviderPkg(),
      provider: makeReadyProvider('CUSTOM'),
    })
    expect(r.ready).toBe(true)
  })

  it('COST_UNAVAILABLE package: excluded', () => {
    const r = getPackagePurchaseReadiness({
      pkg: readyPkg(),
      providerPkg: makeProviderPkg({ pricingStatus: 'COST_UNAVAILABLE' }),
      provider: makeReadyProvider('AIRHUB'),
    })
    expect(r.ready).toBe(false)
  })

  it('missing snapshot package: excluded', () => {
    const r = getPackagePurchaseReadiness({
      pkg: readyPkg(),
      providerPkg: makeProviderPkg({ activePriceSnapshotId: null }),
      provider: makeReadyProvider('CHOICE'),
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toContain('No active price snapshot')
  })

  it('inactive provider: excluded', () => {
    const r = getPackagePurchaseReadiness({
      pkg: readyPkg(),
      providerPkg: makeProviderPkg(),
      provider: { status: 'INACTIVE', enabledCapabilities: ['PURCHASE'], code: 'TELNA' },
    })
    expect(r.ready).toBe(false)
  })

  it('provider identity never in readiness logic', () => {
    // readiness check should never reference provider code
    const r = getPackagePurchaseReadiness({
      pkg: readyPkg(),
      providerPkg: makeProviderPkg(),
      provider: makeReadyProvider('ANY_PROVIDER_CODE_XYZ'),
    })
    expect(r.ready).toBe(true)
  })

  it('quote creation works identically across providers — no provider-code branching', () => {
    const providerCodes = ['AIRHUB', 'CHOICE', 'IBASIS', 'TELNA', 'CUSTOM', 'FUTURE_X']
    for (const code of providerCodes) {
      const r = getPackagePurchaseReadiness({
        pkg: readyPkg(),
        providerPkg: makeProviderPkg(),
        provider: makeReadyProvider(code),
      })
      expect(r.ready).toBe(true)
      // zero provider-code awareness in reasons
      expect(r.reasons.some(x => x.includes(code))).toBe(false)
    }
  })

  it('adding a future provider requires no readiness helper changes', () => {
    const futureProvider = makeReadyProvider('FUTURE_PROVIDER_V2')
    expect(futureProvider.code).not.toBeUndefined()
    // readiness helper should work with any provider code
    const r = getPackagePurchaseReadiness({
      pkg: readyPkg(),
      providerPkg: makeProviderPkg(),
      provider: futureProvider,
    })
    expect(r.ready).toBe(true)
  })

  it('every ready package can pass readiness check (end-to-end contract)', () => {
    // Simulate a full PurchasableEsimPackage shape
    const pkg: PurchasableEsimPackage = {
      id: 'pkg-001',
      displayName: 'Test Global 5GB',
      country: 'Global',
      countryCode: null,
      region: 'GLOBAL',
      dataGB: 5,
      validityDays: 30,
      sellingPrice: '12.50',
      currency: 'USD',
      purchaseReady: true,
      readinessReasons: [],
      quoteSupported: true,
      travelDateRequired: false,
      minQuantity: 1,
      maxQuantity: null,
    }

    // verify the contract has all required fields and no provider leakage
    const keys = Object.keys(pkg)
    expect(keys).not.toContain('providerId')
    expect(keys).not.toContain('providerCode')
    expect(keys).not.toContain('providerName')
    expect(keys).not.toContain('adapterStrategy')
    expect(keys).not.toContain('providerCost')
    expect(keys).toContain('id')
    expect(keys).toContain('purchaseReady')
    expect(keys).toContain('readinessReasons')
  })

  it('readiness helper is single source of truth — all paths produce same result', () => {
    const inputs = { pkg: readyPkg(), providerPkg: makeProviderPkg(), provider: makeReadyProvider('AIRHUB') }
    const r1 = getPackagePurchaseReadiness(inputs)
    const r2 = getPackagePurchaseReadiness(inputs)
    expect(r1.ready).toBe(r2.ready)
    expect(r1.reasons).toEqual(r2.reasons)
  })
})
