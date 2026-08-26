import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindUniqueProviderPackage, mockFindUniqueSnapshot } = vi.hoisted(() => ({
  mockFindUniqueProviderPackage: vi.fn(),
  mockFindUniqueSnapshot: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: { findUnique: mockFindUniqueProviderPackage },
    packagePriceSnapshot: { findUnique: mockFindUniqueSnapshot },
  },
}))

import { enforcePurchasePriceGuard } from './purchase-price-guard'

describe('enforcePurchasePriceGuard — fail-closed price parity for BOUND packages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('PASS: retail priceUSD matches provider sellingPrice and snapshot', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue({
      id: 'pp-1',
      sellingPrice: { toString: () => '17.00' },
      sellingCurrency: 'USD',
      activePriceSnapshotId: 'snap-1',
    })
    mockFindUniqueSnapshot.mockResolvedValue({
      finalSellingPrice: { toString: () => '17.00' },
      status: 'ACTIVE',
    })

    const result = await enforcePurchasePriceGuard({
      providerPackageId: 'pp-1',
      retailPriceUSD: 17,
      retailLocalPrice: 17,
    })

    expect(result.passed).toBe(true)
  })

  it('FAIL: retail priceUSD=5 does not match provider sellingPrice=17', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue({
      id: 'pp-1',
      sellingPrice: { toString: () => '17.00' },
      sellingCurrency: 'USD',
      activePriceSnapshotId: 'snap-1',
    })
    mockFindUniqueSnapshot.mockResolvedValue({
      finalSellingPrice: { toString: () => '17.00' },
      status: 'ACTIVE',
    })

    const result = await enforcePurchasePriceGuard({
      providerPackageId: 'pp-1',
      retailPriceUSD: 5,
      retailLocalPrice: 5,
    })

    expect(result.passed).toBe(false)
    expect(result.reason).toContain('priceUSD')
    expect(result.reason).toContain('$5')
    expect(result.reason).toContain('$17')
    expect(result.providerSellingPrice).toBe(17)
    expect(result.retailPriceUSD).toBe(5)
    expect(result.snapshotFinalSellingPrice).toBe(17)
  })

  it('FAIL: retail localPrice differs from provider sellingPrice', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue({
      id: 'pp-1',
      sellingPrice: { toString: () => '17.00' },
      sellingCurrency: 'USD',
      activePriceSnapshotId: 'snap-1',
    })
    mockFindUniqueSnapshot.mockResolvedValue({
      finalSellingPrice: { toString: () => '17.00' },
      status: 'ACTIVE',
    })

    const result = await enforcePurchasePriceGuard({
      providerPackageId: 'pp-1',
      retailPriceUSD: 17,
      retailLocalPrice: 5,
    })

    expect(result.passed).toBe(false)
    expect(result.reason).toContain('localPrice')
  })

  it('FAIL: provider sellingPrice differs from snapshot', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue({
      id: 'pp-1',
      sellingPrice: { toString: () => '17.00' },
      sellingCurrency: 'USD',
      activePriceSnapshotId: 'snap-1',
    })
    mockFindUniqueSnapshot.mockResolvedValue({
      finalSellingPrice: { toString: () => '5.00' },
      status: 'ACTIVE',
    })

    const result = await enforcePurchasePriceGuard({
      providerPackageId: 'pp-1',
      retailPriceUSD: 17,
      retailLocalPrice: 17,
    })

    expect(result.passed).toBe(false)
    expect(result.reason).toContain('snapshot')
  })

  it('FAIL: ProviderPackage not found', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue(null)

    const result = await enforcePurchasePriceGuard({
      providerPackageId: 'pp-missing',
      retailPriceUSD: 17,
      retailLocalPrice: 17,
    })

    expect(result.passed).toBe(false)
    expect(result.reason).toContain('not found')
  })

  it('PASS: no snapshot — snapshot check skipped', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue({
      id: 'pp-1',
      sellingPrice: { toString: () => '17.00' },
      sellingCurrency: 'USD',
      activePriceSnapshotId: null,
    })

    const result = await enforcePurchasePriceGuard({
      providerPackageId: 'pp-1',
      retailPriceUSD: 17,
      retailLocalPrice: 17,
    })

    expect(result.passed).toBe(true)
    expect(result.snapshotFinalSellingPrice).toBeNull()
  })

  it('PASS: sub-cent tolerance (0.004 difference)', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue({
      id: 'pp-1',
      sellingPrice: { toString: () => '17.002' },
      sellingCurrency: 'USD',
      activePriceSnapshotId: 'snap-1',
    })
    mockFindUniqueSnapshot.mockResolvedValue({
      finalSellingPrice: { toString: () => '17.004' },
      status: 'ACTIVE',
    })

    const result = await enforcePurchasePriceGuard({
      providerPackageId: 'pp-1',
      retailPriceUSD: 17.005,
      retailLocalPrice: 17.003,
    })

    expect(result.passed).toBe(true)
  })
})
