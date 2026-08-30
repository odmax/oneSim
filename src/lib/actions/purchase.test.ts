import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPackage: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/services/orders/create-order', () => ({
  createOrder: vi.fn(),
}))

vi.mock('@/lib/pricing/purchase-quote-service', () => ({
  createPurchaseQuote: vi.fn(),
}))

import { getServerSession } from 'next-auth'
import { prisma } from '@/lib/prisma'
import { createOrder } from '@/lib/services/orders/create-order'
import { createPurchaseQuote } from '@/lib/pricing/purchase-quote-service'
import { executePurchase, requestPurchaseQuote } from './purchase'

const mockSession = vi.mocked(getServerSession)
const mockCreateOrder = vi.mocked(createOrder)
const mockPrisma = vi.mocked(prisma)
const mockCreateQuote = vi.mocked(createPurchaseQuote)

const BUSINESS_SESSION = { user: { id: 'user-1', businessId: 'biz-1', role: 'BUSINESS_USER' } } as any

function readyProviderPkg() {
  return {
    id: 'pkg-1',
    providerPackageId: 'pp-1',
    providerPackage: { costStatus: 'VALID', pricingStatus: 'READY', publishStatus: 'PUBLISHED', configurationStatus: 'CONFIGURED', activePriceSnapshotId: 'snap-1', sellingPrice: '5', costPrice: '2' },
    provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'CHOICE' },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'test-secret-0123456789abcdef'
  mockSession.mockResolvedValue(BUSINESS_SESSION)
  mockCreateOrder.mockResolvedValue({ success: true, orderId: 'order-1', status: 'PROCESSING' } as any)
})

describe('executePurchase — quote + idempotency forwarding', () => {
  it('forwards quoteReference, idempotencyKey, and async:true to createOrder', async () => {
    const result = await executePurchase({
      packageId: 'pkg-1',
      quantity: 1,
      quoteReference: 'QT-abc',
      idempotencyKey: 'client-key-1',
    })

    expect(result.success).toBe(true)
    expect(result.orderId).toBe('order-1')
    expect(mockCreateOrder).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'biz-1',
      userId: 'user-1',
      packageId: 'pkg-1',
      quantity: 1,
      quoteReference: 'QT-abc',
      idempotencyKey: 'client-key-1',
      async: true,
    }))
  })

  it('omits quoteReference/idempotencyKey when absent (no phantom field)', async () => {
    await executePurchase({ packageId: 'pkg-1', quantity: 1 })

    const args = mockCreateOrder.mock.calls[0][0] as any
    expect(args.quoteReference).toBeUndefined()
    expect(args.idempotencyKey).toBeUndefined()
  })

  it('rejects invalid quantity before calling createOrder', async () => {
    const result = await executePurchase({ packageId: 'pkg-1', quantity: 0, quoteReference: 'QT-abc' })
    expect(result.success).toBe(false)
    expect(result.code).toBe('invalid_input')
    expect(mockCreateOrder).not.toHaveBeenCalled()
  })

  it('maps a QUOTE-EXPIRED error to the public quote_expired code', async () => {
    mockCreateOrder.mockResolvedValueOnce({ success: false, errorCode: 'QUOTE_EXPIRED', error: 'Quote has expired' } as any)
    const result = await executePurchase({ packageId: 'pkg-1', quantity: 1, quoteReference: 'QT-expired' })
    expect(result.success).toBe(false)
    expect(result.code).toBe('quote_expired')
  })

  it('rejects invalid travelDate before calling createOrder', async () => {
    const result = await executePurchase({ packageId: 'pkg-1', quantity: 1, travelDate: '02-08-2026' })
    expect(result.success).toBe(false)
    expect(result.code).toBe('invalid_input')
    expect(mockCreateOrder).not.toHaveBeenCalled()
  })
})

describe('requestPurchaseQuote — readiness gate + quote creation', () => {
  it('fails closed with package_pricing_unavailable when the package is not purchase-ready', async () => {
    mockPrisma.eSIMPackage.findUnique.mockResolvedValue({
      ...readyProviderPkg(),
      providerPackage: { ...readyProviderPkg().providerPackage, publishStatus: 'DRAFT' },
    } as any)

    const result = await requestPurchaseQuote('pkg-1', 1)
    expect(result.success).toBe(false)
    expect(result.code).toBe('package_pricing_unavailable')
    expect(mockCreateQuote).not.toHaveBeenCalled()
  })

  it('passes only the providerPackageId + business + quantity to createPurchaseQuote', async () => {
    mockPrisma.eSIMPackage.findUnique.mockResolvedValue(readyProviderPkg() as any)
    mockCreateQuote.mockResolvedValue({ success: true, quote: { reference: 'QT-1', unitPrice: 5, totalAmount: 5, currency: 'USD', expiresAt: new Date().toISOString() } })

    const result = await requestPurchaseQuote('pkg-1', 1)
    expect(result.success).toBe(true)
    expect(mockCreateQuote).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz-1', providerPackageId: 'pp-1', quantity: 1 }))
  })
})