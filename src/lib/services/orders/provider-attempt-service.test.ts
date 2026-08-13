import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: { findUnique: vi.fn() },
    providerAttempt: { count: vi.fn(), create: vi.fn(), update: vi.fn() },
    provider: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  getAdapterForType: vi.fn(),
}))

vi.mock('@/lib/services/routing/provider-failover-engine', () => ({
  classifyRetry: vi.fn(() => 'NON_RETRYABLE'),
}))

vi.mock('@/lib/services/jobs/provider-finalizer', () => ({
  completeProviderOperation: vi.fn(),
  failProviderOperation: vi.fn(),
}))

vi.mock('@/lib/services/orders/order-state-machine', () => ({
  createTimelineEvent: vi.fn(),
}))

const { prisma } = await import('@/lib/prisma')
const { getAdapterForType } = await import('@/lib/providers/adapter-manager')
const { completeProviderOperation } = await import('@/lib/services/jobs/provider-finalizer')
const { executeProviderAttempt } = await import('./provider-attempt-service')

const mockPrisma = vi.mocked(prisma)
const mockGetAdapter = vi.mocked(getAdapterForType)
const mockComplete = vi.mocked(completeProviderOperation)

const ORDER_ID = 'order-1'
const PROVIDER_ID = 'p-1'

function baseInput() {
  return {
    orderId: ORDER_ID,
    businessId: 'b1',
    providerId: PROVIDER_ID,
    providerName: 'AirHub',
    planId: 'plan-1',
    quantity: 1,
    subscriber: { email: 'u@example.com' },
    totalAmount: 5,
    displayName: 'Test',
    packageId: 'pkg-1',
    packageSnapshot: {},
    pkg: { id: 'pkg-1', dataGB: 5, validityDays: 30, currency: 'USD' },
  }
}

function mockOrder(overrides: any = {}) {
  return {
    id: ORDER_ID, status: 'CREATED', userId: 'u1', businessId: 'b1',
    esims: [], packageSnapshot: {}, packageName: 'Test', packageDataGB: 5, packageValidityDays: 30,
    ...overrides,
  }
}

describe('executeProviderAttempt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockPrisma.providerAttempt.create.mockResolvedValue({ id: 'attempt-1' })
    mockPrisma.providerAttempt.update.mockResolvedValue({})
    mockPrisma.provider.findUnique.mockResolvedValue({ id: PROVIDER_ID, name: 'AirHub', type: 'AIRHUB', status: 'ACTIVE', apiBaseUrl: '', apiToken: '', environment: 'test', authUrl: '' })
  })

  it('forwards normalized install data from the connector result to the finalizer', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockGetAdapter.mockResolvedValue({
      validatePurchase: undefined,
      activateESIM: vi.fn().mockResolvedValue({
        success: true,
        data: {
          activationId: 'act-1',
          iccids: ['89012345678901234567'],
          activationCodes: ['LPA:1$smdp.example.com$mid'],
          qrCodeUrl: 'https://qr.example/q.png',
          smdpAddress: 'smdp.example.com',
          matchingId: 'mid-1',
          status: 'ACTIVE',
          rawMetadata: { orderId: 'act-1' },
        },
      }),
    } as any)

    const result = await executeProviderAttempt(baseInput())

    expect(result.success).toBe(true)
    expect(result.status).toBe('SUCCEEDED')
    expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({
      orderId: ORDER_ID,
      providerRef: 'act-1',
      iccids: ['89012345678901234567'],
      activationCode: 'LPA:1$smdp.example.com$mid',
      qrCodeUrl: 'https://qr.example/q.png',
      smdpAddress: 'smdp.example.com',
      matchingId: 'mid-1',
      rawMetadata: { orderId: 'act-1' },
    }))
  })

  it('falls back to singular activationCode/qrCodeUrls when arrays are absent', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockGetAdapter.mockResolvedValue({
      validatePurchase: undefined,
      activateESIM: vi.fn().mockResolvedValue({
        success: true,
        data: {
          activationId: 'act-2',
          iccids: ['89012345678901234567'],
          activationCode: 'LPA:1$smdp2.example.com$mid2',
          qrCodeUrls: ['https://qr.example/q2.png'],
          smdpAddress: 'smdp2.example.com',
          matchingId: 'mid-2',
          status: 'ACTIVE',
        },
      }),
    } as any)

    await executeProviderAttempt(baseInput())

    expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({
      activationCode: 'LPA:1$smdp2.example.com$mid2',
      qrCodeUrl: 'https://qr.example/q2.png',
      smdpAddress: 'smdp2.example.com',
      matchingId: 'mid-2',
    }))
  })

  it('omits install fields entirely when the connector returns none', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockGetAdapter.mockResolvedValue({
      validatePurchase: undefined,
      activateESIM: vi.fn().mockResolvedValue({
        success: true,
        data: { activationId: 'act-3', iccids: ['89012345678901234567'], status: 'ACTIVE' },
      }),
    } as any)

    await executeProviderAttempt(baseInput())

    const callArgs = mockComplete.mock.calls[0][0] as any
    expect(callArgs.activationCode).toBeUndefined()
    expect(callArgs.qrCodeUrl).toBeUndefined()
    expect(callArgs.smdpAddress).toBeUndefined()
    expect(callArgs.matchingId).toBeUndefined()
  })
})
