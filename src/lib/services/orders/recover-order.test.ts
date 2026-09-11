import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    provider: { findUnique: vi.fn() },
    providerAttempt: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    walletTransaction: { findFirst: vi.fn() },
    eSIMPackage: { findUnique: vi.fn() },
    providerPackage: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  getAdapterForType: vi.fn(),
  isProviderOperational: vi.fn().mockReturnValue(true),
}))

vi.mock('./fulfillment', () => ({
  resumeProviderFinalization: vi.fn(),
  completeProviderFinalization: vi.fn(),
}))

vi.mock('./order-state-machine', () => ({
  createTimelineEvent: vi.fn(),
  transitionOrder: vi.fn(),
}))

vi.mock('./reconciliation', () => ({
  reconcileProviderOrder: vi.fn(),
}))

vi.mock('./wallet-actions', () => ({
  releaseReservedFunds: vi.fn(),
}))

vi.mock('@/lib/services/routing/provider-failover-engine', () => ({
  classifyRetry: vi.fn(() => 'RETRYABLE'),
}))

vi.mock('./package-backing-resolver', () => ({
  resolvePackageBacking: vi.fn(),
}))

vi.mock('./provider-attempt-number', () => ({
  allocateProviderAttemptNumber: vi.fn(async () => 2),
}))

const { prisma } = await import('@/lib/prisma')
const { getAdapterForType } = await import('@/lib/providers/adapter-manager')
const { completeProviderFinalization } = await import('./fulfillment')
const { transitionOrder, createTimelineEvent } = await import('./order-state-machine')
const { reconcileProviderOrder } = await import('./reconciliation')
const { releaseReservedFunds } = await import('./wallet-actions')
const { resolvePackageBacking } = await import('./package-backing-resolver')
const { recoverOrder } = await import('./recovery')

const mockOrderFindUnique = vi.mocked(prisma.eSIMPurchase.findUnique)
const mockOrderUpdate = vi.mocked(prisma.eSIMPurchase.update)
const mockProviderFindUnique = vi.mocked(prisma.provider.findUnique)
const mockAttemptFindMany = vi.mocked(prisma.providerAttempt.findMany)
const mockWalletFindFirst = vi.mocked(prisma.walletTransaction.findFirst)
const mockFinalize = vi.mocked(completeProviderFinalization)
const mockTransition = vi.mocked(transitionOrder)
const mockTimeline = vi.mocked(createTimelineEvent)
const mockReconcile = vi.mocked(reconcileProviderOrder)
const mockGetAdapter = vi.mocked(getAdapterForType)
const mockBacking = vi.mocked(resolvePackageBacking)

const mockActivationStatus = vi.fn()
const mockActivateESIM = vi.fn()

function providerRow() {
  return { id: 'prov-1', name: 'Telna', status: 'ACTIVE', type: 'TELNA', apiBaseUrl: 'https://x', apiToken: 't', environment: 'test', authUrl: null }
}

function orderRow(overrides: any = {}) {
  return {
    id: 'order-1',
    status: 'PENDING_PROVIDER',
    providerFulfillId: null,
    providerReservationId: null,
    retryCount: 0,
    maxRetries: 3,
    providerId: 'prov-1',
    businessId: 'biz-1',
    userId: 'user-1',
    totalAmount: 10,
    quantity: 1,
    packageId: 'pkg-1',
    esims: [],
    provider: providerRow(),
    business: { id: 'biz-1', walletBalance: 100, status: 'ACTIVE' },
    ...overrides,
  }
}

