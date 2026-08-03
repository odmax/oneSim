import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: { findUnique: vi.fn(), update: vi.fn() },
    providerAttempt: { count: vi.fn(), create: vi.fn() },
    provider: { findUnique: vi.fn() },
    walletTransaction: { findFirst: vi.fn() },
    eSIM: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    eSIMPackage: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  isProviderOperational: vi.fn().mockReturnValue(true),
  getAdapterForType: vi.fn(),
}))

vi.mock('@/lib/services/orders/order-state-machine', () => ({
  createTimelineEvent: vi.fn(),
  transitionOrder: vi.fn().mockResolvedValue({ success: true }),
  failOrder: vi.fn(),
  ORDER_LABELS: { PROVIDER_RECONCILIATION: 'Provider Reconciliation' },
}))

vi.mock('@/lib/services/orders/wallet-actions', () => ({
  reserveWalletFunds: vi.fn(),
  captureReservedFunds: vi.fn(),
  releaseReservedFunds: vi.fn(),
  refundCapturedFunds: vi.fn(),
}))

vi.mock('@/lib/services/orders/fulfillment', () => ({
  completeProviderFinalization: vi.fn(),
  resumeProviderFinalization: vi.fn(),
}))

const { prisma } = await import('@/lib/prisma')
const { getAdapterForType } = await import('@/lib/providers/adapter-manager')
const { createTimelineEvent, transitionOrder, failOrder } = await import('@/lib/services/orders/order-state-machine')
const { reconcileProviderOrder, getReconciliationDelay, isRedispatchAllowed } = await import('./reconciliation')
const { releaseReservedFunds } = await import('@/lib/services/orders/wallet-actions')

const mockPrisma = vi.mocked(prisma)
const mockAdapter = vi.mocked(getAdapterForType)
const mockRelease = vi.mocked(releaseReservedFunds)
const mockTransition = vi.mocked(transitionOrder)

function mockOrder(overrides: any = {}) {
  return {
    id: 'order-1', businessId: 'biz-1', userId: 'user-1',
    status: 'PROVIDER_RECONCILIATION', totalAmount: { toString: () => '10' },
    providerId: 'prov-1', providerFulfillId: 'ref-1', providerReservationId: null,
    provider: { id: 'prov-1', type: 'CHOICE', apiBaseUrl: 'https://api.test', apiToken: 'tok', environment: 'staging', authUrl: null, ...overrides.provider },
    esims: [],
    business: { id: 'biz-1' },
    ...overrides,
  }
}

describe('reconcileProviderOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockAdapter.mockResolvedValue({ getActivationStatus: vi.fn().mockResolvedValue({ success: false }) } as any)
  })

  it('1. timeout → reconciliation starts', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockAdapter.mockResolvedValue({ getActivationStatus: vi.fn().mockResolvedValue({ success: false }) } as any)

    const result = await reconcileProviderOrder('order-1')
    expect(createTimelineEvent).toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'PROVIDER_RECONCILIATION_STARTED' }))
  })

  it('2. FOUND_SUCCESS outcome — provider later confirms success', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')
    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(createTimelineEvent).toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'PROVIDER_RECONCILIATION_SUCCESS' }))
  })

  it('3. FOUND_FAILURE outcome — provider confirms failure', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'CANCELLED' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')
    expect(result.outcome).toBe('FOUND_FAILURE')
    expect(mockRelease).toHaveBeenCalled()
  })

  it('4. STILL_PENDING outcome — provider still processing', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PROCESSING' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')
    expect(result.outcome).toBe('STILL_PENDING')
    expect(createTimelineEvent).toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'PROVIDER_RECONCILIATION_TIMEOUT' }))
  })

  it('5. redispatch allowed after max reconciliation attempts (attempt >= 7)', () => {
    expect(isRedispatchAllowed(7)).toBe(true)
    expect(isRedispatchAllowed(8)).toBe(true)
    expect(isRedispatchAllowed(6)).toBe(false)
  })

  it('6. wallet not released during reconciliation', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PROCESSING' } }),
    } as any)

    await reconcileProviderOrder('order-1')
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('7. wallet released after confirmed failure', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'FAILED' } }),
    } as any)

    await reconcileProviderOrder('order-1')
    expect(mockRelease).toHaveBeenCalledWith('order-1', 'biz-1', 10)
  })

  it('8. duplicate reconciliation is idempotent', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder({ status: 'FULFILLED' }))

    const result = await reconcileProviderOrder('order-1')
    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(result.message).toContain('Already fulfilled')
  })
})

describe('reconciliation retry delays', () => {
  it('9. attempt 1 → 1 minute', () => { expect(getReconciliationDelay(1)).toBe(60_000) })
  it('10. attempt 2 → 5 minutes', () => { expect(getReconciliationDelay(2)).toBe(300_000) })
  it('11. attempt 7 → 24 hours', () => { expect(getReconciliationDelay(7)).toBe(86_400_000) })
  it('12. attempt 8 → redispatch allowed', () => { expect(isRedispatchAllowed(8)).toBe(true) })
})

describe('timeline events', () => {
  it('13. PROVIDER_RECONCILIATION_STARTED on first attempt', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockAdapter.mockResolvedValue({ getActivationStatus: vi.fn().mockResolvedValue({ success: false }) } as any)

    await reconcileProviderOrder('order-1')
    expect(createTimelineEvent).toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'PROVIDER_RECONCILIATION_STARTED' }))
  })

  it('14. PROVIDER_RECONCILIATION_RETRY on subsequent attempts', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.count.mockResolvedValue(1)
    mockAdapter.mockResolvedValue({ getActivationStatus: vi.fn().mockResolvedValue({ success: false }) } as any)

    await reconcileProviderOrder('order-1')
    expect(createTimelineEvent).toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'PROVIDER_RECONCILIATION_RETRY' }))
  })
})
