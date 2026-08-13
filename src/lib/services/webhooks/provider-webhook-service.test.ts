import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn(), update: vi.fn() },
    eSIMPurchase: { findFirst: vi.fn(), findUnique: vi.fn() },
    eSIM: { findFirst: vi.fn() },
    backgroundJob: { updateMany: vi.fn() },
  },
}))

vi.mock('@/lib/services/jobs/provider-finalizer', () => ({
  completeProviderOperation: vi.fn(),
  failProviderOperation: vi.fn(),
}))

const { prisma } = await import('@/lib/prisma')
const { completeProviderOperation } = await import('@/lib/services/jobs/provider-finalizer')
const { processProviderWebhook } = await import('./provider-webhook-service')

const mockPrisma = vi.mocked(prisma)
const mockComplete = vi.mocked(completeProviderOperation)

function mockOrder() {
  return {
    id: 'order-1', businessId: 'biz-1', providerId: 'p-1', providerName: 'AirHub',
    providerReservationId: 'res-1', providerFulfillId: null, status: 'PENDING_PROVIDER',
    userId: 'user-1', totalAmount: 10, packageSnapshot: {}, packageName: 'Test',
    packageDataGB: 5, packageValidityDays: 30,
  }
}

describe('processProviderWebhook — install data forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // findDuplicateEvent: provider config has no webhookHistory
    mockPrisma.provider.findUnique.mockResolvedValue({ config: null } as any)
    mockPrisma.eSIMPurchase.findFirst.mockResolvedValue(mockOrder() as any)
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder() as any)
    mockPrisma.backgroundJob.updateMany.mockResolvedValue({ count: 0 } as any)
  })

  it('forwards event qrCode/activationCode into completeProviderOperation on COMPLETED', async () => {
    const result = await processProviderWebhook('p-1', {
      eventId: 'evt-1',
      eventType: 'ORDER_COMPLETED',
      status: 'COMPLETED',
      providerReference: 'res-1',
      iccids: ['89012345678901234567'],
      qrCode: 'data:image/png;base64,AAAA',
      activationCode: 'LPA:1$smdp.example.com$mid',
    })

    expect(result.status).toBe('COMPLETED')
    expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-1',
      iccids: ['89012345678901234567'],
      qrCode: 'data:image/png;base64,AAAA',
      activationCode: 'LPA:1$smdp.example.com$mid',
    }))
  })

  it('does not include install fields when the event omits them', async () => {
    await processProviderWebhook('p-1', {
      eventId: 'evt-2',
      eventType: 'ORDER_COMPLETED',
      status: 'COMPLETED',
      providerReference: 'res-1',
      iccids: ['89012345678901234567'],
    })

    const callArgs = mockComplete.mock.calls[0][0] as any
    expect(callArgs.qrCode).toBeUndefined()
    expect(callArgs.qrCodeUrl).toBeUndefined()
    expect(callArgs.activationCode).toBeUndefined()
  })

  it('never maps an empty qrCode string into a stored install field', async () => {
    await processProviderWebhook('p-1', {
      eventId: 'evt-3',
      eventType: 'ORDER_COMPLETED',
      status: 'COMPLETED',
      providerReference: 'res-1',
      iccids: ['89012345678901234567'],
      qrCode: '',
    })

    const callArgs = mockComplete.mock.calls[0][0] as any
    expect(callArgs.qrCode).toBeUndefined()
  })
})
