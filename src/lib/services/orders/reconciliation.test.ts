import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: { findUnique: vi.fn(), update: vi.fn() },
    providerAttempt: { count: vi.fn(), create: vi.fn(), findMany: vi.fn(), aggregate: vi.fn().mockResolvedValue({ _max: { attemptNumber: null } }) },
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
}))

vi.mock('@/lib/services/orders/wallet-actions', () => ({
  reserveWalletFunds: vi.fn(),
  captureReservedFunds: vi.fn(),
  captureReservedFundsUpTo: vi.fn(),
  releaseReservedFunds: vi.fn(),
  releaseReservedFundsUpTo: vi.fn(),
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
const { releaseReservedFundsUpTo } = await import('@/lib/services/orders/wallet-actions')
const { completeProviderFinalization } = await import('@/lib/services/orders/fulfillment')
const { resolveAuthoritativeProviderReference, hasProviderAcceptanceEvidence } = await import('./provider-reference')

const mockPrisma = vi.mocked(prisma)
const mockAdapter = vi.mocked(getAdapterForType)
const mockRelease = vi.mocked(releaseReservedFundsUpTo)
const mockTransition = vi.mocked(transitionOrder)
const mockFinal = vi.mocked(completeProviderFinalization)

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

function attempt(overrides: any = {}) {
  return {
    providerId: 'prov-1', providerReference: '12811381', attemptNumber: 1, startedAt: new Date('2026-08-01T00:00:00Z'),
    status: 'PROCESSING', source: 'PURCHASE', retryClassification: null, ...overrides,
  }
}

function setupAirHubShape(attempts: any[] = [attempt()]) {
  mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(
    mockOrder({ providerFulfillId: null, providerReservationId: null, provider: { id: 'prov-1', type: 'CUSTOM', apiBaseUrl: 'https://api.airhubapp.com', apiToken: 'tok', environment: 'staging', authUrl: null } }),
  )
  mockPrisma.providerAttempt.findMany.mockResolvedValue(attempts)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.providerAttempt.count.mockResolvedValue(0)
  mockPrisma.providerAttempt.findMany.mockResolvedValue([])
  mockAdapter.mockResolvedValue({ getActivationStatus: vi.fn().mockResolvedValue({ success: false }) } as any)
  mockFinal.mockResolvedValue({ success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true } as any)
})

describe('authoritative provider reference selection', () => {
  it('A. providerFulfillId takes precedence over reservation and attempts', () => {
    const ref = resolveAuthoritativeProviderReference(
      { id: 'o', providerId: 'prov-1', providerFulfillId: 'fulfill-9', providerReservationId: 'res-1' },
      [attempt({ attemptNumber: 9 })],
    )
    expect(ref).toBe('fulfill-9')
  })

  it('B. providerReservationId falls back when no fulfillment id', () => {
    const ref = resolveAuthoritativeProviderReference(
      { id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: 'res-1' },
      [],
    )
    expect(ref).toBe('res-1')
  })

  it('C. ProviderAttempt.providerReference is recovered when order-level evidence is absent', () => {
    const ref = resolveAuthoritativeProviderReference(
      { id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null },
      [attempt({ attemptNumber: 2 })],
    )
    expect(ref).toBe('12811381')
  })

  it('D. an attempt reference belonging to another provider is rejected', () => {
    const ref = resolveAuthoritativeProviderReference(
      { id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null },
      [
        attempt({ attemptNumber: 9, providerId: 'prov-OTHER', providerReference: 'other-ref' }),
        attempt({ attemptNumber: 1, providerReference: 'mine' }),
      ],
    )
    expect(ref).toBe('mine')
  })

  it('E. multiple matching attempts select deterministically (highest attemptNumber, then latest startedAt)', () => {
    const ref = resolveAuthoritativeProviderReference(
      { id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null },
      [
        attempt({ attemptNumber: 1, providerReference: 'old', startedAt: new Date('2026-01-01T00:00:00Z') }),
        attempt({ attemptNumber: 3, providerReference: 'new', startedAt: new Date('2026-06-01T00:00:00Z') }),
        attempt({ attemptNumber: 3, providerReference: 'newer', startedAt: new Date('2026-07-01T00:00:00Z') }),
      ],
    )
    expect(ref).toBe('newer')
  })

  it('F. known staging legacy shape resolves "12811381"', async () => {
    setupAirHubShape([attempt({ providerId: 'prov-1', status: 'PROCESSING', providerReference: '12811381' })])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PROCESSING' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('STILL_PENDING')
    // The authoritative attempt reference is used for the provider lookup and
    // persisted on the reconciliation attempt — no local order id.
    const adapter: any = await mockAdapter.mock.results[0].value
    expect(adapter.getActivationStatus).toHaveBeenCalledWith('12811381')
    const created = mockPrisma.providerAttempt.create.mock.calls[0][0].data
    expect(created.providerReference).toBe('12811381')
  })
})

describe('reconcileProviderOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockAdapter.mockResolvedValue({ getActivationStatus: vi.fn().mockResolvedValue({ success: false }) } as any)
  })

  it('1. timeout → reconciliation starts', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockAdapter.mockResolvedValue({ getActivationStatus: vi.fn().mockResolvedValue({ success: false }) } as any)

    const result = await reconcileProviderOrder('order-1')
    expect(createTimelineEvent).toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'PROVIDER_RECONCILIATION_STARTED' }))
  })

  it('L. ACTIVE + ICCID/install evidence finalizes through completeProviderFinalization', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', iccids: ['89012345678901234567'], activationCode: 'LPA:1$smdp$code' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')
    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(mockFinal).toHaveBeenCalledWith(expect.objectContaining({
      providerResult: expect.objectContaining({ iccids: ['89012345678901234567'], activationCode: 'LPA:1$smdp$code' }),
    }))
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('M. ACTIVE without ICCID/fulfillment evidence does NOT mark FULFILLED', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')
    expect(result.outcome).toBe('STILL_PENDING')
    expect(result.status).toBe('PROVIDER_RECONCILIATION')
    expect(mockFinal).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('J/K: live AirHub shape (ACTIVE + simID normalized + activationCode) finalizes exactly once via completeProviderFinalization, wallet never released, no redispatch', async () => {
    // Live GetActivationCode normalization → StatusResult { status:'ACTIVE', iccids:[simID], activationCode, isActive:false }
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    const adapter = {
      getActivationStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'ACTIVE', iccids: ['89012345678901234567'], activationCode: 'LPA:1$smdp.example.com$CODE', isActive: false },
      }),
      // NOT a purchase connector: reconcileProviderOrder must never dispatch a purchase.
    }
    mockAdapter.mockResolvedValue(adapter as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(mockFinal).toHaveBeenCalledTimes(1)
    expect(mockFinal).toHaveBeenCalledWith(expect.objectContaining({
      providerRef: 'ref-1',
      providerResult: expect.objectContaining({ iccids: ['89012345678901234567'], activationCode: 'LPA:1$smdp.example.com$CODE' }),
    }))
    expect(mockRelease).not.toHaveBeenCalled()
    // No purchase dispatch: adapter has no activateESIM, and none was reached.
    expect((adapter as any).activateESIM).toBeUndefined()
    const created = mockPrisma.providerAttempt.create.mock.calls[0][0].data
    expect(created.source).toBe('RECONCILIATION')
    expect(created.status).toBe('SUCCEEDED')
  })

  it('7. FOUND_SUCCESS with activationCode but ZERO ICCIDs → KEEP_WAITING, finalizer NOT called, wallet held, no redispatch', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'ACTIVE', activationCode: 'LPA:1$smdp.example.com$CODE-ONLY' },
      }),
    } as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('STILL_PENDING')
    expect(result.action).toBe('KEEP_WAITING')
    expect(result.status).toBe('PROVIDER_RECONCILIATION')
    expect(mockFinal).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
    expect(mockTransition).toHaveBeenCalledWith('order-1', 'PROVIDER_RECONCILIATION')
    const created = mockPrisma.providerAttempt.create.mock.calls[0][0].data
    // The reconciliation LOOKUP succeeded (provider returned ACTIVE+activationCode);
    // the ORDER still stays in PROVIDER_RECONCILIATION because finalization is
    // ICCID-gated — no eSIM is created and no attempt implies completion.
    expect(created.status).toBe('SUCCEEDED')
  })

  it('9. ICCID-only fulfillment (activationCode absent) finalizes canonically exactly once', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', iccids: ['89012345678901234567'] } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(mockFinal).toHaveBeenCalledTimes(1)
    expect(mockFinal).toHaveBeenCalledWith(expect.objectContaining({
      providerResult: expect.objectContaining({ iccids: ['89012345678901234567'] }),
    }))
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('10. provider acceptance evidence + activationCode-only response keeps redispatch blocked even after reconciliation exhaustion', async () => {
    setupAirHubShape([attempt({ attemptNumber: 1, status: 'PROCESSING', providerReference: '12811381' })])
    mockPrisma.providerAttempt.count.mockResolvedValue(7) // exhaustion threshold reached
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', activationCode: 'LPA:1$smdp.example.com$CODE' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('STILL_PENDING')
    expect(result.action).toBe('KEEP_WAITING')
    expect(createTimelineEvent).toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'REDISPATCH_BLOCKED' }))
    expect(mockRelease).not.toHaveBeenCalled()
    expect(createTimelineEvent).not.toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'REDISPATCH_ALLOWED' }))
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

  it('I. PROCESSING keeps the wallet held', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerAttempt.findMany.mockResolvedValue([attempt({ status: 'PROCESSING' })])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PROCESSING' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')
    expect(result.outcome).toBe('STILL_PENDING')
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

  it('8. duplicate reconciliation is idempotent (FULFILLED early return)', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder({ status: 'FULFILLED' }))
    const result = await reconcileProviderOrder('order-1')
    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(result.message).toContain('Already fulfilled')
  })

  it('N. duplicate reconciliation/finalization is idempotent end-to-end', async () => {
    let current: any = mockOrder()
    mockPrisma.eSIMPurchase.findUnique.mockImplementation(async () => ({ ...current }))
    mockPrisma.providerAttempt.create.mockImplementation(async () => {
      // finalization flips the order to FULFILLED
      current = { ...current, status: 'FULFILLED' }
      return {}
    })
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', iccids: ['89012345678901234567'] } }),
    } as any)

    const first = await reconcileProviderOrder('order-1')
    const second = await reconcileProviderOrder('order-1')

    expect(first.outcome).toBe('FOUND_SUCCESS')
    expect(second.outcome).toBe('FOUND_SUCCESS')
    expect(second.message).toContain('Already fulfilled')
    expect(mockFinal).toHaveBeenCalledTimes(1)
  })
})

