import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: { findUnique: vi.fn(), update: vi.fn() },
    providerAttempt: { count: vi.fn(), create: vi.fn(), findMany: vi.fn(), aggregate: vi.fn().mockResolvedValue({ _max: { attemptNumber: null } }) },
    provider: { findUnique: vi.fn() },
    walletTransaction: { findFirst: vi.fn() },
    eSIM: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]), count: vi.fn() },
    eSIMPackage: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  isProviderOperational: vi.fn().mockReturnValue(true),
  getAdapterForType: vi.fn(),
}))

vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  buildConnectorFromProvider: vi.fn(),
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
const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
const { createTimelineEvent, transitionOrder, failOrder } = await import('@/lib/services/orders/order-state-machine')
const { reconcileProviderOrder, getReconciliationDelay, isRedispatchAllowed, isReconciliationEligible, reconciliationCycleKey } = await import('./reconciliation')
const { releaseReservedFundsUpTo } = await import('@/lib/services/orders/wallet-actions')
const { completeProviderFinalization } = await import('@/lib/services/orders/fulfillment')
const { resolveAuthoritativeProviderReference, hasProviderAcceptanceEvidence, LEGACY_STARTED_CUTOVER_ENV, resolveLegacyStartedCutover } = await import('./provider-reference')

const mockPrisma = vi.mocked(prisma)
const mockAdapter = vi.mocked(getAdapterForType)
const mockBuildConnector = vi.mocked(buildConnectorFromProvider)
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

  it('9b. iBASIS completed + ICCID → FOUND_SUCCESS finalizes canonically (canonical path, no new purchase)', async () => {
    setupAirHubShape([attempt({ attemptNumber: 1, status: 'PROCESSING', providerReference: 'act-ibasis-1' })])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'COMPLETED', iccids: ['89012345678901234567'], providerSubscriptionId: 'sub-1' },
      }),
    } as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(mockFinal).toHaveBeenCalledTimes(1)
    expect(mockFinal).toHaveBeenCalledWith(expect.objectContaining({
      providerResult: expect.objectContaining({ iccids: ['89012345678901234567'] }),
    }))
    expect(mockRelease).not.toHaveBeenCalled()
    // No second provider purchase: the adapter exposes only getActivationStatus.
    expect((mockAdapter.mock.results[0].value as any).activateESIM).toBeUndefined()
  })

  it('9c. iBASIS completed WITHOUT ICCID → KEEP_WAITING, finalizer NOT called, wallet held', async () => {
    setupAirHubShape([attempt({ attemptNumber: 1, status: 'PROCESSING', providerReference: 'act-ibasis-2' })])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'COMPLETED', providerSubscriptionId: 'sub-2' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('STILL_PENDING')
    expect(result.action).toBe('KEEP_WAITING')
    expect(mockFinal).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
    expect(mockTransition).toHaveBeenCalledWith('order-1', 'PROVIDER_RECONCILIATION')
  })

  it('9d. iBASIS completed + activationCode only (no ICCID) → NOT fulfilled, wallet held', async () => {
    setupAirHubShape([attempt({ attemptNumber: 1, status: 'PROCESSING', providerReference: 'act-ibasis-3' })])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'COMPLETED', activationCode: 'FKE: 0$CUST-111$555' },
      }),
    } as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('STILL_PENDING')
    expect(result.action).toBe('KEEP_WAITING')
    expect(mockFinal).not.toHaveBeenCalled()
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
    expect(mockRelease).toHaveBeenCalledWith('order-1', 'biz-1', 10, { confirmedFailure: true })
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

  it('O. evidence + reconciliation exhaustion (attempt 8+) still schedules the next retry — polling continues read-only, no tight loop (delay caps at 24h)', async () => {
    // AirHub-shaped order with durable provider acceptance evidence.
    setupAirHubShape([attempt({ attemptNumber: 1, status: 'PROCESSING', providerReference: '12811381' })])
    mockPrisma.providerAttempt.count.mockResolvedValue(20) // far past the 7-attempt schedule
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PROCESSING' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('STILL_PENDING')
    expect(result.action).toBe('KEEP_WAITING')
    expect(result.status).toBe('PROVIDER_RECONCILIATION')
    expect(mockRelease).not.toHaveBeenCalled()
    // persistReconciliationRetry still runs for evidence-backed orders → nextRetryAt set with capped delay
    expect(mockPrisma.eSIMPurchase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ retryCount: 21, nextRetryAt: expect.any(Date) }),
    }))
    expect(createTimelineEvent).not.toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'REDISPATCH_ALLOWED' }))
  })

  it('P. evidence-less order at the final reconciliation attempt does NOT keep scheduling (controlled redispatch is the recovery classifier\u2019s job, never reconciliation)', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(
      mockOrder({ providerFulfillId: null, providerReservationId: null, provider: { id: 'prov-1', type: 'CHOICE', apiBaseUrl: 'https://api.test', apiToken: 'tok', environment: 'staging', authUrl: null } }),
    )
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockPrisma.providerAttempt.count.mockResolvedValue(7) // attemptNum = 8 → past schedule, no evidence
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PROCESSING' } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('STILL_PENDING')
    // No next-retry scheduling for an evidence-less exhausted order.
    expect(mockPrisma.eSIMPurchase.update).not.toHaveBeenCalled()
  })

  it('Q. eventual ICCID recovery finalizes exactly once after many earlier no-ICCID polls', async () => {
    setupAirHubShape([attempt({ attemptNumber: 1, status: 'PROCESSING', providerReference: '12811381' })])
    mockPrisma.providerAttempt.count.mockResolvedValue(5)
    // Provider finally returns an ICCID on this poll.
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', iccids: ['89012345678901234567'] } }),
    } as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(mockFinal).toHaveBeenCalledTimes(1)
    expect(mockRelease).not.toHaveBeenCalled()
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

  it('K. transient PROVIDER_UNAVAILABLE (200-empty after read retries) keeps reconciliation, wallet held, no redispatch', async () => {
    setupAirHubShape([attempt()])
    mockPrisma.providerAttempt.count.mockResolvedValue(7)
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({
        success: false,
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'AirHub read endpoint returned an empty/non-JSON response after 2 attempts' },
      }),
    } as any)

    const result = await reconcileProviderOrder('order-1')

    expect(result.outcome).toBe('STILL_PENDING')
    expect(result.action).toBe('KEEP_WAITING')
    expect(result.status).toBe('PROVIDER_RECONCILIATION')
    expect(mockRelease).not.toHaveBeenCalled()
    expect(createTimelineEvent).not.toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'REDISPATCH_ALLOWED' }))
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
  const originalCutover = process.env[LEGACY_STARTED_CUTOVER_ENV]
  beforeEach(() => {
    process.env[LEGACY_STARTED_CUTOVER_ENV] = '2026-09-08T00:00:00Z'
  })
  afterEach(() => {
    if (originalCutover === undefined) delete process.env[LEGACY_STARTED_CUTOVER_ENV]
    else process.env[LEGACY_STARTED_CUTOVER_ENV] = originalCutover
  })

  it('is true when order-level or matching attempt reference evidence exists', () => {
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [{ providerId: 'prov-1', providerReference: '12811381' }])).toBe(true)
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: 'x', providerReservationId: null }, [])).toBe(true)
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [{ providerId: 'prov-OTHER', providerReference: 'other' }])).toBe(false)
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [])).toBe(false)
  })

  it('is true for an owning-provider AMBIGUOUS attempt with NO provider reference (redispatch-blocked)', () => {
    // Regression: AirHub NO_ICCIDS / Telna timeout attempts carry no providerReference,
    // but the provider may have committed — the attempt itself is acceptance evidence.
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [
      { providerId: 'prov-1', providerReference: null, status: 'AMBIGUOUS', source: 'PURCHASE' },
    ])).toBe(true)
  })

  it('is true for an owning-provider PROCESSING attempt and STARTED-with-dispatchStartedAt (in-flight purchase)', () => {
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [
      { providerId: 'prov-1', providerReference: null, status: 'PROCESSING', source: 'PURCHASE' },
    ])).toBe(true)
    // STARTED with dispatchStartedAt set — the mutation boundary may have been
    // crossed (http may have left OneSIM) → acceptance evidence.
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [
      { providerId: 'prov-1', providerReference: null, status: 'STARTED', source: 'PURCHASE', dispatchStartedAt: new Date('2026-09-08T00:00:00Z') },
    ])).toBe(true)
  })

  it('is FALSE for an owning-provider STARTED attempt whose dispatchStartedAt is NULL (provably pre-dispatch → redispatch safe)', () => {
    // V2 regression: a bare STARTED row with no dispatch marker never crossed the
    // provider mutation boundary — absence of providerReference is NOT evidence
    // of a possible purchase. Recovery may resume/redispatch (new attempt).
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [
      { providerId: 'prov-1', providerReference: null, status: 'STARTED', source: 'PURCHASE', dispatchStartedAt: null },
    ])).toBe(false)
  })

  it('is TRUE for a LEGACY STARTED attempt with NULL dispatchStartedAt created before the marker-code cutover (may have crossed the boundary under old code)', () => {
    // V2 legacy regression: rows written BEFORE the marker-first code deployed
    // never had a dispatchStartedAt column — a bare STARTED row may have crossed
    // the provider HTTP boundary before the process died. It must stay AMBIGUOUS
    // (reconciliation), NEVER be treated as provably pre-dispatch.
    const legacyCutover = resolveLegacyStartedCutover() as Date
    const preCutover = new Date(legacyCutover.getTime() - 86_400_000)
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [
      { providerId: 'prov-1', providerReference: null, status: 'STARTED', source: 'PURCHASE', dispatchStartedAt: null, startedAt: preCutover },
    ])).toBe(true)
  })

  it('is FALSE for a POST-cutover STARTED attempt with NULL dispatchStartedAt and startedAt at/after the cutover (provably pre-dispatch → redispatch safe)', () => {
    // Marker-first code always stamps dispatchStartedAt before the mutating HTTP,
    // so a STARTED row with a NULL marker whose lifecycle began at/after the
    // cutover provably never crossed the boundary.
    const legacyCutover = resolveLegacyStartedCutover() as Date
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [
      { providerId: 'prov-1', providerReference: null, status: 'STARTED', source: 'PURCHASE', dispatchStartedAt: null, startedAt: new Date(legacyCutover.getTime() + 86_400_000) },
    ])).toBe(false)
  })

  it('is TRUE for a bare STARTED attempt when LEGACY_STARTED_CUTOVER config is MISSING (fail conservative: never assume a legacy row is pre-dispatch)', () => {
    delete process.env[LEGACY_STARTED_CUTOVER_ENV]
    // No cutover => the row's era cannot be proven; redispatch is forbidden.
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [
      { providerId: 'prov-1', providerReference: null, status: 'STARTED', source: 'PURCHASE', dispatchStartedAt: null },
    ])).toBe(true)
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [
      { providerId: 'prov-1', providerReference: null, status: 'STARTED', source: 'PURCHASE', dispatchStartedAt: null, startedAt: new Date('2025-01-01T00:00:00Z') },
    ])).toBe(true)
  })

  it('is TRUE for a bare STARTED attempt when LEGACY_STARTED_CUTOVER config is INVALID (fail conservative)', () => {
    process.env[LEGACY_STARTED_CUTOVER_ENV] = 'not-a-valid-date'
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [
      { providerId: 'prov-1', providerReference: null, status: 'STARTED', source: 'PURCHASE', dispatchStartedAt: null },
    ])).toBe(true)
  })

  it('is FALSE for a definitively-FAILED owning-provider attempt (provable non-commitment → redispatch safe)', () => {
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [
      { providerId: 'prov-1', providerReference: null, status: 'FAILED', source: 'PURCHASE' },
    ])).toBe(false)
  })

  it('is FALSE for SKIPPED/CANCELLED owning-provider attempts', () => {
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [
      { providerId: 'prov-1', providerReference: null, status: 'SKIPPED', source: 'PURCHASE' },
    ])).toBe(false)
    expect(hasProviderAcceptanceEvidence({ id: 'o', providerId: 'prov-1', providerFulfillId: null, providerReservationId: null }, [
      { providerId: 'prov-1', providerReference: null, status: 'CANCELLED', source: 'PURCHASE' },
    ])).toBe(false)
  })
})

