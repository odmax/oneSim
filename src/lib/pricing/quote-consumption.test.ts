import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    purchaseQuote: { findUnique: vi.fn(), updateMany: vi.fn() },
    packagePriceSnapshot: { findUnique: vi.fn() },
    eSIMPurchase: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    orderTimelineEvent: { create: vi.fn() },
    $transaction: vi.fn((fn: any) => fn({
      purchaseQuote: { findUnique: vi.fn(), updateMany: vi.fn() },
      packagePriceSnapshot: { findUnique: vi.fn() },
      eSIMPurchase: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
      orderTimelineEvent: { create: vi.fn() },
    })),
  },
}))

const { prisma } = await import('@/lib/prisma')
const { consumeQuoteAndCreateOrder } = await import('./purchase-quote-service')
const mockPrisma = vi.mocked(prisma)

function mockQuote(overrides: any = {}) {
  return {
    id: 'quote-1', status: 'ACTIVE', expiresAt: new Date(Date.now() + 3600000),
    businessId: 'biz-1', quantity: 1,
    unitPrice: { toString: () => '10' }, totalAmount: { toString: () => '10' }, currency: 'USD',
    packagePriceSnapshotId: 'snap-1', pricingEngineVersion: 'v2.5',
    providerPackageId: 'pp-1', ...overrides,
  }
}

type Tx = {
  purchaseQuote: { findUnique: any; updateMany: any }
  packagePriceSnapshot: { findUnique: any }
  eSIMPurchase: { create: any; findFirst: any; findUnique: any }
  orderTimelineEvent: { create: any }
}

function txWith(overrides: Partial<{ quote: any; updateCount: number; snapshot: any; createResult: any; findFirst: any }> = {}): Tx {
  const tx: Tx = {
    purchaseQuote: {
      findUnique: vi.fn().mockResolvedValue(overrides.quote ?? mockQuote()),
      updateMany: vi.fn().mockResolvedValue({ count: overrides.updateCount ?? 1 }),
    },
    packagePriceSnapshot: { findUnique: vi.fn().mockResolvedValue(overrides.snapshot ?? { id: 'snap-1', status: 'ACTIVE' }) },
    eSIMPurchase: { create: vi.fn().mockResolvedValue(overrides.createResult ?? { id: 'order-1' }), findFirst: vi.fn().mockResolvedValue(overrides.findFirst ?? null), findUnique: vi.fn() },
    orderTimelineEvent: { create: vi.fn() },
  }
  return tx
}

describe('consumeQuoteAndCreateOrder', () => {
  let tx: Tx

  beforeEach(() => {
    vi.clearAllMocks()
    tx = txWith()
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx))
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(null)
  })

  it('1. active quote consumed and order created atomically', async () => {
    const result = await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1 })
    expect(result.success).toBe(true)
    expect(result.orderId).toBe('order-1')
    expect(tx.purchaseQuote.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CONSUMED' }) }))
  })

  it('2. order links to purchaseQuoteId and snapshotId', async () => {
    await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1 })
    expect(tx.eSIMPurchase.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ purchaseQuoteId: 'quote-1', packagePriceSnapshotId: 'snap-1' }) }))
  })

  it('3. immutable pricing copied', async () => {
    await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1 })
    expect(tx.eSIMPurchase.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ quotedCurrency: 'USD', quotedQuantity: 1 }) }))
  })

  it('4. expired quote rejected', async () => {
    tx.purchaseQuote.findUnique.mockResolvedValue(mockQuote({ expiresAt: new Date(Date.now() - 1000) }))
    const r = await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1 })
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('QUOTE_EXPIRED')
  })

  it('5. invalidated quote rejected', async () => {
    tx.purchaseQuote.findUnique.mockResolvedValue(mockQuote({ status: 'INVALIDATED' }))
    const r = await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1 })
    expect(r.success).toBe(false)
  })

  it('6. wrong business rejected', async () => {
    const r = await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-2', userId: 'u1', packageId: 'pkg-1', quantity: 1 })
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('QUOTE_TENANT_MISMATCH')
  })

  it('7. quantity mismatch rejected', async () => {
    tx.purchaseQuote.findUnique.mockResolvedValue(mockQuote({ quantity: 2 }))
    const r = await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 3 })
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('QUOTE_QUANTITY_MISMATCH')
  })

  it('8. missing snapshot rejected', async () => {
    tx.packagePriceSnapshot.findUnique.mockResolvedValue(null)
    const r = await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1 })
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('QUOTE_SNAPSHOT_MISSING')
  })

  it('9. concurrent consumption: updateMany count 0 → already consumed', async () => {
    tx.purchaseQuote.updateMany.mockResolvedValue({ count: 0 })
    const r = await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1 })
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('QUOTE_ALREADY_CONSUMED')
  })

  it('10. consumed quote resolves linked order', async () => {
    tx.purchaseQuote.findUnique.mockResolvedValue(mockQuote({ status: 'CONSUMED' }))
    tx.purchaseQuote.updateMany.mockResolvedValue({ count: 0 })
    tx.eSIMPurchase.findFirst.mockResolvedValue({ id: 'order-existing', status: 'FULFILLED' })
    const r = await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1 })
    expect(r.success).toBe(true)
    expect(r.alreadyConsumed).toBe(true)
    expect(r.existingOrderId).toBe('order-existing')
  })

  it('11. idempotency key finds existing order', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-existing', status: 'FULFILLED' } as any)
    const r = await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1, idempotencyKey: 'key-1' })
    expect(r.success).toBe(true)
    expect(r.alreadyConsumed).toBe(true)
    expect(r.existingOrderId).toBe('order-existing')
  })

  it('12. transaction failure does not create order', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const et = txWith()
      et.purchaseQuote.updateMany.mockRejectedValue(new Error('DB error'))
      try { return await fn(et) } catch (e: any) { return { success: false, error: e.message, errorCode: 'TRANSACTION_FAILED' } }
    })
    const r = await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1 })
    expect(r.success).toBe(false)
  })

  it('13. pricing engine version copied', async () => {
    await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1 })
    expect(tx.eSIMPurchase.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pricingEngineVersion: 'v2.5' }) }))
  })

  it('14. ORDER_CREATED_FROM_QUOTE timeline recorded', async () => {
    await consumeQuoteAndCreateOrder({ quoteReference: 'QT-123', businessId: 'biz-1', userId: 'u1', packageId: 'pkg-1', quantity: 1 })
    expect(tx.orderTimelineEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'ORDER_CREATED_FROM_QUOTE' }) }))
  })
})
