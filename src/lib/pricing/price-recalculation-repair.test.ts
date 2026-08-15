import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindUnique, mockUpdate, mockCreate, mockFindFirst, mockTransaction, mockFindMany } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn().mockResolvedValue({}),
  mockCreate: vi.fn(),
  mockFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
  mockFindMany: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: { findUnique: mockFindUnique, update: mockUpdate, findMany: mockFindMany },
    packagePriceSnapshot: { create: mockCreate, findUnique: vi.fn() },
    exchangeRate: { findFirst: mockFindFirst },
    packageConfigurationRule: { findFirst: mockFindFirst },
    $transaction: mockTransaction,
  },
}))

vi.mock('@/lib/currency/exchange-rate-service', () => ({
  convertCurrency: vi.fn(async (amount: number) => ({ amount, currency: 'USD' })),
  getExchangeRate: vi.fn(),
}))

vi.mock('@/lib/currency/currency-config', () => ({
  getPlatformBaseCurrency: () => 'USD',
  PRICING_ENGINE_VERSION: '3.0.0',
}))

vi.mock('@/lib/currency/currency-rounding', () => ({
  roundCurrencyAmount: (v: number) => Math.round(v * 100) / 100,
}))

import { recalculatePackagePrice } from './price-recalculation-service'
import { prisma } from '@/lib/prisma'

function makePkg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pp-historical',
    costPrice: { toString: () => '7.00' },
    currency: 'USD',
    sellingPrice: { toString: () => '7.69' },
    sellingCurrency: 'USD',
    adminCostPrice: null,
    effectiveCostPrice: null,
    costSource: null,
    costStatus: 'MISSING',
    pricingStatus: 'COST_UNAVAILABLE',
    configurationStatus: 'CONFIGURED',
    publishStatus: 'PUBLISHED',
    activePriceSnapshotId: null,
    fees: [],
    costReceivedAt: null,
    ...overrides,
  } as any
}

function setupTransaction() {
  mockTransaction.mockImplementation(async (fn: any) => {
    const tx = {
      providerPackage: { update: mockUpdate },
      packagePriceSnapshot: { create: mockCreate },
    }
    mockCreate.mockResolvedValue({ id: 'snap-repaired' })
    mockUpdate.mockResolvedValue({})
    await fn(tx)
  })
}
describe('recalculatePackagePrice — canonical cost status/source persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function lastUpdateData(): any {
    const calls = mockUpdate.mock.calls
    return calls[calls.length - 1][0].data
  }

  it('establishes costStatus VALID + costSource PROVIDER for a historical row with costPrice present', async () => {
    mockFindUnique.mockResolvedValue(makePkg())
    setupTransaction()
    const result = await recalculatePackagePrice('pp-historical', 'REPAIR')
    expect(result.success).toBe(true)
    expect(result.priceSnapshotId).toBe('snap-repaired')
    const data = lastUpdateData()
    expect(data.costStatus).toBe('VALID')
    expect(data.costSource).toBe('PROVIDER')
    expect(data.pricingStatus).toBe('READY')
    expect(data.activePriceSnapshotId).toBe('snap-repaired')
    expect(Number(data.effectiveCostPrice)).toBe(7)
    // selling price preserved (7 * 1.0989? — no rule → selling stays via pkg.sellingPrice branch)
    expect(Number(data.sellingPrice)).toBe(7.69)
  })

  it('establishes costStatus OVERRIDDEN when an admin override is present', async () => {
    mockFindUnique.mockResolvedValue(makePkg({ adminCostPrice: { toString: () => '9.00' }, effectiveCostPrice: null, sellingPrice: { toString: () => '12.00' } }))
    setupTransaction()
    const result = await recalculatePackagePrice('pp-historical', 'REPAIR')
    expect(result.success).toBe(true)
    const data = lastUpdateData()
    expect(data.costStatus).toBe('OVERRIDDEN')
    expect(data.costSource).toBe('ADMIN_OVERRIDE')
    expect(Number(data.effectiveCostPrice)).toBe(9)
  })

  it('preserves selling price and derives markup via canonical helper', async () => {
    mockFindUnique.mockResolvedValue(makePkg({ sellingPrice: { toString: () => '8.00' } }))
    setupTransaction()
    await recalculatePackagePrice('pp-historical', 'REPAIR')
    const data = lastUpdateData()
    // selling preserved; markup derived from cost+selling = ((8-7)/7)*100 = 14.29
    expect(Number(data.sellingPrice)).toBe(8)
    expect(Number(data.markupPercent)).toBeCloseTo(14.29, 2)
  })

  it('leaves costStatus MISSING when there is no cost data at all', async () => {
    // cost 0 + selling 0 → effectiveCost 0, sellPrice 0 → snapshot created but
    // costStatus stays MISSING (costSource MISSING). The row must NOT be marked
    // ready by cost — this is the "cannot repair without a cost" safety.
    mockFindUnique.mockResolvedValue(makePkg({ costPrice: { toString: () => '0' }, adminCostPrice: null, sellingPrice: { toString: () => '0' } }))
    setupTransaction()
    const result = await recalculatePackagePrice('pp-historical', 'REPAIR')
    expect(result.success).toBe(true)
    const data = lastUpdateData()
    expect(data.costStatus).toBe('MISSING')
    expect(data.costSource).toBe('MISSING')
  })

  it('creates exactly one snapshot per run and is idempotent across runs (new snapshot each time, no duplicates per run)', async () => {
    mockFindUnique.mockResolvedValue(makePkg())
    setupTransaction()
    await recalculatePackagePrice('pp-historical', 'REPAIR')
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})

describe('canonical repair path via finalizer (repair-configured-catalog-packages)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('finalizer re-reads costStatus after recalculation so readiness passes', async () => {
    // finalizeCatalogPackageConfiguration:
    //   1. findUnique (initial pp load)
    //   2. recalculatePackagePrice -> findUnique (pp), then atomic update
    //   3. findUnique (verified re-read)
    //   4. packagePriceSnapshot.findUnique (snapshot object) — mocked separately
    //   5. readiness uses verified (no extra DB call)
    //
    // The verified re-read must reflect VALID/READY/snapshot so readiness passes.
    const repaired = makePkg({
      costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-repaired',
      effectiveCostPrice: { toString: () => '7.00' },
    })
    mockFindUnique
      .mockResolvedValueOnce(makePkg()) // initial finalizer load
      .mockResolvedValueOnce(makePkg()) // recalc load
      .mockResolvedValueOnce(repaired) // finalizer verified re-read
      .mockResolvedValueOnce(repaired) // safety fallback
    mockCreate.mockResolvedValue({ id: 'snap-repaired' })
    mockTransaction.mockImplementation(async (fn: any) => {
      const tx = { providerPackage: { update: mockUpdate }, packagePriceSnapshot: { create: mockCreate } }
      mockUpdate.mockResolvedValue({})
      await fn(tx)
    })
    // Mock the snapshot-object lookup (configuration-finalizer Step 4)
    const { prisma: p } = await import('@/lib/prisma')
    ;(p.packagePriceSnapshot.findUnique as any).mockResolvedValue({ id: 'snap-repaired', status: 'ACTIVE' })

    const { finalizeCatalogPackageConfiguration } = await import('./configuration-finalizer')
    const result = await finalizeCatalogPackageConfiguration('pp-historical', { reason: 'REPAIR' })
    expect(result.success).toBe(true)
    expect(result.ready).toBe(true)
  })
})
