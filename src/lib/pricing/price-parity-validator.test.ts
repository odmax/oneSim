import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindUniqueProviderPackage, mockFindFirstRetail, mockFindUniqueSnapshot } = vi.hoisted(() => ({
  mockFindUniqueProviderPackage: vi.fn(),
  mockFindFirstRetail: vi.fn(),
  mockFindUniqueSnapshot: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: { findUnique: mockFindUniqueProviderPackage },
    eSIMPackage: { findFirst: mockFindFirstRetail },
    packagePriceSnapshot: { findUnique: mockFindUniqueSnapshot },
  },
}))

import { validatePriceParity, validatePriceParityFromDatabase } from './price-parity-validator'

describe('validatePriceParity — pure input validation', () => {
  it('consistent: all prices match', () => {
    const result = validatePriceParity({
      providerPackageId: 'pp-1',
      providerPackageSellingPrice: 17,
      providerPackageSellingCurrency: 'USD',
      providerPackageMarkupPercent: 142.86,
      providerPackageCostPrice: 7,
      providerPackageActivePriceSnapshotId: 'snap-1',
      retailPackageId: 'retail-1',
      retailPackagePriceUSD: 17,
      retailPackageLocalPrice: 17,
      retailPackageCurrency: 'USD',
      snapshotFinalSellingPrice: 17,
    })

    expect(result.consistent).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it('violation: retail priceUSD differs from provider sellingPrice', () => {
    const result = validatePriceParity({
      providerPackageId: 'pp-1',
      providerPackageSellingPrice: 17,
      providerPackageSellingCurrency: 'USD',
      providerPackageMarkupPercent: 142.86,
      providerPackageCostPrice: 7,
      providerPackageActivePriceSnapshotId: 'snap-1',
      retailPackageId: 'retail-1',
      retailPackagePriceUSD: 5,
      retailPackageLocalPrice: 5,
      retailPackageCurrency: 'USD',
      snapshotFinalSellingPrice: 17,
    })

    expect(result.consistent).toBe(false)
    const priceViolation = result.violations.find(v => v.field === 'priceUSD')
    expect(priceViolation).toBeDefined()
    expect(priceViolation!.providerValue).toBe(17)
    expect(priceViolation!.retailValue).toBe(5)
  })

  it('violation: retail localPrice differs from provider sellingPrice', () => {
    const result = validatePriceParity({
      providerPackageId: 'pp-1',
      providerPackageSellingPrice: 17,
      providerPackageSellingCurrency: 'USD',
      providerPackageMarkupPercent: 142.86,
      providerPackageCostPrice: 7,
      providerPackageActivePriceSnapshotId: 'snap-1',
      retailPackageId: 'retail-1',
      retailPackagePriceUSD: 17,
      retailPackageLocalPrice: 5,
      retailPackageCurrency: 'USD',
      snapshotFinalSellingPrice: 17,
    })

    expect(result.consistent).toBe(false)
    expect(result.violations.some(v => v.field === 'localPrice')).toBe(true)
  })

  it('violation: provider sellingPrice differs from snapshot finalSellingPrice', () => {
    const result = validatePriceParity({
      providerPackageId: 'pp-1',
      providerPackageSellingPrice: 17,
      providerPackageSellingCurrency: 'USD',
      providerPackageMarkupPercent: 142.86,
      providerPackageCostPrice: 7,
      providerPackageActivePriceSnapshotId: 'snap-1',
      retailPackageId: 'retail-1',
      retailPackagePriceUSD: 17,
      retailPackageLocalPrice: 17,
      retailPackageCurrency: 'USD',
      snapshotFinalSellingPrice: 5,
    })

    expect(result.consistent).toBe(false)
    expect(result.violations.some(v => v.field === 'sellingPrice_vs_snapshot')).toBe(true)
  })

  it('multiple violations: all three fields differ', () => {
    const result = validatePriceParity({
      providerPackageId: 'pp-1',
      providerPackageSellingPrice: 17,
      providerPackageSellingCurrency: 'USD',
      providerPackageMarkupPercent: 142.86,
      providerPackageCostPrice: 7,
      providerPackageActivePriceSnapshotId: 'snap-1',
      retailPackageId: 'retail-1',
      retailPackagePriceUSD: 5,
      retailPackageLocalPrice: 3,
      retailPackageCurrency: 'USD',
      snapshotFinalSellingPrice: 22,
    })

    expect(result.consistent).toBe(false)
    expect(result.violations.length).toBeGreaterThanOrEqual(3)
  })

  it('consistent when snapshot is null (no snapshot check)', () => {
    const result = validatePriceParity({
      providerPackageId: 'pp-1',
      providerPackageSellingPrice: 17,
      providerPackageSellingCurrency: 'USD',
      providerPackageMarkupPercent: 142.86,
      providerPackageCostPrice: 7,
      providerPackageActivePriceSnapshotId: null,
      retailPackageId: 'retail-1',
      retailPackagePriceUSD: 17,
      retailPackageLocalPrice: 17,
      retailPackageCurrency: 'USD',
      snapshotFinalSellingPrice: null,
    })

    expect(result.consistent).toBe(true)
  })

  it('consistent with sub-cent tolerance (0.004 difference)', () => {
    const result = validatePriceParity({
      providerPackageId: 'pp-1',
      providerPackageSellingPrice: 17.002,
      providerPackageSellingCurrency: 'USD',
      providerPackageMarkupPercent: null,
      providerPackageCostPrice: 7,
      providerPackageActivePriceSnapshotId: 'snap-1',
      retailPackageId: 'retail-1',
      retailPackagePriceUSD: 17.005,
      retailPackageLocalPrice: 17.005,
      retailPackageCurrency: 'USD',
      snapshotFinalSellingPrice: 17.003,
    })

    expect(result.consistent).toBe(true)
  })
})

describe('validatePriceParityFromDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('consistent: prices match across PP, retail, and snapshot', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue({
      id: 'pp-1',
      sellingPrice: { toString: () => '17.00' },
      sellingCurrency: 'USD',
      markupPercent: { toString: () => '142.86' },
      costPrice: { toString: () => '7.00' },
      activePriceSnapshotId: 'snap-1',
    })
    mockFindFirstRetail.mockResolvedValue({
      id: 'retail-1',
      priceUSD: { toString: () => '17.00' },
      localPrice: { toString: () => '17.00' },
      currency: 'USD',
    })
    mockFindUniqueSnapshot.mockResolvedValue({
      finalSellingPrice: { toString: () => '17.00' },
      status: 'ACTIVE',
    })

    const result = await validatePriceParityFromDatabase('pp-1')

    expect(result.consistent).toBe(true)
    expect(result.violations).toHaveLength(0)
    expect(result.snapshotFinalSellingPrice).toBe(17)
    expect(result.snapshotStatus).toBe('ACTIVE')
  })

  it('violation: retail priceUSD=5 does not match PP sellingPrice=17', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue({
      id: 'pp-1',
      sellingPrice: { toString: () => '17.00' },
      sellingCurrency: 'USD',
      markupPercent: { toString: () => '142.86' },
      costPrice: { toString: () => '7.00' },
      activePriceSnapshotId: 'snap-1',
    })
    mockFindFirstRetail.mockResolvedValue({
      id: 'retail-1',
      priceUSD: { toString: () => '5.00' },
      localPrice: { toString: () => '5.00' },
      currency: 'USD',
    })
    mockFindUniqueSnapshot.mockResolvedValue({
      finalSellingPrice: { toString: () => '17.00' },
      status: 'ACTIVE',
    })

    const result = await validatePriceParityFromDatabase('pp-1')

    expect(result.consistent).toBe(false)
    expect(result.violations.length).toBeGreaterThanOrEqual(1)
    const priceViolation = result.violations.find(v => v.field === 'priceUSD')
    expect(priceViolation).toBeDefined()
    expect(priceViolation!.providerValue).toBe(17)
    expect(priceViolation!.retailValue).toBe(5)
  })

  it('ProviderPackage not found → consistent=false with error', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue(null)

    const result = await validatePriceParityFromDatabase('pp-missing')

    expect(result.consistent).toBe(false)
    expect(result.violations[0].message).toContain('not found')
  })

  it('no linked retail package → consistent but retailPackageId is null', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue({
      id: 'pp-1',
      sellingPrice: { toString: () => '17.00' },
      sellingCurrency: 'USD',
      markupPercent: { toString: () => '142.86' },
      costPrice: { toString: () => '7.00' },
      activePriceSnapshotId: 'snap-1',
    })
    mockFindFirstRetail.mockResolvedValue(null)
    mockFindUniqueSnapshot.mockResolvedValue({
      finalSellingPrice: { toString: () => '17.00' },
      status: 'ACTIVE',
    })

    const result = await validatePriceParityFromDatabase('pp-1')

    expect(result.consistent).toBe(true)
    expect(result.retailPackageId).toBeNull()
  })

  it('no active snapshot → snapshot check skipped', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue({
      id: 'pp-1',
      sellingPrice: { toString: () => '17.00' },
      sellingCurrency: 'USD',
      markupPercent: { toString: () => '142.86' },
      costPrice: { toString: () => '7.00' },
      activePriceSnapshotId: null,
    })
    mockFindFirstRetail.mockResolvedValue({
      id: 'retail-1',
      priceUSD: { toString: () => '17.00' },
      localPrice: { toString: () => '17.00' },
      currency: 'USD',
    })

    const result = await validatePriceParityFromDatabase('pp-1')

    expect(result.consistent).toBe(true)
    expect(result.snapshotFinalSellingPrice).toBeNull()
    expect(result.snapshotStatus).toBeNull()
  })
})