describe('isReconciliationEligible', () => {
  const base = { status: 'PROVIDER_RECONCILIATION', retryCount: 0, maxRetries: 3 }

  it('1. retryCount=0 + nextRetryAt=null → eligible', () => {
    expect(isReconciliationEligible({ ...base, nextRetryAt: null })).toBe(true)
  })

  it('2. future nextRetryAt → NOT eligible', () => {
    expect(isReconciliationEligible({ ...base, nextRetryAt: new Date(Date.now() + 60_000) })).toBe(false)
  })

  it('3. due nextRetryAt → eligible', () => {
    expect(isReconciliationEligible({ ...base, nextRetryAt: new Date(Date.now() - 1_000) })).toBe(true)
  })

  it('4. no evidence + retryCount >= maxRetries → NOT eligible (conservative exhaustion preserved)', () => {
    expect(isReconciliationEligible({ ...base, retryCount: 3, maxRetries: 3 })).toBe(false)
    expect(isReconciliationEligible({ ...base, retryCount: 4, maxRetries: 3 })).toBe(false)
  })

  it('5. evidence + retryCount == maxRetries → eligible (read-only polling continues, backoff respected)', () => {
    expect(isReconciliationEligible({ ...base, retryCount: 3, maxRetries: 3, hasAcceptanceEvidence: true, nextRetryAt: null })).toBe(true)
  })

  it('5b. evidence + retryCount > maxRetries → eligible beyond the generic retry budget', () => {
    expect(isReconciliationEligible({ ...base, retryCount: 4, maxRetries: 3, hasAcceptanceEvidence: true, nextRetryAt: null })).toBe(true)
    expect(isReconciliationEligible({ ...base, retryCount: 9, maxRetries: 3, hasAcceptanceEvidence: true, nextRetryAt: null })).toBe(true)
  })

  it('5c. evidence + future nextRetryAt → NOT eligible (backoff bans tight-loop re-selection)', () => {
    expect(isReconciliationEligible({ ...base, retryCount: 5, maxRetries: 3, hasAcceptanceEvidence: true, nextRetryAt: new Date(Date.now() + 60_000) })).toBe(false)
  })

  it('5d. evidence + no nextRetryAt → eligible', () => {
    expect(isReconciliationEligible({ ...base, retryCount: 7, maxRetries: 3, hasAcceptanceEvidence: true, nextRetryAt: null })).toBe(true)
  })

  it('6. terminal status → NOT eligible even with evidence', () => {
    for (const terminal of ['FULFILLED', 'REFUNDED', 'CANCELLED', 'FAILED']) {
      expect(isReconciliationEligible({ ...base, status: terminal, hasAcceptanceEvidence: true })).toBe(false)
    }
  })

  it('7. non-reconciliation status → NOT eligible', () => {
    expect(isReconciliationEligible({ ...base, status: 'PENDING_PROVIDER' })).toBe(false)
    expect(isReconciliationEligible({ ...base, status: 'CREATED' })).toBe(false)
  })

  it('13. provider-neutral: no provider-specific fields needed; acceptance is an explicit flag', () => {
    expect(isReconciliationEligible({ status: 'PROVIDER_RECONCILIATION', retryCount: 0, maxRetries: 3 })).toBe(true)
    expect(isReconciliationEligible({ status: 'PROVIDER_RECONCILIATION', retryCount: 2, maxRetries: 3 })).toBe(true)
  })
})

