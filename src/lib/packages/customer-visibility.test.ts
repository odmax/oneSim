import { describe, it, expect } from 'vitest'
import { evaluateCustomerVisibility, isStalePriced, PARITY_TOLERANCE } from './customer-visibility'

const retail = {
  isActive: true,
  hiddenFromCatalog: false,
  archivedAt: null,
  source: 'CATALOG_PRODUCT',
  providerPackageId: 'pp-1',
  priceUSD: { toString: () => '21.49' },
}

const providerPkg = {
  costStatus: 'VALID',
  pricingStatus: 'READY',
  publishStatus: 'PUBLISHED',
  configurationStatus: 'CONFIGURED',
  activePriceSnapshotId: 'snap-1',
  sellingPrice: { toString: () => '21.49' },
  costPrice: { toString: () => '5.00' },
  isAvailable: true,
}

const provider = { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'CHOICE' }

describe('evaluateCustomerVisibility — canonical customer-visibility policy', () => {
  it('a fully eligible live product is customer-visible', () => {
    const r = evaluateCustomerVisibility({ pkg: retail, providerPkg, provider, portalExposed: true })
    expect(r.visible).toBe(true)
    expect(r.reasons).toEqual([])
  })

  it('draft/inactive/unpublished product is excluded with reasons', () => {
    const r = evaluateCustomerVisibility({
      pkg: retail,
      providerPkg: { ...providerPkg, publishStatus: 'DRAFT' },
      provider,
      portalExposed: true,
    })
    expect(r.visible).toBe(false)
    expect(r.reasons).toContain('Package not published (DRAFT)')
  })

  it('inactive retail package is excluded', () => {
    const r = evaluateCustomerVisibility({ pkg: { ...retail, isActive: false }, providerPkg, provider, portalExposed: true })
    expect(r.visible).toBe(false)
    expect(r.reasons[0]).toContain('inactive')
  })

  it('hidden / archived retail is excluded', () => {
    expect(evaluateCustomerVisibility({ pkg: { ...retail, hiddenFromCatalog: true }, providerPkg, provider, portalExposed: true }).visible).toBe(false)
    expect(evaluateCustomerVisibility({ pkg: { ...retail, archivedAt: new Date() }, providerPkg, provider, portalExposed: true }).visible).toBe(false)
  })

  it('unpriced (no valid selling price) is excluded', () => {
    const r = evaluateCustomerVisibility({
      pkg: retail,
      providerPkg: { ...providerPkg, sellingPrice: { toString: () => '0' } },
      provider,
      portalExposed: true,
    })
    expect(r.visible).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/selling price/i)
  })

  it('blocked provider status excludes', () => {
    const r = evaluateCustomerVisibility({ pkg: retail, providerPkg, provider: { ...provider, status: 'INACTIVE' }, portalExposed: true })
    expect(r.visible).toBe(false)
  })

  it('provider without PURCHASE capability excludes', () => {
    const r = evaluateCustomerVisibility({ pkg: retail, providerPkg, provider: { ...provider, enabledCapabilities: ['STATUS'] }, portalExposed: true })
    expect(r.visible).toBe(false)
  })

  it('exposure OFF excludes (provider privacy)', () => {
    const r = evaluateCustomerVisibility({ pkg: retail, providerPkg, provider, portalExposed: false })
    expect(r.visible).toBe(false)
    expect(r.exposureBlocked).toBe(true)
  })

  it('stale retail price (price parity) excludes with an explicit reason', () => {
    const r = evaluateCustomerVisibility({
      pkg: { ...retail, priceUSD: { toString: () => '21.00' } },
      providerPkg,
      provider,
      portalExposed: true,
    })
    expect(r.visible).toBe(false)
    expect(r.parityStale).toBe(true)
    expect(r.reasons.some(x => x.startsWith('Stale retail price'))).toBe(true)
  })

  it('sub-cent drift within PARITY_TOLERANCE does NOT exclude', () => {
    const r = evaluateCustomerVisibility({
      pkg: { ...retail, priceUSD: { toString: () => '21.494' } },
      providerPkg,
      provider,
      portalExposed: true,
    })
    expect(r.parityStale).toBe(false)
    expect(r.visible).toBe(true)
  })

  it('unlinked / manual / custom packages are NOT parity-checked', () => {
    const r = evaluateCustomerVisibility({
      pkg: { ...retail, providerPackageId: null, source: 'MANUAL' },
      providerPkg: null,
      provider: null,
      portalExposed: true,
    })
    expect(r.parityStale).toBe(false)
  })

  it('custom package with backing count is evaluated via the custom path', () => {
    const r = evaluateCustomerVisibility({
      pkg: { ...retail, providerPackageId: null, source: 'MANUAL', priceUSD: { toString: () => '30' } },
      providerPkg: null,
      provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'CUSTOM' },
      portalExposed: true,
      customBackingCount: 1,
    })
    expect(r.visible).toBe(true)
  })

  it('custom package with zero backing is excluded', () => {
    const r = evaluateCustomerVisibility({
      pkg: { ...retail, providerPackageId: null, source: 'MANUAL', priceUSD: { toString: () => '30' } },
      providerPkg: null,
      provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'CUSTOM' },
      portalExposed: true,
      customBackingCount: 0,
    })
    expect(r.visible).toBe(false)
  })

  it('isStalePriced respects the tolerance', () => {
    expect(isStalePriced(retail, providerPkg)).toBe(false)
    expect(isStalePriced({ ...retail, priceUSD: { toString: () => '20' } }, providerPkg)).toBe(true)
    expect(isStalePriced({ ...retail, priceUSD: { toString: () => '21.49' } }, { ...providerPkg, sellingPrice: { toString: () => '21.49' } })).toBe(false)
  })

  it('PARITY_TOLERANCE is 0.5 cents (0.005)', () => {
    expect(PARITY_TOLERANCE).toBe(0.005)
  })
})

describe('isStalePriced stays comma-safe through parseDecimalSafe', () => {
  it('a comma-decimal retail price is not mis-parsed to 21', () => {
    // parseDecimalSafe('21,49') → 21.49; selling = 21.49 → not stale.
    expect(isStalePriced({ ...retail, priceUSD: { toString: () => '21,49' } }, providerPkg)).toBe(false)
  })
})