function attempt(overrides: any = {}) {
  return {
    id: 'att-1', providerId: 'prov-1', status: 'FAILED', source: 'PURCHASE',
    retryClassification: 'RETRYABLE', errorCode: null, providerReference: null,
    startedAt: new Date('2026-09-09T10:00:00Z'), dispatchStartedAt: null, attemptNumber: 1,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockOrderFindUnique.mockResolvedValue(orderRow() as any)
  mockOrderUpdate.mockResolvedValue({} as any)
  mockProviderFindUnique.mockResolvedValue(providerRow() as any)
  mockAttemptFindMany.mockResolvedValue([] as any)
  vi.mocked(prisma.providerAttempt.create).mockResolvedValue({ id: 'att-2', orderId: 'order-1', providerId: 'prov-1', startedAt: new Date('2026-09-09T10:05:00Z') } as any)
  vi.mocked(prisma.providerAttempt.update).mockResolvedValue({} as any)
  vi.mocked(prisma.eSIMPackage.findUnique).mockResolvedValue({ id: 'pkg-1', providerPackageId: 'pp-1', providerId: 'prov-1', providerPlanId: 'plan-x' } as any)
  mockWalletFindFirst.mockImplementation(async ({ where }: any) => {
    if (where?.type === 'WALLET_RESERVE') return { id: 'res-1', amount: 10 }
    return null
  })
  mockFinalize.mockResolvedValue({ success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true, error: undefined } as any)
  mockTransition.mockResolvedValue(undefined as any)
  mockTimeline.mockResolvedValue(undefined as any)
  mockReconcile.mockResolvedValue({ outcome: 'STILL_PENDING', status: 'PROVIDER_RECONCILIATION', message: 'still pending' } as any)
  mockGetAdapter.mockResolvedValue({ getActivationStatus: mockActivationStatus, activateESIM: mockActivateESIM } as any)
  mockBacking.mockResolvedValue({ kind: 'BOUND', backing: { providerId: 'prov-1', providerPlanId: 'plan-1' } } as any)
  mockActivationStatus.mockReset()
  mockActivateESIM.mockReset()
})

describe('recoverOrder — POLL_PROVIDER authoritative success finalizes and captures (live staging shape)', () => {
  it('A. PENDING_PROVIDER + PROCESSING attempt + reference + ACTIVE-with-ICCID → finalize once + capture, no repurchase', async () => {
    mockOrderFindUnique.mockResolvedValue(orderRow() as any)
    mockAttemptFindMany.mockResolvedValue([attempt({ status: 'PROCESSING', providerReference: '12811381', dispatchStartedAt: new Date('2026-09-09T10:00:00Z') })] as any)
    mockActivationStatus.mockResolvedValue({ success: true, data: { status: 'ACTIVE', iccid: '89882221234567890123' } })

    const result = await recoverOrder('order-1')

    expect(result.success).toBe(true)
    expect(result.action).toBe('POLL_PROVIDER')
    expect(result.status).toBe('FULFILLED')
    // The authoritative exact-package read is polled with the provider-owned reference.
    expect(mockActivationStatus).toHaveBeenCalledWith('12811381')
    // Fulfillment persisted (ICCID-backed) and wallet captured exactly once.
    expect(mockFinalize).toHaveBeenCalledTimes(1)
    expect(mockFinalize).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-1',
      providerRef: '12811381',
      providerName: 'Telna',
      providerResult: expect.objectContaining({ iccids: ['89882221234567890123'], providerStatus: 'ACTIVE' }),
    }))
    // Never a second provider purchase.
    expect(mockActivateESIM).not.toHaveBeenCalled()
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('A2. poll ACTIVE without any ICCID identity → NOT finalized, wallet stays reserved (ICCID-gated invariant)', async () => {
    mockAttemptFindMany.mockResolvedValue([attempt({ status: 'PROCESSING', providerReference: '12811381', dispatchStartedAt: new Date('2026-09-09T10:00:00Z') })] as any)
    mockActivationStatus.mockResolvedValue({ success: true, data: { status: 'ACTIVE', iccid: null } })

    const result = await recoverOrder('order-1')

    expect(result.success).toBe(false)
    expect(mockFinalize).not.toHaveBeenCalled()
    expect(mockActivateESIM).not.toHaveBeenCalled()
    // A retry is scheduled, not a release.
    expect(mockOrderUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'order-1' },
      data: expect.objectContaining({ retryCount: 1, nextRetryAt: expect.any(Date) }),
    }))
  })
})

