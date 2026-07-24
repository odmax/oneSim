import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  },
}))

vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn().mockResolvedValue({ user: { id: 'user-1', role: 'INTERNAL_ADMIN' } }),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import {
  decimalValuesEqual,
  parseDecimalSafe,
  buildCatalogProductSyncData,
  getCatalogPricingDifferences,
  ProviderPackageInput,
  CatalogProductSummary,
} from './catalog-price-utils'
import {
  syncProviderPackageToPublishedProducts,
  recordCatalogPriceSyncAudit,
  revalidateCatalogRoutes,
  CatalogPriceSyncResult,
} from './catalog-price-sync'

const mockProviderPackage: ProviderPackageInput = {
  id: 'pp-1',
  name: 'Test Package 7GB 30D',
  dataGB: 7,
  validityDays: 30,
  costPrice: { toString: () => '5.00' },
  currency: 'USD',
  sellingPrice: { toString: () => '19.99' },
  sellingCurrency: 'USD',
  markupPercent: { toString: () => '25' },
  providerPlanId: 'plan-1',
  providerId: 'prov-1',
  publishStatus: 'PUBLISHED',
}

function mockDecimal(value: string) {
  return { toString: () => value }
}

describe('decimalValuesEqual', () => {
  it('returns true for both null', () => {
    expect(decimalValuesEqual(null, null)).toBe(true)
  })

  it('returns true for both undefined', () => {
    expect(decimalValuesEqual(undefined, undefined)).toBe(true)
  })

  it('returns true for null and undefined', () => {
    expect(decimalValuesEqual(null, undefined)).toBe(true)
  })

  it('returns false when one is null and other has value', () => {
    expect(decimalValuesEqual(null, mockDecimal('10'))).toBe(false)
    expect(decimalValuesEqual(mockDecimal('10'), null)).toBe(false)
  })

  it('returns true for equal values with same scale', () => {
    expect(decimalValuesEqual(mockDecimal('20.10'), mockDecimal('20.10'))).toBe(true)
  })

  it('returns true for equal values with different scale', () => {
    expect(decimalValuesEqual(mockDecimal('20.1'), mockDecimal('20.10'))).toBe(true)
  })

  it('returns true for integer values', () => {
    expect(decimalValuesEqual(mockDecimal('25'), mockDecimal('25'))).toBe(true)
  })

  it('returns false for different values', () => {
    expect(decimalValuesEqual(mockDecimal('19.99'), mockDecimal('25.00'))).toBe(false)
  })

  it('returns false for slightly different values', () => {
    expect(decimalValuesEqual(mockDecimal('19.99'), mockDecimal('19.98'))).toBe(false)
  })
})

