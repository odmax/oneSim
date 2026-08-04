import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: { findUnique: vi.fn() },
    walletTransaction: { findFirst: vi.fn() },
    providerInventoryReservation: { findFirst: vi.fn() },
    orderCallbackDelivery: { count: vi.fn() },
    providerWebhookEvent: { count: vi.fn() },
  },
}))

const { prisma } = await import('@/lib/prisma')
const { getOrderOperationsActions } = await import('./order-operation-actions')
const mockPrisma = vi.mocked(prisma)

function mockOrder(overrides: any = {}) {
  return {
    id: 'order-1', status: 'PAYMENT_RESERVED', providerFulfillId: null, providerReservationId: null,
    retryCount: 0, maxRetries: 5, quantity: 1, fulfilledQuantity: 0,
    totalAmount: { toString: () => '10' }, businessId: 'biz-1',
    provider: { id: 'p1', type: 'CHOICE', supportsUsage: true },
    esims: [],
    ...overrides,
  }
}

describe('getOrderOperationsActions', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('1. resume visible with fulfillment evidence + incomplete work', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder({ providerFulfillId: 'ref-1', esims: [] }) as any)
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)
    mockPrisma.providerInventoryReservation.findFirst.mockResolvedValue(null)
    mockPrisma.orderCallbackDelivery.count.mockResolvedValue(0)
    mockPrisma.providerWebhookEvent.count.mockResolvedValue(0)

    const actions = await getOrderOperationsActions('order-1')
    expect(actions.resumeFinalization.visible).toBe(true)
    expect(actions.resumeFinalization.enabled).toBe(true)
  })

  it('2. resume hidden for fulfilled order', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder({ status: 'FULFILLED', providerFulfillId: 'ref-1' }) as any)
    mockPrisma.walletTransaction.findFirst.mockResolvedValue({} as any)
    mockPrisma.providerInventoryReservation.findFirst.mockResolvedValue(null)
    mockPrisma.orderCallbackDelivery.count.mockResolvedValue(0)
    mockPrisma.providerWebhookEvent.count.mockResolvedValue(0)

    const actions = await getOrderOperationsActions('order-1')
    expect(actions.resumeFinalization.visible).toBe(false)
  })

  it('3. safe redispatch hidden when providerFulfillId exists', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder({ status: 'FAILED', providerFulfillId: 'ref-1' }) as any)
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)
    mockPrisma.providerInventoryReservation.findFirst.mockResolvedValue(null)
    mockPrisma.orderCallbackDelivery.count.mockResolvedValue(0)
    mockPrisma.providerWebhookEvent.count.mockResolvedValue(0)

    const actions = await getOrderOperationsActions('order-1')
    expect(actions.safeRedispatch.enabled).toBe(false)
  })

  it('4. safe redispatch visible for clean FAILED without evidence', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder({ status: 'FAILED' }) as any)
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)
    mockPrisma.providerInventoryReservation.findFirst.mockResolvedValue(null)
    mockPrisma.orderCallbackDelivery.count.mockResolvedValue(0)
    mockPrisma.providerWebhookEvent.count.mockResolvedValue(0)

    const actions = await getOrderOperationsActions('order-1')
    expect(actions.safeRedispatch.visible).toBe(true)
    expect(actions.safeRedispatch.enabled).toBe(true)
  })

  it('5. safe redispatch hidden for cancelled order', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder({ status: 'CANCELLED' }) as any)
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)
    mockPrisma.providerInventoryReservation.findFirst.mockResolvedValue(null)
    mockPrisma.orderCallbackDelivery.count.mockResolvedValue(0)
    mockPrisma.providerWebhookEvent.count.mockResolvedValue(0)

    const actions = await getOrderOperationsActions('order-1')
    expect(actions.safeRedispatch.visible).toBe(false)
  })

  it('6. reconciliation visible for PROVIDER_RECONCILIATION', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder({ status: 'PROVIDER_RECONCILIATION' }) as any)
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)
    mockPrisma.providerInventoryReservation.findFirst.mockResolvedValue(null)
    mockPrisma.orderCallbackDelivery.count.mockResolvedValue(0)
    mockPrisma.providerWebhookEvent.count.mockResolvedValue(0)

    const actions = await getOrderOperationsActions('order-1')
    expect(actions.startReconciliation.visible).toBe(true)
    expect(actions.startReconciliation.enabled).toBe(true)
  })

  it('7. inventory release blocked when provider evidence exists', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder() as any)
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)
    mockPrisma.providerInventoryReservation.findFirst.mockResolvedValue({ providerReservationReference: 'ref-1' } as any)
    mockPrisma.orderCallbackDelivery.count.mockResolvedValue(0)
    mockPrisma.providerWebhookEvent.count.mockResolvedValue(0)

    const actions = await getOrderOperationsActions('order-1')
    expect(actions.releaseInventory.enabled).toBe(false)
  })

  it('8. mark reviewed always visible', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder() as any)
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)
    mockPrisma.providerInventoryReservation.findFirst.mockResolvedValue(null)
    mockPrisma.orderCallbackDelivery.count.mockResolvedValue(0)
    mockPrisma.providerWebhookEvent.count.mockResolvedValue(0)

    const actions = await getOrderOperationsActions('order-1')
    expect(actions.markReviewed.visible).toBe(true)
    expect(actions.markReviewed.enabled).toBe(true)
  })

  it('9. order not found → all hidden', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(null)
    const actions = await getOrderOperationsActions('order-1')
    expect(actions.resumeFinalization.visible).toBe(false)
    expect(actions.pollProvider.visible).toBe(false)
    expect(actions.safeRedispatch.visible).toBe(false)
  })
})
