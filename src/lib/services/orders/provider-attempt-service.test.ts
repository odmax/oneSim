import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    providerAttempt: { count: vi.fn(), create: vi.fn(), update: vi.fn() },
    provider: { findUnique: vi.fn() },
    providerPackage: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  getAdapterForType: vi.fn(),
}))

vi.mock('@/lib/services/routing/provider-failover-engine', () => ({
  classifyRetry: vi.fn(() => 'NON_RETRYABLE'),
  classifyProviderOutcome: vi.fn(() => 'DEFINITIVE_FAILURE'),
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
const { classifyProviderOutcome } = await import('@/lib/services/routing/provider-failover-engine')
const { executeProviderAttempt } = await import('./provider-attempt-service')

const mockPrisma = vi.mocked(prisma)
const mockGetAdapter = vi.mocked(getAdapterForType)
const mockComplete = vi.mocked(completeProviderOperation)
const mockClassifyOutcome = vi.mocked(classifyProviderOutcome)

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

describe('executeProviderAttempt — cross-provider plan-binding ownership guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockPrisma.providerAttempt.create.mockResolvedValue({ id: 'attempt-guard' })
    mockPrisma.providerAttempt.update.mockResolvedValue({})
    mockPrisma.provider.findUnique.mockResolvedValue({ id: PROVIDER_ID, name: 'Test', type: 'CUSTOM', status: 'ACTIVE', apiBaseUrl: '', apiToken: '', environment: 'test', authUrl: '' })
  })

  function guardedInput(overrides: any = {}) {
    return {
      ...baseInput(),
      providerPackageId: 'pp-own',
      ...overrides,
    }
  }

  it('valid ownership: provider owns the ProviderPackage → derives planId from it and dispatches', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    // Retail package is bound to pp-own which belongs to PROVIDER_ID with external plan "ext-plan-own".
    mockPrisma.providerPackage.findUnique.mockResolvedValue({ id: 'pp-own', providerId: PROVIDER_ID, providerPlanId: 'ext-plan-own' })
    const activate = vi.fn().mockResolvedValue({ success: true, data: { activationId: 'act-1', iccids: ['89012345678901234567'], status: 'ACTIVE' } })
    mockGetAdapter.mockResolvedValue({ validatePurchase: undefined, activateESIM: activate } as any)

    // baseInput() has planId 'plan-1' — the guard must derive 'ext-plan-own' from ProviderPackage, not trust 'plan-1'.
    const result = await executeProviderAttempt(guardedInput())

    expect(result.success).toBe(true)
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ planId: 'ext-plan-own' }))
    // The stale independently-supplied planId must never reach the connector.
    expect(JSON.stringify(activate.mock.calls[0][0])).not.toContain('plan-1')
  })

  it('mismatch: selected provider does NOT own the ProviderPackage → blocked before connector', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    // pp-own belongs to a DIFFERENT provider (e.g. US-Matrix) than the attempt provider.
    mockPrisma.providerPackage.findUnique.mockResolvedValue({ id: 'pp-own', providerId: 'other-provider', providerPlanId: 'usm-uuid' })
    const activate = vi.fn()
    mockGetAdapter.mockResolvedValue({ validatePurchase: undefined, activateESIM: activate } as any)

    const result = await executeProviderAttempt(guardedInput())

    expect(result.success).toBe(false)
    expect(result.status).toBe('PROVIDER_PACKAGE_MISMATCH')
    expect(result.errorCode).toBe('PROVIDER_PACKAGE_MISMATCH')
    // The connector must NEVER be invoked with the wrong provider's identifier.
    expect(activate).not.toHaveBeenCalled()
    // Attempt recorded as SKIPPED + NON_RETRYABLE with mismatch metadata.
    const updateCall = mockPrisma.providerAttempt.update.mock.calls[0][0] as any
    expect(updateCall.data.status).toBe('SKIPPED')
    expect(updateCall.data.retryClassification).toBe('NON_RETRYABLE')
    expect(updateCall.data.errorCode).toBe('PROVIDER_PACKAGE_MISMATCH')
  })

  it('providerPackage not found → PACKAGE_UNAVAILABLE (stale backing, retryable) before connector', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerPackage.findUnique.mockResolvedValue(null)
    const activate = vi.fn()
    mockGetAdapter.mockResolvedValue({ validatePurchase: undefined, activateESIM: activate } as any)

    const result = await executeProviderAttempt(guardedInput())
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('PACKAGE_UNAVAILABLE')
    expect(result.status).toBe('PACKAGE_UNAVAILABLE')
    expect(activate).not.toHaveBeenCalled()
  })

  it('external plan id collision is safe: planId is derived from the owning ProviderPackage, never resolved globally', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    // Same external string "ABC123" exists on provider A and provider B, but
    // the ProviderPackage lookup is by internal id + providerId — never by
    // external plan id alone.
    mockPrisma.providerPackage.findUnique.mockResolvedValue({ id: 'pp-own', providerId: PROVIDER_ID, providerPlanId: 'ABC123' })
    const activate = vi.fn().mockResolvedValue({ success: true, data: { activationId: 'a', iccids: ['89012345678901234567'], status: 'ACTIVE' } })
    mockGetAdapter.mockResolvedValue({ validatePurchase: undefined, activateESIM: activate } as any)

    const result = await executeProviderAttempt(guardedInput())
    expect(result.success).toBe(true)
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ planId: 'ABC123' }))
  })

  it('records providerPackageId / externalPlanId / retailPackageId in attempt metadata', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockPrisma.providerPackage.findUnique.mockResolvedValue({ id: 'pp-own', providerId: PROVIDER_ID, providerPlanId: 'ext-plan-own' })
    mockGetAdapter.mockResolvedValue({ validatePurchase: undefined, activateESIM: vi.fn().mockResolvedValue({ success: true, data: { activationId: 'a', iccids: ['89012345678901234567'], status: 'ACTIVE' } }) } as any)

    await executeProviderAttempt(guardedInput())
    const createCall = mockPrisma.providerAttempt.create.mock.calls[0][0] as any
    expect(createCall.data.providerId).toBe(PROVIDER_ID)
    expect(createCall.data.metadata).toMatchObject({
      providerPackageId: 'pp-own',
      externalPlanId: 'plan-1',
      retailPackageId: 'pkg-1',
    })
  })

  it('same-provider normal purchase unchanged when providerPackageId is absent (legacy path)', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    // No providerPackageId → guard skipped; uses supplied planId (existing behavior).
    const activate = vi.fn().mockResolvedValue({ success: true, data: { activationId: 'a', iccids: ['89012345678901234567'], status: 'ACTIVE' } })
    mockGetAdapter.mockResolvedValue({ validatePurchase: undefined, activateESIM: activate } as any)

    const result = await executeProviderAttempt(baseInput())
    expect(result.success).toBe(true)
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ planId: 'plan-1' }))
  })

  it('ambiguous TIMEOUT → AMBIGUOUS status, attempt marked AMBIGUOUS, no finalizer', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockGetAdapter.mockResolvedValue({
      validatePurchase: undefined,
      activateESIM: vi.fn().mockResolvedValue({ success: false, error: { code: 'TIMEOUT', message: 'Request timed out', details: { ambiguous: true } } }),
    } as any)
    mockClassifyOutcome.mockReturnValue('AMBIGUOUS_PROVIDER_OUTCOME')

    const result = await executeProviderAttempt(baseInput())

    expect(result.success).toBe(false)
    expect(result.status).toBe('AMBIGUOUS')
    expect(result.errorCode).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
    const updateCall = mockPrisma.providerAttempt.update.mock.calls[0][0] as any
    expect(updateCall.data.status).toBe('AMBIGUOUS')
    expect(updateCall.data.retryClassification).toBe('NON_RETRYABLE')
    expect(updateCall.data.metadata).toMatchObject({ ambiguous: true, reconciliationRequired: true })
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('persists a recovered provider order reference on an upstream-confirmed ambiguous outcome', async () => {
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
    mockGetAdapter.mockResolvedValue({
      validatePurchase: undefined,
      activateESIM: vi.fn().mockResolvedValue({
        success: false,
        error: {
          code: 'NO_ICCIDS',
          message: 'AirHub confirmed success but returned no usable ICCID — the outcome is ambiguous',
          details: { retryable: false, providerStatus: 200, ambiguous: true, upstreamConfirmed: true, providerOrderId: 'AH-ORDER-7', simId: '8901234567890123456' },
        },
      }),
    } as any)
    mockClassifyOutcome.mockReturnValue('AMBIGUOUS_PROVIDER_OUTCOME')

    const result = await executeProviderAttempt(baseInput())

    expect(result.status).toBe('AMBIGUOUS')
    const updateCall = mockPrisma.providerAttempt.update.mock.calls[0][0] as any
    expect(updateCall.data.status).toBe('AMBIGUOUS')
    expect(updateCall.data.providerReference).toBe('AH-ORDER-7')
    expect(updateCall.data.metadata).toMatchObject({
      ambiguous: true,
      reconciliationRequired: true,
      providerOrderId: 'AH-ORDER-7',
      upstreamConfirmed: true,
    })
    expect(mockComplete).not.toHaveBeenCalled()
  })
})

