import { describe, it, expect } from 'vitest'
import {
  isProviderPackageCompatible,
  coverageIncludes,
  computeBackingPricing,
  isBackingPurchaseReady,
  resolveBackingProviders,
  type BackingProviderPackageLike,
} from './custom-package'

function backing(overrides: Partial<BackingProviderPackageLike> = {}): BackingProviderPackageLike {
  return {
    id: 'pp-1',
    providerId: 'p-1',
    dataGB: 10,
    validityDays: 30,
    country: 'ZAF',
    region: null,
    provider: { id: 'p-1', status: 'ACTIVE' },
    configurationStatus: 'CONFIGURED',
    publishStatus: 'PUBLISHED',
    sellingPrice: 5,
    costPrice: 2,
    ...overrides,
  }
}

describe('isProviderPackageCompatible', () => {
  it('AT_LEAST: backing with >= allowance and validity is compatible', () => {
    expect(isProviderPackageCompatible({ dataGB: 10, validityDays: 30, backingDataGB: 12, backingValidityDays: 60 }, 'AT_LEAST')).toBe(true)
    expect(isProviderPackageCompatible({ dataGB: 10, validityDays: 30, backingDataGB: 10, backingValidityDays: 30 }, 'AT_LEAST')).toBe(true)
  })

  it('AT_LEAST: insufficient allowance or validity is incompatible', () => {
    expect(isProviderPackageCompatible({ dataGB: 10, validityDays: 30, backingDataGB: 5, backingValidityDays: 30 }, 'AT_LEAST')).toBe(false)
    expect(isProviderPackageCompatible({ dataGB: 10, validityDays: 30, backingDataGB: 10, backingValidityDays: 10 }, 'AT_LEAST')).toBe(false)
  })

  it('EXACT requires exact equality', () => {
    expect(isProviderPackageCompatible({ dataGB: 10, validityDays: 30, backingDataGB: 12, backingValidityDays: 60 }, 'EXACT')).toBe(false)
    expect(isProviderPackageCompatible({ dataGB: 10, validityDays: 30, backingDataGB: 10, backingValidityDays: 30 }, 'EXACT')).toBe(true)
  })

  it('coverage: requested countries must be covered by the backing country', () => {
    expect(coverageIncludes(['ZAF', 'NGA'], 'ZAF')).toBe(true)
    expect(coverageIncludes(['ZAF'], 'GHA')).toBe(false)
    // A bare region is not proof of country coverage (no provider-neutral mapping).
    expect(coverageIncludes(['ZAF'], null, 'AFRICA')).toBe(false)
    expect(coverageIncludes([], 'GHA')).toBe(true) // country-agnostic
  })
})

describe('computeBackingPricing', () => {
  it('profit = selling - cost; marginPercent reuses canonical helper', () => {
    const p = computeBackingPricing({ providerCost: 4, sellingPrice: 10 })
    expect(p.profit).toBe(6)
    expect(p.margin).toBe(6)
    expect(p.marginPercent).not.toBeNull()
  })
})

describe('isBackingPurchaseReady', () => {
  it('requires operational provider + configured/published + valid pricing', () => {
    expect(isBackingPurchaseReady(backing())).toBe(true)
    expect(isBackingPurchaseReady(backing({ provider: { id: 'p-1', status: 'INACTIVE' } }))).toBe(false)
    expect(isBackingPurchaseReady(backing({ configurationStatus: 'UNCONFIGURED' }))).toBe(false)
    expect(isBackingPurchaseReady(backing({ publishStatus: 'HIDDEN' }))).toBe(false)
    expect(isBackingPurchaseReady(backing({ sellingPrice: 0, costPrice: 2 }))).toBe(false)
    expect(isBackingPurchaseReady(backing({ sellingPrice: 5, costPrice: 0 }))).toBe(false)
  })
})

describe('resolveBackingProviders', () => {
  it('marks incompatible and non-purchase-ready backings', () => {
    const res = resolveBackingProviders({
      dataGB: 10, validityDays: 30, countries: ['ZAF'], policy: 'AT_LEAST',
      candidates: [
        backing({ id: 'pp-good', dataGB: 12, validityDays: 60, country: 'ZAF' }),
        backing({ id: 'pp-small', dataGB: 5, validityDays: 30, country: 'ZAF' }),
        backing({ id: 'pp-unconfigured', dataGB: 12, validityDays: 60, country: 'ZAF', configurationStatus: 'UNCONFIGURED' }),
        backing({ id: 'pp-wrong-country', dataGB: 12, validityDays: 60, country: 'GHA' }),
      ],
    })
    const good = res.find(r => r.providerPackageId === 'pp-good')!
    expect(good.compatible).toBe(true)
    expect(good.purchaseReady).toBe(true)
    expect(res.find(r => r.providerPackageId === 'pp-small')!.purchaseReady).toBe(false)
    expect(res.find(r => r.providerPackageId === 'pp-unconfigured')!.purchaseReady).toBe(false)
    expect(res.find(r => r.providerPackageId === 'pp-wrong-country')!.purchaseReady).toBe(false)
  })
})
