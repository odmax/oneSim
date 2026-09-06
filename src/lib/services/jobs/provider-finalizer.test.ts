import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: { findUnique: vi.fn(), update: vi.fn() },
    eSIMPackage: { findUnique: vi.fn() },
    eSIM: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}))

vi.mock('@/lib/services/orders/wallet-actions', () => ({
  captureReservedFunds: vi.fn(),
  releaseReservedFunds: vi.fn(),
}))

vi.mock('@/lib/services/orders/order-state-machine', () => ({
  failOrder: vi.fn(),
  createTimelineEvent: vi.fn(),
}))

vi.mock('@/lib/services/orders/fulfillment', () => ({
  completeProviderFinalization: vi.fn(),
}))

const { prisma } = await import('@/lib/prisma')
const { captureReservedFunds, releaseReservedFunds } = await import('@/lib/services/orders/wallet-actions')
const { failOrder, createTimelineEvent } = await import('@/lib/services/orders/order-state-machine')
const { completeProviderFinalization } = await import('@/lib/services/orders/fulfillment')
const { completeProviderOperation, failProviderOperation } = await import('./provider-finalizer')

const mockPrisma = vi.mocked(prisma)
const mockCapture = vi.mocked(captureReservedFunds)
const mockRelease = vi.mocked(releaseReservedFunds)
const mockFailOrder = vi.mocked(failOrder)
const mockCompleteFulfill = vi.mocked(completeProviderFinalization)

const ORDER_ID = 'order-1'
const PROVIDER_REF = 'act-1'

describe('provider-finalizer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.auditLog.create.mockResolvedValue({} as any)
  })

  describe('completeProviderOperation', () => {
    it('delegates to completeProviderFinalization with the correct params', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: ORDER_ID, businessId: 'b1', userId: 'u1', status: 'CREATED', totalAmount: { toString: () => '5' } } as any)
      mockCompleteFulfill.mockResolvedValue({ success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true })

      const result = await completeProviderOperation({ orderId: ORDER_ID, businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, providerName: 'iBASIS', totalAmount: 5, iccids: ['89012345678901234567'] })

      expect(result.success).toBe(true)
      expect(mockCompleteFulfill).toHaveBeenCalledWith(expect.objectContaining({
        orderId: ORDER_ID,
        providerRef: PROVIDER_REF,
        providerName: 'iBASIS',
        totalAmount: 5,
        providerResult: expect.objectContaining({ iccids: ['89012345678901234567'] }),
      }))
    })

    it('short-circuits when order is already FULFILLED', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: ORDER_ID, status: 'FULFILLED', totalAmount: { toString: () => '5' } } as any)

      const result = await completeProviderOperation({ orderId: ORDER_ID, businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, providerName: 'iBASIS', totalAmount: 5, iccids: ['89012345678901234567'] })

      expect(result.success).toBe(true)
      expect(result.alreadyDone).toBe(true)
      expect(mockCompleteFulfill).not.toHaveBeenCalled()
    })

    it('forwards normalized install data into providerResult', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: ORDER_ID, businessId: 'b1', userId: 'u1', status: 'CREATED', totalAmount: { toString: () => '5' } } as any)
      mockCompleteFulfill.mockResolvedValue({ success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true })

      const result = await completeProviderOperation({
        orderId: ORDER_ID, businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, providerName: 'iBASIS', totalAmount: 5,
        iccids: ['89012345678901234567'],
        activationCode: 'LPA:1$smdp.example.com$mid',
        qrCodeUrl: 'https://qr.example/q.png',
        qrCode: 'data:image/png;base64,AAAA',
        smdpAddress: 'smdp.example.com',
        matchingId: 'mid-1',
        rawMetadata: { orderId: PROVIDER_REF },
      })

      expect(result.success).toBe(true)
      expect(mockCompleteFulfill).toHaveBeenCalledWith(expect.objectContaining({
        providerResult: expect.objectContaining({
          iccids: ['89012345678901234567'],
          activationCode: 'LPA:1$smdp.example.com$mid',
          qrCodeUrl: 'https://qr.example/q.png',
          qrCode: 'data:image/png;base64,AAAA',
          smdpAddress: 'smdp.example.com',
          matchingId: 'mid-1',
          rawMetadata: { orderId: PROVIDER_REF },
        }),
      }))
    })

    it('returns error when order is not found', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(null as any)
      const result = await completeProviderOperation({ orderId: 'missing', businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, providerName: 'iBASIS', totalAmount: 5, iccids: ['89012345678901234567'] })
      expect(result.success).toBe(false)
    })

    it('returns recovery-required when finalization fails with recovery flag', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: ORDER_ID, businessId: 'b1', userId: 'u1', status: 'CREATED', totalAmount: { toString: () => '5' } } as any)
      mockCompleteFulfill.mockResolvedValue({ success: false, recoveryRequired: true, orderStatus: 'CREATED', walletCaptured: false, eSIMsPersisted: false, error: 'Partial eSIM persistence' })

      const result = await completeProviderOperation({ orderId: ORDER_ID, businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, providerName: 'iBASIS', totalAmount: 5, iccids: ['89012345678901234567'] })

      expect(result.success).toBe(false)
      expect(result.recoveryRequired).toBe(true)
    })
  })

  describe('failProviderOperation', () => {
    it('releases wallet funds and fails the order when no fulfillment evidence exists', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: ORDER_ID, businessId: 'b1', userId: 'u1', status: 'CREATED', totalAmount: { toString: () => '5' }, providerFulfillId: null, providerReservationId: null } as any)
      mockRelease.mockResolvedValue({ success: true } as any)
      mockFailOrder.mockResolvedValue(undefined as any)

      const result = await failProviderOperation({ orderId: ORDER_ID, businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, totalAmount: 5, reason: 'ACTIVATION_FAILED' })

      expect(result.success).toBe(true)
      expect(mockRelease).toHaveBeenCalledWith(ORDER_ID, 'b1', 5, { confirmedFailure: true })
      expect(mockFailOrder).toHaveBeenCalledWith(ORDER_ID, 'ACTIVATION_FAILED')
    })

    it('blocks release when providerFulfillId exists (fulfillment evidence)', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: ORDER_ID, businessId: 'b1', userId: 'u1', status: 'CREATED', totalAmount: { toString: () => '5' }, providerFulfillId: 'ref-1', providerReservationId: null } as any)

      const result = await failProviderOperation({ orderId: ORDER_ID, businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, totalAmount: 5, reason: 'ACTIVATION_FAILED' })

      expect(result.success).toBe(false)
      expect(result.blockedByFulfillment).toBe(true)
      expect(mockRelease).not.toHaveBeenCalled()
    })

    it('short-circuits when order is already FULFILLED (no release)', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: ORDER_ID, businessId: 'b1', userId: 'u1', status: 'FULFILLED', totalAmount: { toString: () => '5' } } as any)

      const result = await failProviderOperation({ orderId: ORDER_ID, businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, totalAmount: 5, reason: 'ACTIVATION_FAILED' })

      expect(result.success).toBe(true)
      expect(result.alreadyDone).toBe(true)
      expect(mockRelease).not.toHaveBeenCalled()
    })
  })
})