describe('executeProviderAttempt — three-provider cross-failover safety (USMATRIX/CHOICE/AIRHUB)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockPrisma.providerAttempt.create.mockResolvedValue({ id: 'attempt-3p' })
    mockPrisma.providerAttempt.update.mockResolvedValue({})
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(mockOrder())
  })

  const scoped = (attemptProviderId: string, packageOwnerProviderId: string, providerPackageId: string, planId: string) => {
    mockPrisma.provider.findUnique.mockResolvedValue({ id: attemptProviderId, name: attemptProviderId, type: 'CUSTOM', status: 'ACTIVE', apiBaseUrl: '', apiToken: '', environment: 'test', authUrl: '' })
    mockPrisma.providerPackage.findUnique.mockResolvedValue({ id: providerPackageId, providerId: packageOwnerProviderId, providerPlanId: planId })
  }

  const guardedInput = (overrides: any = {}) => ({ ...baseInput(), providerPackageId: 'pp-own', ...overrides })

  it('USMATRIX package → CHOICE failover is impossible: CHOICE.activateESIM never runs', async () => {
    // Attempt attributed to CHOICE (failover bug simulation); package owned by US-Matrix.
    scoped('prov-choice', 'prov-usm', 'pp-usm', 'usm-uuid-123')
    const activate = vi.fn()
    mockGetAdapter.mockResolvedValue({ validatePurchase: undefined, activateESIM: activate } as any)

    const result = await executeProviderAttempt(guardedInput({ providerId: 'prov-choice', providerPackageId: 'pp-usm', planId: 'usm-uuid-123' }))

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('PROVIDER_PACKAGE_MISMATCH')
    // CHOICE connector must receive ZERO calls; the US-Matrix UUID never reaches CHOICE.
    expect(activate).not.toHaveBeenCalled()
  })

  it('CHOICE package → AIRHUB failover is impossible: AIRHUB never receives CHOICE identifier', async () => {
    scoped('prov-airhub', 'prov-choice', 'pp-choice', 'choice-sku')
    const activate = vi.fn()
    mockGetAdapter.mockResolvedValue({ validatePurchase: undefined, activateESIM: activate } as any)

    const result = await executeProviderAttempt(guardedInput({ providerId: 'prov-airhub', providerPackageId: 'pp-choice', planId: 'choice-sku' }))
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('PROVIDER_PACKAGE_MISMATCH')
    expect(activate).not.toHaveBeenCalled()
  })

  it('AIRHUB package → USMATRIX failover is impossible: assign-package never receives AIRHUB identifier', async () => {
    scoped('prov-usm', 'prov-airhub', 'pp-airhub', 'airhub-plan')
    const activate = vi.fn()
    mockGetAdapter.mockResolvedValue({ validatePurchase: undefined, activateESIM: activate } as any)

    const result = await executeProviderAttempt(guardedInput({ providerId: 'prov-usm', providerPackageId: 'pp-airhub', planId: 'airhub-plan' }))
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('PROVIDER_PACKAGE_MISMATCH')
    expect(activate).not.toHaveBeenCalled()
  })

  it('same-provider purchase still succeeds for each provider (USMATRIX/CHOICE/AIRHUB)', async () => {
    for (const [providerId, ppId, planId] of [['prov-usm', 'pp-usm', 'usm-uuid'], ['prov-choice', 'pp-choice', 'choice-sku'], ['prov-airhub', 'pp-airhub', 'airhub-plan']] as const) {
      mockPrisma.providerPackage.findUnique.mockReset()
      mockPrisma.provider.findUnique.mockReset()
      scoped(providerId, providerId, ppId, planId)
      const activate = vi.fn().mockResolvedValue({ success: true, data: { activationId: 'a', iccids: ['89012345678901234567'], status: 'ACTIVE' } })
      mockGetAdapter.mockResolvedValue({ validatePurchase: undefined, activateESIM: activate } as any)

      const result = await executeProviderAttempt(guardedInput({ providerId, providerPackageId: ppId, planId }))
      expect(result.success).toBe(true)
      expect(activate).toHaveBeenCalledWith(expect.objectContaining({ planId }))
    }
  })

  it('ambiguous timeout is NOT weakened: ownership guard is NON_RETRYABLE, so it cannot trigger cross-provider dispatch', async () => {
    // The guard must classify PROVIDER_PACKAGE_MISMATCH as NON_RETRYABLE so the
    // orchestrator's failover loop does NOT treat it as a retryable attempt.
    scoped('prov-choice', 'prov-usm', 'pp-usm', 'usm-uuid')
    const activate = vi.fn()
    mockGetAdapter.mockResolvedValue({ validatePurchase: undefined, activateESIM: activate } as any)

    const result = await executeProviderAttempt(guardedInput({ providerId: 'prov-choice', providerPackageId: 'pp-usm', planId: 'usm-uuid' }))
    expect(result.errorCode).toBe('PROVIDER_PACKAGE_MISMATCH')
    const updateCall = mockPrisma.providerAttempt.update.mock.calls[0][0] as any
    expect(updateCall.data.retryClassification).toBe('NON_RETRYABLE')
    // No connector call → no chance of a duplicate/dispatch.
    expect(activate).not.toHaveBeenCalled()
  })

  it('arbitrary future provider codes behave identically (no provider-name coupling)', async () => {
    scoped('prov-future', 'prov-future', 'pp-future', 'future-plan')
    const activate = vi.fn().mockResolvedValue({ success: true, data: { activationId: 'a', iccids: ['89012345678901234567'], status: 'ACTIVE' } })
    mockGetAdapter.mockResolvedValue({ validatePurchase: undefined, activateESIM: activate } as any)

    const own = await executeProviderAttempt(guardedInput({ providerId: 'prov-future', providerPackageId: 'pp-future', planId: 'future-plan' }))
    expect(own.success).toBe(true)

    mockPrisma.provider.findUnique.mockReset()
    mockPrisma.providerPackage.findUnique.mockReset()
    scoped('prov-other', 'prov-future', 'pp-future', 'future-plan')
    const wrong = await executeProviderAttempt(guardedInput({ providerId: 'prov-other', providerPackageId: 'pp-future', planId: 'future-plan' }))
    expect(wrong.success).toBe(false)
    expect(wrong.errorCode).toBe('PROVIDER_PACKAGE_MISMATCH')
  })
})
