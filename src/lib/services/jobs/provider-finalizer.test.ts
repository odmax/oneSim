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

const { prisma } = await import('@/lib/prisma')
const { captureReservedFunds, releaseReservedFunds } = await import('@/lib/services/orders/wallet-actions')
const { failOrder, createTimelineEvent } = await import('@/lib/services/orders/order-state-machine')
const { completeProviderOperation, failProviderOperation } = await import('./provider-finalizer')

const mockPrisma = vi.mocked(prisma)
const mockCapture = vi.mocked(captureReservedFunds)
const mockRelease = vi.mocked(releaseReservedFunds)
const mockFailOrder = vi.mocked(failOrder)
const mockCreateTimeline = vi.mocked(createTimelineEvent)

const ORDER_ID = 'order-1'
const PROVIDER_REF = 'act-1'

describe('provider-finalizer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.auditLog.create.mockResolvedValue({} as any)
  })

  describe('completeProviderOperation', () => {
    it('provisions NEW eSIMs (CREATE branch) when the order has none reserved', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: ORDER_ID, businessId: 'b1', userId: 'u1', status: 'CREATED', totalAmount: { toString: () => '5' }, packageId: 'pkg-1', packageSnapshot: {}, packageName: 'Test', packageDataGB: 1, packageValidityDays: 7, esims: [] } as any)
      mockPrisma.eSIMPackage.findUnique.mockResolvedValue({ validityDays: 7 } as any)
      mockPrisma.eSIM.create.mockResolvedValue({ id: 'esim-1' } as any)
      mockCapture.mockResolvedValue({ success: true } as any)
      mockCreateTimeline.mockResolvedValue(undefined as any)

      const result = await completeProviderOperation({ orderId: ORDER_ID, businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, providerName: 'iBASIS', totalAmount: 5, iccids: ['89012345678901234567'] })

      expect(result.success).toBe(true)
      expect(mockPrisma.eSIM.create).toHaveBeenCalledTimes(1)
      expect(mockPrisma.eSIM.create.mock.calls[0][0].data).toMatchObject({ purchaseId: ORDER_ID, iccid: '89012345678901234567', status: 'ACTIVE', providerStatus: 'ACTIVE', providerActivationId: PROVIDER_REF })
      expect(mockCapture).toHaveBeenCalledWith(ORDER_ID, 'b1', 5)
      expect(mockPrisma.eSIMPurchase.update).toHaveBeenCalledWith({ where: { id: ORDER_ID }, data: { status: 'FULFILLED', providerFulfillId: PROVIDER_REF, providerStatus: 'ACTIVE' } })
    })

    it('flips reserved eSIMs to ACTIVE (UPDATE branch) when ICCIDs already exist for the order', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: ORDER_ID, businessId: 'b1', userId: 'u1', status: 'CREATED', totalAmount: { toString: () => '5' }, packageId: 'pkg-1', packageSnapshot: {}, packageName: 'Test', packageDataGB: 1, packageValidityDays: 7, esims: [{ id: 'esim-1', iccid: '89012345678901234567', purchaseId: ORDER_ID }] } as any)
      mockPrisma.eSIM.findFirst.mockResolvedValue({ id: 'esim-1', iccid: '89012345678901234567' } as any)
      mockPrisma.eSIM.update.mockResolvedValue({ id: 'esim-1' } as any)
      mockCapture.mockResolvedValue({ success: true } as any)
      mockCreateTimeline.mockResolvedValue(undefined as any)

      const result = await completeProviderOperation({ orderId: ORDER_ID, businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, providerName: 'iBASIS', totalAmount: 5, iccids: ['89012345678901234567'] })

      expect(result.success).toBe(true)
      expect(mockPrisma.eSIM.update).toHaveBeenCalledTimes(1)
      expect(mockPrisma.eSIM.update.mock.calls[0][0].data).toMatchObject({ status: 'ACTIVE', providerStatus: 'ACTIVE', providerActivationId: PROVIDER_REF })
      expect(mockPrisma.eSIM.create).not.toHaveBeenCalled()
    })

    it('falls back to CREATE for a reserved order iccid that was not found locally', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: ORDER_ID, businessId: 'b1', userId: 'u1', status: 'CREATED', totalAmount: { toString: () => '5' }, packageId: 'pkg-1', packageSnapshot: {}, packageName: 'Test', packageDataGB: 1, packageValidityDays: 7, esims: [{ id: 'esim-1', iccid: '89012345678901234567', purchaseId: ORDER_ID }] } as any)
      mockPrisma.eSIM.findFirst.mockResolvedValue(null as any)
      mockPrisma.eSIMPackage.findUnique.mockResolvedValue({ validityDays: 7 } as any)
      mockPrisma.eSIM.create.mockResolvedValue({ id: 'esim-2' } as any)
      mockCapture.mockResolvedValue({ success: true } as any)
      mockCreateTimeline.mockResolvedValue(undefined as any)

      const result = await completeProviderOperation({ orderId: ORDER_ID, businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, providerName: 'iBASIS', totalAmount: 5, iccids: ['89012345678901234568'] })

      expect(result.success).toBe(true)
      expect(mockPrisma.eSIM.create).toHaveBeenCalledTimes(1)
      expect(mockPrisma.eSIM.create.mock.calls[0][0].data.iccid).toBe('89012345678901234568')
    })

    it('short-circuits (no wallet capture, no provisioning) when order is already FULFILLED', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: ORDER_ID, businessId: 'b1', userId: 'u1', status: 'FULFILLED', totalAmount: { toString: () => '5' }, esims: [] } as any)

      const result = await completeProviderOperation({ orderId: ORDER_ID, businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, providerName: 'iBASIS', totalAmount: 5, iccids: ['89012345678901234567'] })

      expect(result.success).toBe(true)
      expect(result.alreadyDone).toBe(true)
      expect(mockCapture).not.toHaveBeenCalled()
      expect(mockPrisma.eSIM.create).not.toHaveBeenCalled()
    })

    it('returns an error when the order is not found', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(null as any)
      const result = await completeProviderOperation({ orderId: 'missing', businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, providerName: 'iBASIS', totalAmount: 5, iccids: ['89012345678901234567'] })
      expect(result.success).toBe(false)
      expect(mockCapture).not.toHaveBeenCalled()
    })
  })

  describe('failProviderOperation', () => {
    it('releases wallet funds and fails the order', async () => {
      mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: ORDER_ID, businessId: 'b1', userId: 'u1', status: 'CREATED', totalAmount: { toString: () => '5' } } as any)
      mockRelease.mockResolvedValue({ success: true } as any)
      mockFailOrder.mockResolvedValue(undefined as any)

      const result = await failProviderOperation({ orderId: ORDER_ID, businessId: 'b1', providerId: 'p-1', providerRef: PROVIDER_REF, totalAmount: 5, reason: 'ACTIVATION_FAILED' })

      expect(result.success).toBe(true)
      expect(mockRelease).toHaveBeenCalledWith(ORDER_ID, 'b1', 5)
      expect(mockFailOrder).toHaveBeenCalledWith(ORDER_ID, 'ACTIVATION_FAILED')
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