describe('recoverOrder — P0 dispatch safety', () => {
  it('B. acceptance evidence (provider-owned reference on a FAILED attempt) → reconcile, NEVER activateESIM again', async () => {
    mockAttemptFindMany.mockResolvedValue([attempt({ status: 'FAILED', providerReference: '12811381', errorCode: 'PROVIDER_ERROR' })] as any)

    const result = await recoverOrder('order-1')

    expect(mockActivateESIM).not.toHaveBeenCalled()
    expect(mockReconcile).toHaveBeenCalledTimes(1)
    expect(result.action).toBe('RECONCILIATION_REQUIRED')
  })

  it('D. dispatch may have occurred (STARTED + dispatchStartedAt set, no reference yet) → reconcile, never redispatch', async () => {
    mockAttemptFindMany.mockResolvedValue([attempt({ status: 'STARTED', providerReference: null, dispatchStartedAt: new Date('2026-09-09T10:00:00Z') })] as any)

    const result = await recoverOrder('order-1')

    expect(mockActivateESIM).not.toHaveBeenCalled()
    expect(mockReconcile).toHaveBeenCalledTimes(1)
    expect(result.action).toBe('RECONCILIATION_REQUIRED')
  })

  it('H. FOUND_FAILURE via reconciliation → authoritative terminal, NOT_RETRYABLE, no redispatch', async () => {
    mockAttemptFindMany.mockResolvedValue([attempt({ status: 'FAILED', providerReference: '12811381', errorCode: 'PROVIDER_ERROR' })] as any)
    mockReconcile.mockResolvedValue({ outcome: 'FOUND_FAILURE', status: 'FAILED', message: 'Provider confirmed failure — released' } as any)

    const result = await recoverOrder('order-1')

    expect(result.action).toBe('NOT_RETRYABLE')
    expect(result.success).toBe(false)
    expect(mockActivateESIM).not.toHaveBeenCalled()
  })

  it('I. FOUND_SUCCESS via reconciliation → mapped to local finalization action, single reconcile call', async () => {
    mockAttemptFindMany.mockResolvedValue([attempt({ status: 'FAILED', providerReference: '12811381', errorCode: 'PROVIDER_ERROR' })] as any)
    mockReconcile.mockResolvedValue({ outcome: 'FOUND_SUCCESS', status: 'FULFILLED', message: 'Provider confirmed success' } as any)

    const result = await recoverOrder('order-1')

    expect(result.success).toBe(true)
    expect(result.action).toBe('RESUME_LOCAL_FINALIZATION')
    expect(mockReconcile).toHaveBeenCalledTimes(1)
    expect(mockActivateESIM).not.toHaveBeenCalled()
  })
})

describe('recoverOrder — provable pre-dispatch redispatch', () => {
  it('C. PENDING_PROVIDER with NO attempts + wallet reserved → controlled REDISPATCH (exactly one purchase)', async () => {
    mockAttemptFindMany.mockResolvedValue([] as any)
    mockActivateESIM.mockResolvedValue({ success: true, data: { activationId: 'ref-2' } })

    const result = await recoverOrder('order-1')

    expect(result.action).toBe('REDISPATCH_PROVIDER')
    expect(mockActivateESIM).toHaveBeenCalledTimes(1)
    expect(mockActivateESIM).toHaveBeenCalledWith(expect.objectContaining({ planId: 'plan-1' }))
    // Dispatch marker contract: attempt recorded before HTTP with dispatchStartedAt set.
    const createCall = vi.mocked(prisma.providerAttempt.create).mock.calls[0][0]
    expect(createCall.data).toEqual(expect.objectContaining({ orderId: 'order-1', source: 'PURCHASE', status: 'STARTED' }))
    // No ICCIDs from the provider yet → finalization/capture must NOT run.
    expect(mockFinalize).not.toHaveBeenCalled()
  })
})

describe('recoverOrder — idempotent terminal + deferral behavior', () => {
  it('F. already FULFILLED → ALREADY_COMPLETE no-op (no provider call, no wallet mutation)', async () => {
    mockOrderFindUnique.mockResolvedValue(orderRow({ status: 'FULFILLED' }) as any)
    const result = await recoverOrder('order-1')
    expect(result.success).toBe(true)
    expect(result.action).toBe('ALREADY_COMPLETE')
    expect(mockActivateESIM).not.toHaveBeenCalled()
    expect(mockFinalize).not.toHaveBeenCalled()
    expect(vi.mocked(releaseReservedFunds)).not.toHaveBeenCalled()
  })

  it('J. reconcile STILL_PENDING → deferred (PROVIDER_RECONCILIATION), wallet held, no release, no redispatch', async () => {
    mockAttemptFindMany.mockResolvedValue([attempt({ status: 'FAILED', providerReference: '12811381', errorCode: 'PROVIDER_ERROR' })] as any)
    mockReconcile.mockResolvedValue({ outcome: 'STILL_PENDING', status: 'PROVIDER_RECONCILIATION', message: 'no change at provider' } as any)

    const result = await recoverOrder('order-1')

    expect(result.success).toBe(false)
    expect(result.action).toBe('RECONCILIATION_REQUIRED')
    expect(result.status).toBe('PROVIDER_RECONCILIATION')
    // The order transitions and stays scheduled by the reconciliation engine
    // (nextRetryAt is persisted inside reconcileProviderOrder), wallet untouched.
    expect(mockTransition).toHaveBeenCalledWith('order-1', 'PROVIDER_RECONCILIATION')
    expect(vi.mocked(releaseReservedFunds)).not.toHaveBeenCalled()
    expect(mockActivateESIM).not.toHaveBeenCalled()
  })
})

