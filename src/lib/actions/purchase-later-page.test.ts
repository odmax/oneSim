import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  findUnique: vi.fn(),
  createPurchaseQuote: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@/lib/prisma', () => ({
  prisma: { eSIMPackage: { findUnique: mocks.findUnique } },
}))
vi.mock('@/lib/pricing/purchase-quote-service', () => ({
  createPurchaseQuote: mocks.createPurchaseQuote,
}))

import { requestPurchaseQuote } from './purchase'
import { PurchaseQuote } from '@/lib/pricing/purchase-quote-service'

function readyRetail(overrides: Record<string, any> = {}) {
  return {
    id: 'retail-049',
    isActive: true,
    hiddenFromCatalog: false,
    archivedAt: null,
    source: 'CATALOG_PRODUCT',
    providerPackageId: 'pp-049',
    providerPackage: {
      costStatus: 'VALID',
      pricingStatus: 'READY',
      publishStatus: 'PUBLISHED',
      configurationStatus: 'CONFIGURED',
      activePriceSnapshotId: 'snap-049',
      sellingPrice: { toString: () => '9.99' },
      costPrice: { toString: () => '3.00' },
    },
    provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'CHOICE' },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { role: 'BUSINESS_USER', businessId: 'biz-1', id: 'u-1' } })
  mocks.findUnique.mockResolvedValue(readyRetail())
  mocks.createPurchaseQuote.mockResolvedValue({
    success: true,
    quote: {
      reference: 'QR-LATER-PAGE',
      unitPrice: 9.99,
      totalAmount: 49.95,
      quantity: 5,
    },
  })
})

describe('purchase/quote from later pages — page-agnostic by packageId', () => {
  it('a package only reachable on later render windows still quotes by packageId', async () => {
    // 64 eligible products; "retail-049" is only in window 3 (index 48..71).
    const result = await requestPurchaseQuote('retail-049', 5)
    expect(result.success).toBe(true)
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'retail-049' } }),
    )
    expect(mocks.createPurchaseQuote).toHaveBeenCalledWith({
      businessId: 'biz-1',
      providerPackageId: 'pp-049',
      quantity: 5,
    })
    expect(result.quote?.reference).toBe('QR-LATER-PAGE')
  })

  it('a package that lost readiness between pages fails safe with a clear reason', async () => {
    mocks.findUnique.mockResolvedValue(readyRetail({ providerPackage: { ...readyRetail().providerPackage, publishStatus: 'HIDDEN' } }))
    const result = await requestPurchaseQuote('retail-049', 1)
    expect(result.success).toBe(false)
  })
})