describe('reconciliation redispatch safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.providerAttempt.count.mockResolvedValue(7) // attemptNum = 8 (exhausted)
    mockRelease.mockResolvedValue({ success: true })
    mockTransition.mockResolvedValue({ success: true })
  })

  it('G. existing provider reference + exhaustion does NOT authorize redispatch (wallet held)', async () => {
    setupAirHubShape([attempt({ providerId: 'prov-1', status: 'PROCESSING', providerReference: '12811381' })])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: false, error: { code: 'NOT_FOUND', message: 'order not found' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('STILL_PENDING')
    expect(result.action).toBe('KEEP_WAITING')
    expect(isRedispatchAllowed(8)).toBe(true) // attempt threshold reached…
    // …but evidence blocks it:
    expect(createTimelineEvent).toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'REDISPATCH_BLOCKED' }))
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('K. NOT_FOUND with acceptance evidence does not release wallet nor redispatch', async () => {
    setupAirHubShape([attempt()])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: false, error: { code: 'NOT_FOUND', message: 'no such order' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')
    expect(result.outcome).toBe('STILL_PENDING')
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('J. transient status error keeps reconciliation (wallet held)', async () => {
    setupAirHubShape([attempt()])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: false, error: { code: 'TIMEOUT', message: 'timed out' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')
    expect(result.outcome).toBe('STILL_PENDING')
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('H. no provider evidence: reconciliation itself never invents a redispatch — nothing to poll stays STILL_PENDING (controlled redispatch lives in the recovery classifier)', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(
      mockOrder({ providerFulfillId: null, providerReservationId: null, provider: { id: 'prov-1', type: 'CHOICE', apiBaseUrl: 'https://api.test', apiToken: 'tok', environment: 'staging', authUrl: null } }),
    )
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: false, error: { code: 'NOT_FOUND', message: 'never dispatched' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')
    // Nothing was ever queried and nothing can be polled → stay reconciling.
    expect(result.outcome).toBe('STILL_PENDING')
    expect(result.action).toBe('KEEP_WAITING')
    // No redispatch is authorized from within reconciliation without evidence of a
    // genuine provider not-found for a polled identifier.
    expect(createTimelineEvent).not.toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'REDISPATCH_ALLOWED' }))
  })
})

describe('provider attempt numbering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockAdapter.mockResolvedValue({ getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PROCESSING' } }) } as any)
  })

  it('a PURCHASE attempt numbered 1 is never duplicated: the first RECONCILIATION attempt becomes 2', async () => {
    // Live-shape: order has a PURCHASE attempt (attemptNumber 1, status PROCESSING, ref preserved).
    setupAirHubShape([attempt({ attemptNumber: 1, status: 'PROCESSING', providerReference: '12811381' })])
    mockPrisma.providerAttempt.aggregate.mockResolvedValue({ _max: { attemptNumber: 1 } })

    await reconcileProviderOrder('order-1')

    const created = mockPrisma.providerAttempt.create.mock.calls[0][0].data
    expect(created.source).toBe('RECONCILIATION')
    expect(created.attemptNumber).toBe(2)
    expect(created.providerReference).toBe('12811381')
  })

  it('repeated reconciliation continues monotonically (3, 4, …)', async () => {
    setupAirHubShape([])
    mockPrisma.providerAttempt.aggregate
      .mockResolvedValueOnce({ _max: { attemptNumber: 1 } })
      .mockResolvedValueOnce({ _max: { attemptNumber: 2 } })
      .mockResolvedValueOnce({ _max: { attemptNumber: 3 } })

    await reconcileProviderOrder('order-1')
    await reconcileProviderOrder('order-1')
    await reconcileProviderOrder('order-1')

    const numbers = mockPrisma.providerAttempt.create.mock.calls.map((c) => c[0].data.attemptNumber)
    expect(numbers).toEqual([2, 3, 4])
  })

  it('reconciliation attempt creation NEVER triggers a provider purchase (no activateESIM dispatch)', async () => {
    setupAirHubShape([attempt({ attemptNumber: 1, status: 'PROCESSING', providerReference: '12811381' })])
    mockPrisma.providerAttempt.aggregate.mockResolvedValue({ _max: { attemptNumber: 1 } })
    const activate = vi.fn()
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PROCESSING' } }),
      activateESIM: activate,
    } as any)

    await reconcileProviderOrder('order-1')

    expect(activate).not.toHaveBeenCalled()
    expect(mockPrisma.providerAttempt.create.mock.calls[0][0].data.status).toBe('PROCESSING')
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

describe('provider acceptance evidence', () => {
  it('is true when order-level or matching attempt reference evidence exists', () => {
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [{ providerId: 'prov-1', providerReference: '12811381' }])).toBe(true)
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: 'x', providerReservationId: null }, [])).toBe(true)
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [{ providerId: 'prov-OTHER', providerReference: 'other' }])).toBe(false)
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [])).toBe(false)
  })
})