describe('recoverOrder — structured status lookup (semantic identity, never a bare C)', () => {
  const A_ICCID = '8910300000016182009'
  const C_UUID = '8656cce5-ad38-4378-915d-3cbc68181850'

  it('D. PENDING_PROVIDER + PROCESSING attempt + UUID reference + structured-capable adapter → polls { iccid: A, providerSubscriptionId: C }, never bare C', async () => {
    mockOrderFindUnique.mockResolvedValue(orderRow({ esims: [{ id: 'e1', iccid: A_ICCID }] }) as any)
    mockAttemptFindMany.mockResolvedValue([attempt({ status: 'PROCESSING', providerReference: C_UUID, dispatchStartedAt: new Date('2026-09-09T10:00:00Z') })] as any)
    mockGetAdapter.mockResolvedValue({
      getActivationStatus: mockActivationStatus,
      activateESIM: mockActivateESIM,
      supportsStructuredStatusLookup: true,
    } as any)
    mockActivationStatus.mockResolvedValue({ success: true, data: { status: 'ACTIVE', iccid: A_ICCID } })

    const result = await recoverOrder('order-1')

    expect(result.success).toBe(true)
    expect(result.action).toBe('POLL_PROVIDER')
    // Semantic identity: A in the ICCID slot, C in the provider-owned reference slot.
    expect(mockActivationStatus).toHaveBeenCalledWith({ iccid: A_ICCID, providerSubscriptionId: C_UUID })
    expect(mockActivationStatus).not.toHaveBeenCalledWith(C_UUID)
    expect(mockActivateESIM).not.toHaveBeenCalled()
    // Finalized with the authoritative provider reference C.
    expect(mockFinalize).toHaveBeenCalledTimes(1)
    expect(mockFinalize).toHaveBeenCalledWith(expect.objectContaining({ providerRef: C_UUID }))
  })

  it('E/J. PROVIDER_RECONCILIATION + PROCESSING attempt + reference → RECONCILIATION_REQUIRED (reconcile once, no poll, no dispatch)', async () => {
    mockOrderFindUnique.mockResolvedValue(orderRow({ status: 'PROVIDER_RECONCILIATION', retryCount: 34, maxRetries: 3, esims: [{ id: 'e1', iccid: A_ICCID }] }) as any)
    mockAttemptFindMany.mockResolvedValue([attempt({ status: 'PROCESSING', providerReference: C_UUID, dispatchStartedAt: new Date('2026-09-09T10:00:00Z') })] as any)
    mockReconcile.mockResolvedValue({ outcome: 'STILL_PENDING', status: 'PROVIDER_RECONCILIATION', message: 'exact C read inconclusive' } as any)

    const result = await recoverOrder('order-1')

    expect(result.action).toBe('RECONCILIATION_REQUIRED')
    expect(result.status).toBe('PROVIDER_RECONCILIATION')
    // Exactly one reconciliation pass — never re-enqueued to the generic poll loop,
    // never a second purchase/dispatch, wallet stays reserved.
    expect(mockReconcile).toHaveBeenCalledTimes(1)
    expect(mockActivationStatus).not.toHaveBeenCalled()
    expect(mockActivateESIM).not.toHaveBeenCalled()
    expect(mockFinalize).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.providerAttempt.create)).not.toHaveBeenCalled()
    expect(vi.mocked(releaseReservedFunds)).not.toHaveBeenCalled()
  })

  it('K. activationCode present does NOT bypass identity verification (no ICCID → no finalization, no capture)', async () => {
    mockAttemptFindMany.mockResolvedValue([attempt({ status: 'PROCESSING', providerReference: '12811381', dispatchStartedAt: new Date('2026-09-09T10:00:00Z') })] as any)
    // Bare adapter (no structured support): bare numeric ref passed through.
    mockActivationStatus.mockResolvedValue({
      success: true,
      data: { status: 'ACTIVE', iccid: null, activationCode: 'LPA:1$smdp.test$matching-id', qrCode: 'data:image/png;base64,xx' },
    })

    const result = await recoverOrder('order-1')

    expect(result.success).toBe(false)
    expect(mockActivationStatus).toHaveBeenCalledWith('12811381')
    // activationCode is delivery data only — completion requires an eSIM/ICCID identity.
    expect(mockFinalize).not.toHaveBeenCalled()
    expect(mockActivateESIM).not.toHaveBeenCalled()
    expect(mockOrderUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'order-1' },
      data: expect.objectContaining({ retryCount: 1, nextRetryAt: expect.any(Date) }),
    }))
  })
})