describe('reconciliationCycleKey — cycle-scoped reconciliation idempotency', () => {
  it('derives a deterministic cycle key from orderId + generation', () => {
    expect(reconciliationCycleKey('ord', 0)).toBe('reconcile:ord:0')
    expect(reconciliationCycleKey('ord', 1)).toBe('reconcile:ord:1')
    expect(reconciliationCycleKey('ord', 2)).toBe('reconcile:ord:2')
  })

  it('is stable within a cycle (same order + same generation → same key), enabling DB-unique dedupe', () => {
    expect(reconciliationCycleKey('ord', 1)).toBe(reconciliationCycleKey('ord', 1))
    expect(reconciliationCycleKey('ord', 2)).toBe(reconciliationCycleKey('ord', 2))
  })

  it('changes when the generation advances, so the next due cycle never collides with a completed one', () => {
    expect(reconciliationCycleKey('ord', 0)).not.toBe(reconciliationCycleKey('ord', 1))
    expect(reconciliationCycleKey('ord', 1)).not.toBe(reconciliationCycleKey('ord', 2))
  })

  it('can never equal the legacy reconcile:{orderId} key (backward compatibility with pre-cycle rows)', () => {
    for (let g = 0; g < 10; g++) {
      expect(reconciliationCycleKey('ord', g)).not.toBe('reconcile:ord')
    }
  })

  it('is per-order: identical generations of different orders never collide', () => {
    expect(reconciliationCycleKey('ord-a', 0)).not.toBe(reconciliationCycleKey('ord-b', 0))
  })

  it('is provider-neutral: the key derives only from orderId + generation, never provider info', () => {
    expect(reconciliationCycleKey('ord', 0)).toBe(reconciliationCycleKey('ord', 0))
    expect(reconciliationCycleKey('ord', 0)).not.toContain('prov')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TASK 3–8: Strategy 3 connector reconciliation — C wins, ICCID stays identity
// ════════════════════════════════════════════════════════════════════════════
describe('reconcileProviderOrder Strategy 3 — authoritative provider reference (C) beats ICCID', () => {
  const A_ICCID = '89012345678901234567'

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockPrisma.providerAttempt.create.mockResolvedValue({ id: 'rec-1' } as any)
    mockFinal.mockResolvedValue({ success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true } as any)
  })

  function telnaOrder(overrides: any = {}) {
    return {
      id: 'order-s3', businessId: 'biz-1', userId: 'user-1',
      status: 'PROVIDER_RECONCILIATION', totalAmount: { toString: () => '10' },
      providerId: 'prov-1', providerFulfillId: null, providerReservationId: null,
      provider: { id: 'prov-1', type: 'TELNA', apiBaseUrl: 'https://api', apiToken: 'tok', environment: 'staging', authUrl: null, name: 'Telna' },
      esims: [{ id: 'esim-1', iccid: A_ICCID }],
      business: { id: 'biz-1' },
      package: { providerPlanId: '42' },
      quantity: 1, createdAt: new Date(),
      ...overrides,
    }
  }

  function reconcileConnector(overrides: any = {}) {
    const fn = vi.fn().mockResolvedValue({
      success: true,
      data: { resolved: true, iccid: A_ICCID, reason: 'unique-match', evidence: { providerPackageInstanceId: 'C-PKG', packageStatus: 'ACTIVE' } },
      ...overrides,
    })
    return { reconcileAmbiguousPurchase: fn, fn }
  }

  it('9/10/11. S3 proves C → durable providerReference is C, ICCID stays fulfillment identity, generic ICCID-only S2 never preempts', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(telnaOrder())
    // S2 would find ACTIVE on the ICCID — but S3 runs first and resolves C.
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', iccid: A_ICCID } }),
    } as any)
    const { reconcileAmbiguousPurchase: rec, fn } = reconcileConnector()
    mockBuildConnector.mockResolvedValue({ reconcileAmbiguousPurchase: rec } as any)

    const result = await reconcileProviderOrder('order-s3')

    expect(result.outcome).toBe('FOUND_SUCCESS')
    // S3 received the exact claimed ICCIDs plus the provider template id.
    expect(rec).toHaveBeenCalledWith(expect.objectContaining({ iccids: [A_ICCID], planId: '42' }))
    // C is the durable reference on the RECONCILIATION attempt.
    const created = mockPrisma.providerAttempt.create.mock.calls[0][0].data
    expect(created.providerReference).toBe('C-PKG')
    expect(created.source).toBe('RECONCILIATION')
    // Finalization receives C → becomes the durable order.providerFulfillId.
    expect(mockFinal).toHaveBeenCalledWith(expect.objectContaining({ providerRef: 'C-PKG' }))
    expect(mockFinal).toHaveBeenCalledTimes(1)
    // The generic ICCID-only S2 fallback never claimed the reference.
    const adapter: any = await mockAdapter.mock.results[0].value
    expect(adapter.getActivationStatus).not.toHaveBeenCalledWith(A_ICCID)
    void fn
  })

  it('15. S3 passes the recovered authoritative provider reference (C) through to the connector (prefer-C) before any A+B correlation', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(telnaOrder())
    mockPrisma.providerAttempt.findMany.mockResolvedValue([
      { providerId: 'prov-1', providerReference: '8656cce5-ad38-4378-915d-3cbc68181850', attemptNumber: 1, startedAt: new Date('2026-08-01T00:00:00Z'), status: 'PROCESSING', source: 'PURCHASE', retryClassification: null, dispatchStartedAt: new Date('2026-08-01T00:00:00Z') },
    ])
    mockAdapter.mockResolvedValue({ getActivationStatus: vi.fn().mockResolvedValue({ success: false }) } as any)
    const { reconcileAmbiguousPurchase: rec, fn } = reconcileConnector()
    mockBuildConnector.mockResolvedValue({ reconcileAmbiguousPurchase: rec } as any)

    const result = await reconcileProviderOrder('order-s3')

    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(rec).toHaveBeenCalledWith(expect.objectContaining({ iccids: [A_ICCID], planId: '42', providerReference: '8656cce5-ad38-4378-915d-3cbc68181850' }))
    const created = mockPrisma.providerAttempt.create.mock.calls[0][0].data
    expect(created.providerReference).toBe('C-PKG')
    void fn
  })

  it('16. Telna acceptance evidence (persisted C) + unresolved reconciliation read -> redispatch stays blocked after exhaustion (wallet held, no second purchase)', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(telnaOrder())
    mockPrisma.providerAttempt.findMany.mockResolvedValue([
      { providerId: 'prov-1', providerReference: '8656cce5-ad38-4378-915d-3cbc68181850', attemptNumber: 1, startedAt: new Date('2026-08-01T00:00:00Z'), status: 'PROCESSING', source: 'PURCHASE', retryClassification: null, dispatchStartedAt: new Date('2026-08-01T00:00:00Z') },
    ])
    mockPrisma.providerAttempt.count.mockResolvedValue(7) // exhaustion threshold reached
    mockAdapter.mockResolvedValue({ getActivationStatus: vi.fn().mockResolvedValue({ success: false }) } as any)
    const rec = vi.fn().mockResolvedValue({
      success: true,
      data: { resolved: false, reason: 'inconclusive', evidence: { source: 'provider-reference-exact-verification', providerPackageInstanceId: '8656cce5-ad38-4378-915d-3cbc68181850', note: 'provider detail read failed or not found' } },
    })
    mockBuildConnector.mockResolvedValue({ reconcileAmbiguousPurchase: rec } as any)

    const result = await reconcileProviderOrder('order-s3')

    expect(result.outcome).toBe('STILL_PENDING')
    expect(result.action).toBe('KEEP_WAITING')
    expect(createTimelineEvent).toHaveBeenCalledWith('order-s3', expect.objectContaining({ eventType: 'REDISPATCH_BLOCKED' }))
    expect(createTimelineEvent).not.toHaveBeenCalledWith('order-s3', expect.objectContaining({ eventType: 'REDISPATCH_ALLOWED' }))
    expect(mockFinal).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('12. historical Telna order (ICCID-shaped providerRef): S1 non-terminal → S3 recovers C naturally, no second dispatch', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(
      telnaOrder({ provider: { id: 'prov-1', type: 'TELNA', apiBaseUrl: 'https://api', apiToken: 'tok', environment: 'staging', authUrl: null, name: 'Telna' } }),
    )
    // The old-code activation attempt persisted the ICCID (A) as providerReference.
    mockPrisma.providerAttempt.findMany.mockResolvedValue([
      { providerId: 'prov-1', providerReference: A_ICCID, attemptNumber: 1, startedAt: new Date('2026-08-01T00:00:00Z'), status: 'PROCESSING', source: 'PURCHASE', retryClassification: null, dispatchStartedAt: new Date('2026-08-01T00:00:00Z') },
    ])
    // S1 polls the ICCID-shaped A → non-terminal PENDING_ACTIVATION (must NOT
    // prematurely settle STILL_PENDING when the connector can recover C).
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PENDING_ACTIVATION', iccid: A_ICCID } }),
    } as any)
    const { reconcileAmbiguousPurchase: rec, fn } = reconcileConnector()
    mockBuildConnector.mockResolvedValue({ reconcileAmbiguousPurchase: rec } as any)

    const result = await reconcileProviderOrder('order-s3')

    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(rec).toHaveBeenCalled()
    const created = mockPrisma.providerAttempt.create.mock.calls[0][0].data
    expect(created.providerReference).toBe('C-PKG')
    expect(mockFinal).toHaveBeenCalledWith(expect.objectContaining({ providerRef: 'C-PKG' }))
    // No purchase dispatch is ever invoked from reconciliation.
    expect((mockAdapter.mock.results[0].value as any).activateESIM).toBeUndefined()
    void fn
  })

  it('13/14. unresolved S3 (zero candidates) → STILL_PENDING, finalizer NOT called (wallet held, no premature FOUND_SUCCESS)', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(telnaOrder())
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: false }),
    } as any)
    const rec = vi.fn().mockResolvedValue({
      success: true,
      data: { resolved: false, reason: 'no-match', evidence: { source: 'packages-list-sim-exact', matchedCount: 0 } },
    })
    mockBuildConnector.mockResolvedValue({ reconcileAmbiguousPurchase: rec } as any)

    const result = await reconcileProviderOrder('order-s3')

    expect(result.outcome).toBe('STILL_PENDING')
    expect(result.action).toBe('KEEP_WAITING')
    expect(mockFinal).not.toHaveBeenCalled()
    expect(mockPrisma.providerAttempt.create.mock.calls[0][0].data.status).toBe('PROCESSING')
  })

  it('15. at most one finalization reach on resolved S3 — exactly one RECONCILIATION succeeded attempt', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(telnaOrder())
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: false }),
    } as any)
    const { reconcileAmbiguousPurchase: rec, fn } = reconcileConnector()
    mockBuildConnector.mockResolvedValue({ reconcileAmbiguousPurchase: rec } as any)

    const result = await reconcileProviderOrder('order-s3')
    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(mockFinal).toHaveBeenCalledTimes(1)
    expect(mockPrisma.providerAttempt.create.mock.calls[0][0].data.status).toBe('SUCCEEDED')
    void fn
  })

  it('16. Choice (URL_TOKEN) regression: S3 no-match falls through to the ICCID-only S2 path unchanged', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(
      telnaOrder({ provider: { id: 'prov-1', type: 'URL_TOKEN', apiBaseUrl: 'https://api', apiToken: 'tok', environment: 'staging', authUrl: null, name: 'Choice' } }),
    )
    // No authoritative reference, ICCID search would confirm ACTIVE.
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', iccid: A_ICCID } }),
    } as any)
    mockBuildConnector.mockResolvedValue({
      reconcileAmbiguousPurchase: vi.fn().mockResolvedValue({
        success: true,
        data: { resolved: false, reason: 'no-match', evidence: { candidateCount: 0 } },
      }),
    } as any)

    const result = await reconcileProviderOrder('order-s3')

    // Existing semantics preserved: ICCID-only search still FOUND_SUCCESS with
    // the ICCID as reference when the connector cannot prove a stronger ref.
    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(result.providerReference).toBe(A_ICCID)
  })

  it('17. connector failure inside S3 is best-effort: falls back to the preserved S1 pending verdict, never crashes reconciliation', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(
      telnaOrder({ provider: { id: 'prov-1', type: 'TELNA', apiBaseUrl: 'https://api', apiToken: 'tok', environment: 'staging', authUrl: null, name: 'Telna' } }),
    )
    // ICCID-shaped reference recovered from the old-code attempt.
    mockPrisma.providerAttempt.findMany.mockResolvedValue([
      { providerId: 'prov-1', providerReference: A_ICCID, attemptNumber: 1, startedAt: new Date('2026-08-01T00:00:00Z'), status: 'PROCESSING', source: 'PURCHASE', retryClassification: null, dispatchStartedAt: new Date('2026-08-01T00:00:00Z') },
    ])
    // S1 is non-terminal → the preserved pending verdict is returned when S3 fails.
    mockAdapter.mockResolvedValue({
      getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PENDING_ACTIVATION', iccid: A_ICCID } }),
    } as any)
    mockBuildConnector.mockResolvedValue({
      reconcileAmbiguousPurchase: vi.fn().mockRejectedValue(new Error('upstream read burst')),
    } as any)

    const result = await reconcileProviderOrder('order-s3')

    expect(result.outcome).toBe('STILL_PENDING')
    expect(result.providerReference).toBe(A_ICCID)
    expect(mockFinal).not.toHaveBeenCalled()
  })

  it('S1-structured. reconciliation Strategy 1 uses semantic identity when the adapter declares structured support — C never a bare UUID', async () => {
    const C_UUID = '8656cce5-ad38-4378-915d-3cbc68181850'
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(telnaOrder())
    // Durable authoritative reference C (uuid package instance) on the PURCHASE attempt.
    mockPrisma.providerAttempt.findMany.mockResolvedValue([
      { providerId: 'prov-1', providerReference: C_UUID, attemptNumber: 1, startedAt: new Date('2026-08-01T00:00:00Z'), status: 'PROCESSING', source: 'PURCHASE', retryClassification: null, dispatchStartedAt: new Date('2026-08-01T00:00:00Z') },
    ])
    const statusFn = vi.fn().mockResolvedValue({ success: true, data: { status: 'PROCESSING' } })
    mockAdapter.mockResolvedValue({
      getActivationStatus: statusFn,
      supportsStructuredStatusLookup: true,
    } as any)
    const { reconcileAmbiguousPurchase: rec, fn } = reconcileConnector()
    mockBuildConnector.mockResolvedValue({ reconcileAmbiguousPurchase: rec } as any)

    const result = await reconcileProviderOrder('order-s3')

    expect(result.outcome).toBe('FOUND_SUCCESS')
    // S1 addressed C exactly through the structured identifier, never as a bare
    // UUID fed into the ICCID slot; S3 still resolved C and proved it.
    expect(statusFn).toHaveBeenCalledWith({ iccid: A_ICCID, providerSubscriptionId: C_UUID })
    expect(statusFn).not.toHaveBeenCalledWith(C_UUID)
    expect(rec).toHaveBeenCalledWith(expect.objectContaining({ providerReference: C_UUID }))
    const created = mockPrisma.providerAttempt.create.mock.calls[0][0].data
    expect(created.providerReference).toBe('C-PKG')
    expect(mockFinal).toHaveBeenCalledWith(expect.objectContaining({ providerRef: 'C-PKG' }))
    void fn
  })

  it('S1-bare. reconciliation Strategy 1 without structured support keeps the bare reference call (numeric refs unchanged)', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(telnaOrder())
    mockPrisma.providerAttempt.findMany.mockResolvedValue([
      { providerId: 'prov-1', providerReference: '12811381', attemptNumber: 1, startedAt: new Date('2026-08-01T00:00:00Z'), status: 'PROCESSING', source: 'PURCHASE', retryClassification: null, dispatchStartedAt: new Date('2026-08-01T00:00:00Z') },
    ])
    // iBASIS-style adapter: no structured flag → bare string reference preserved.
    const statusFn = vi.fn().mockResolvedValue({ success: true, data: { status: 'PENDING_ACTIVATION' } })
    mockAdapter.mockResolvedValue({ getActivationStatus: statusFn } as any)
    const { reconcileAmbiguousPurchase: rec, fn } = reconcileConnector()
    mockBuildConnector.mockResolvedValue({ reconcileAmbiguousPurchase: rec } as any)

    const result = await reconcileProviderOrder('order-s3')

    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(statusFn).toHaveBeenCalledWith('12811381')
    void fn
  })
})