describe('parseDecimalSafe', () => {
  it('returns null for null input', () => {
    expect(parseDecimalSafe(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(parseDecimalSafe(undefined as any)).toBeNull()
  })

  it('parses a valid decimal string', () => {
    expect(parseDecimalSafe(mockDecimal('19.99'))).toBeCloseTo(19.99, 2)
  })

  it('parses an integer string', () => {
    expect(parseDecimalSafe(mockDecimal('25'))).toBe(25)
  })

  it('returns null for NaN input', () => {
    const nanMock = { toString: () => 'not-a-number' }
    expect(parseDecimalSafe(nanMock)).toBeNull()
  })
})

describe('buildCatalogProductSyncData', () => {
  it('returns all mapped fields', () => {
    const data = buildCatalogProductSyncData(mockProviderPackage)

    expect(data.name).toBe('Test Package 7GB 30D')
    expect(data.displayName).toBe('Test Package 7GB 30D')
    expect(data.dataGB).toBe(7)
    expect(data.validityDays).toBe(30)
    expect(data.priceUSD).toBeCloseTo(19.99, 2)
    expect(data.localPrice).toBeCloseTo(19.99, 2)
    expect(data.currency).toBe('USD')
    expect(data.costPriceUSD).toBeCloseTo(5.00, 2)
    expect(data.costCurrency).toBe('USD')
    expect(data.markupPercent).toBeCloseTo(25, 1)
    expect(data.providerPlanId).toBe('plan-1')
    expect(data.providerId).toBe('prov-1')
  })

  it('falls back to provider currency when sellingCurrency is null', () => {
    const pp = { ...mockProviderPackage, sellingCurrency: null, currency: 'EUR' }
    const data = buildCatalogProductSyncData(pp)
    expect(data.currency).toBe('EUR')
  })

  it('uses 0 for null sellingPrice', () => {
    const pp = { ...mockProviderPackage, sellingPrice: null }
    const data = buildCatalogProductSyncData(pp)
    expect(data.priceUSD).toBe(0)
    expect(data.localPrice).toBe(0)
  })

  it('handles null markupPercent', () => {
    const pp = { ...mockProviderPackage, markupPercent: null }
    const data = buildCatalogProductSyncData(pp)
    expect(data.markupPercent).toBeNull()
  })
})

describe('getCatalogPricingDifferences', () => {
  it('returns empty array when values match', () => {
    const product: CatalogProductSummary = {
      id: 'esim-1',
      priceUSD: mockDecimal('19.99'),
      markupPercent: mockDecimal('25'),
      hiddenFromCatalog: false,
      archivedAt: null,
    }
    expect(getCatalogPricingDifferences(mockProviderPackage, product)).toEqual([])
  })

  it('handles scale differences without false positives', () => {
    const product: CatalogProductSummary = {
      id: 'esim-1',
      priceUSD: mockDecimal('19.990'),
      markupPercent: mockDecimal('25.0'),
      hiddenFromCatalog: false,
      archivedAt: null,
    }
    expect(getCatalogPricingDifferences(mockProviderPackage, product)).toEqual([])
  })

  it('detects selling price difference', () => {
    const product: CatalogProductSummary = {
      id: 'esim-1',
      priceUSD: mockDecimal('15.00'),
      markupPercent: mockDecimal('25'),
      hiddenFromCatalog: false,
      archivedAt: null,
    }
    const diffs = getCatalogPricingDifferences(mockProviderPackage, product)
    expect(diffs).toContain('priceUSD')
  })

  it('detects markup difference', () => {
    const product: CatalogProductSummary = {
      id: 'esim-1',
      priceUSD: mockDecimal('19.99'),
      markupPercent: mockDecimal('30'),
      hiddenFromCatalog: false,
      archivedAt: null,
    }
    const diffs = getCatalogPricingDifferences(mockProviderPackage, product)
    expect(diffs).toContain('markupPercent')
  })

  it('detects both differences simultaneously', () => {
    const product: CatalogProductSummary = {
      id: 'esim-1',
      priceUSD: mockDecimal('15.00'),
      markupPercent: mockDecimal('30'),
      hiddenFromCatalog: false,
      archivedAt: null,
    }
    const diffs = getCatalogPricingDifferences(mockProviderPackage, product)
    expect(diffs).toContain('priceUSD')
    expect(diffs).toContain('markupPercent')
  })
})

describe('syncProviderPackageToPublishedProducts', () => {
  let mockTx: any

  beforeEach(() => {
    mockTx = {
      eSIMPackage: {
        findMany: vi.fn(),
        update: vi.fn().mockResolvedValue({ id: 'esim-1' }),
      },
    }
  })

  it('updates linked product with all intended fields', async () => {
    mockTx.eSIMPackage.findMany.mockResolvedValue([
      { id: 'esim-1', priceUSD: mockDecimal('19.99'), markupPercent: mockDecimal('25'), hiddenFromCatalog: false, archivedAt: null },
    ])

    const result = await syncProviderPackageToPublishedProducts(mockTx, mockProviderPackage)

    expect(result.status).toBe('SYNCED')
    expect(result.matchedProducts).toBe(1)
    expect(result.updatedProducts).toBe(1)
    expect(result.productIds).toEqual(['esim-1'])

    expect(mockTx.eSIMPackage.update).toHaveBeenCalledWith({
      where: { id: 'esim-1' },
      data: expect.objectContaining({
        name: 'Test Package 7GB 30D',
        priceUSD: expect.any(Number),
        markupPercent: expect.any(Number),
      }),
    })
  })

  it('returns NO_LINKED_PRODUCT when no linked products exist', async () => {
    mockTx.eSIMPackage.findMany.mockResolvedValue([])

    const result = await syncProviderPackageToPublishedProducts(mockTx, mockProviderPackage)

    expect(result.status).toBe('NO_LINKED_PRODUCT')
    expect(result.matchedProducts).toBe(0)
    expect(result.updatedProducts).toBe(0)
    expect(result.productIds).toEqual([])
    expect(mockTx.eSIMPackage.update).not.toHaveBeenCalled()
  })

  it('does not throw when no linked product', async () => {
    mockTx.eSIMPackage.findMany.mockResolvedValue([])

    await expect(
      syncProviderPackageToPublishedProducts(mockTx, mockProviderPackage),
    ).resolves.toBeDefined()
  })

  it('updates hidden linked product pricing', async () => {
    mockTx.eSIMPackage.findMany.mockResolvedValue([
      { id: 'esim-hidden', priceUSD: mockDecimal('19.99'), markupPercent: mockDecimal('25'), hiddenFromCatalog: true, archivedAt: null },
    ])

    const result = await syncProviderPackageToPublishedProducts(mockTx, mockProviderPackage)

    expect(result.updatedProducts).toBe(1)
    expect(mockTx.eSIMPackage.update).toHaveBeenCalled()
  })

  it('does not include hiddenFromCatalog or archivedAt in update call', async () => {
    mockTx.eSIMPackage.findMany.mockResolvedValue([
      { id: 'esim-1', priceUSD: mockDecimal('19.99'), markupPercent: mockDecimal('25'), hiddenFromCatalog: false, archivedAt: null },
    ])

    await syncProviderPackageToPublishedProducts(mockTx, mockProviderPackage)

    const updateCall = mockTx.eSIMPackage.update.mock.calls[0][0]
    expect(updateCall.where).toEqual({ id: 'esim-1' })
    const updateData = updateCall.data
    expect(updateData).not.toHaveProperty('hiddenFromCatalog')
    expect(updateData).not.toHaveProperty('archivedAt')
    expect(updateData).not.toHaveProperty('isActive')
    expect(updateData).not.toHaveProperty('createdAt')
  })

  it('counts failed updates in skippedProducts', async () => {
    mockTx.eSIMPackage.findMany.mockResolvedValue([
      { id: 'esim-1', priceUSD: mockDecimal('19.99'), markupPercent: mockDecimal('25'), hiddenFromCatalog: false, archivedAt: null },
      { id: 'esim-2', priceUSD: mockDecimal('19.99'), markupPercent: mockDecimal('25'), hiddenFromCatalog: false, archivedAt: null },
    ])

    mockTx.eSIMPackage.update
      .mockResolvedValueOnce({ id: 'esim-1' })
      .mockRejectedValueOnce(new Error('DB error'))

    const result = await syncProviderPackageToPublishedProducts(mockTx, mockProviderPackage)

    expect(result.matchedProducts).toBe(2)
    expect(result.updatedProducts).toBe(1)
    expect(result.skippedProducts).toBe(1)
    expect(result.productIds).toEqual(['esim-1', 'esim-2'])
    expect(result.status).toBe('SYNCED')
  })

  it('all update failures return ERROR status', async () => {
    mockTx.eSIMPackage.findMany.mockResolvedValue([
      { id: 'esim-1', priceUSD: mockDecimal('19.99'), markupPercent: mockDecimal('25'), hiddenFromCatalog: false, archivedAt: null },
    ])

    mockTx.eSIMPackage.update.mockRejectedValue(new Error('DB error'))

    const result = await syncProviderPackageToPublishedProducts(mockTx, mockProviderPackage)

    expect(result.updatedProducts).toBe(0)
    expect(result.skippedProducts).toBe(1)
    expect(result.status).toBe('ERROR')
  })

  it('builds syncData using buildCatalogProductSyncData', async () => {
    mockTx.eSIMPackage.findMany.mockResolvedValue([
      { id: 'esim-1', priceUSD: mockDecimal('19.99'), markupPercent: mockDecimal('25'), hiddenFromCatalog: false, archivedAt: null },
    ])

    await syncProviderPackageToPublishedProducts(mockTx, mockProviderPackage)

    const updateData = mockTx.eSIMPackage.update.mock.calls[0][0].data
    expect(updateData).toEqual(expect.objectContaining({
      name: mockProviderPackage.name,
      displayName: mockProviderPackage.name,
      dataGB: mockProviderPackage.dataGB,
      validityDays: mockProviderPackage.validityDays,
      providerPlanId: mockProviderPackage.providerPlanId,
      providerId: mockProviderPackage.providerId,
    }))
  })
})

describe('recordCatalogPriceSyncAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates audit log with correct action and details', async () => {
    const { prisma } = await import('@/lib/prisma') as any
    const syncResult: CatalogPriceSyncResult = {
      matchedProducts: 1, updatedProducts: 1, skippedProducts: 0,
      productIds: ['esim-1'],
      oldSellingPrice: '15.00', newSellingPrice: '19.99',
      oldMarkup: '20', newMarkup: '25',
      status: 'SYNCED',
    }

    await recordCatalogPriceSyncAudit(
      'MANUAL_EDIT', 'pp-1', syncResult,
      '15.00', '19.99', '20', '25',
    )

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'CATALOG_PRICE_SYNC_MANUAL_EDIT',
          entity: 'ProviderPackage',
          entityId: 'pp-1',
        }),
      }),
    )
  })

  it('returns early when no session', async () => {
    const mockNextAuth = await import('next-auth') as any
    mockNextAuth.getServerSession.mockResolvedValueOnce(null)

    const { prisma } = await import('@/lib/prisma') as any
    const syncResult: CatalogPriceSyncResult = {
      matchedProducts: 0, updatedProducts: 0, skippedProducts: 0,
      productIds: [],
      oldSellingPrice: null, newSellingPrice: null,
      oldMarkup: null, newMarkup: null,
      status: 'NO_LINKED_PRODUCT',
    }

    await recordCatalogPriceSyncAudit(
      'BACKFILL', 'pp-1', syncResult,
      null, null, null, null,
    )

    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })
})

describe('revalidateCatalogRoutes', () => {
  it('calls revalidatePath for all catalog routes', async () => {
    const { revalidatePath } = await import('next/cache') as any

    await revalidateCatalogRoutes()

    expect(revalidatePath).toHaveBeenCalledWith('/admin/provider-catalog')
    expect(revalidatePath).toHaveBeenCalledWith('/admin/packages')
    expect(revalidatePath).toHaveBeenCalledWith('/admin/catalog-products')
    expect(revalidatePath).toHaveBeenCalledWith('/business/buy-esim')
    expect(revalidatePath).toHaveBeenCalledWith('/business/esims')
    expect(revalidatePath).toHaveBeenCalledWith('/api/packages')
  })

  it('revalidates additional path when provided', async () => {
    const { revalidatePath } = await import('next/cache') as any

    await revalidateCatalogRoutes('/extra/path')

    expect(revalidatePath).toHaveBeenCalledWith('/extra/path')
  })
})