import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Controllable mocks for next-auth ──────────────────────────────────────
const mockGetServerSession = vi.fn().mockResolvedValue(null)

vi.mock('next-auth', () => ({
  getServerSession: (...args: any[]) => mockGetServerSession(...args),
}))

vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))

// ─── Prisma mock ────────────────────────────────────────────────────────────
vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
    },
    walletTransaction: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
    },
    business: {
      findUnique: vi.fn().mockResolvedValue({ walletBalance: 100, status: 'APPROVED' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    businessUser: {
      findFirst: vi.fn(),
    },
    providerAttempt: {
      aggregate: vi.fn().mockResolvedValue({ _max: { attemptNumber: null } }),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    provider: { findUnique: vi.fn() },
    providerPackage: { findFirst: vi.fn(), findUnique: vi.fn() },
    eSIMPackage: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn(), count: vi.fn(), create: vi.fn() },
    eSIMPackageProviderBinding: { findFirst: vi.fn() },
    orderTimelineEvent: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: any) =>
      fn({
        walletTransaction: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
        business: { findUnique: vi.fn().mockResolvedValue({ walletBalance: 100 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      })
    ),
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  getAdapterForType: vi.fn(),
  isProviderOperational: vi.fn(() => true),
}))

vi.mock('@/lib/services/routing/provider-failover-engine', () => ({
  classifyProviderOutcome: vi.fn(() => 'DEFINITIVE_FAILURE'),
  classifyRetry: vi.fn(() => 'NON_RETRYABLE'),
}))

vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  buildConnectorFromProvider: vi.fn(),
}))

vi.mock('@/lib/services/orders/fulfillment', () => ({
  completeProviderFinalization: vi.fn().mockResolvedValue({ success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true }),
  resumeProviderFinalization: vi.fn(),
}))

vi.mock('@/lib/services/orders/lifecycle-publisher', () => ({
  publishOrderLifecycleEvent: vi.fn().mockReturnValue({ catch: vi.fn() }),
  ORDER_LIFECYCLE_EVENTS: { RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED' },
}))

vi.mock('@/lib/services/orders/order-state-machine', () => ({
  transitionOrder: vi.fn().mockResolvedValue({}),
  createTimelineEvent: vi.fn().mockResolvedValue({}),
  failOrder: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/services/orders/wallet-actions', () => ({
  releaseReservedFundsUpTo: vi.fn().mockResolvedValue({}),
  releaseReservedFunds: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/services/orders/package-backing-resolver', () => ({
  resolvePackageBacking: vi.fn(),
}))

// ─── Imports (after all vi.mock) ───────────────────────────────────────────
import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { completeProviderFinalization } from '@/lib/services/orders/fulfillment'
import { resolvePackageBacking } from '@/lib/services/orders/package-backing-resolver'

const mockPrisma = vi.mocked(prisma)
const mockAdapter = vi.mocked(getAdapterForType)
const mockBuildConnector = vi.mocked(buildConnectorFromProvider)
const mockComplete = vi.mocked(completeProviderFinalization)
const mockResolveBacking = vi.mocked(resolvePackageBacking)

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockReset()
  mockGetServerSession.mockResolvedValue(null)
})

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 1: INCOMPLETE_RESPONSE post-dispatch → AMBIGUOUS (no second mutation)
// ═══════════════════════════════════════════════════════════════════════════════
describe('CERT-1: INCOMPLETE_RESPONSE is AMBIGUOUS after dispatch', () => {
  it('post-dispatch incomplete response returns AMBIGUOUS, not RETRYABLE', async () => {
    const activateESIM = vi.fn().mockResolvedValue({
      success: true,
      data: { status: 'PENDING_ACTIVATION', iccids: [], imsis: [] },
    })
    const adapter = { activateESIM, validatePurchase: vi.fn().mockResolvedValue({ valid: true }) } as any
    mockAdapter.mockResolvedValue(adapter)

    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({
      id: 'o1', status: 'PENDING_PROVIDER', esims: [], userId: 'u1',
      packageSnapshot: null, packageName: null, packageDataGB: null,
      packageValidityDays: null, quotedQuantity: null, quantity: 1,
    } as any)
    mockPrisma.provider.findUnique.mockResolvedValue({
      id: 'prov-1', type: 'URL_TOKEN', apiBaseUrl: '', apiToken: '', environment: 'staging', authUrl: '',
    } as any)
    mockPrisma.providerAttempt.count.mockResolvedValue(0)

    const { executeProviderAttempt } = await import('./provider-attempt-service')
    const result = await executeProviderAttempt({
      orderId: 'o1', businessId: 'biz-1', providerId: 'prov-1', providerName: 'Choice',
      planId: 'plan-1', quantity: 1, subscriber: { email: 't@t.com', first_name: 'T' },
      totalAmount: 5, displayName: 'Test', packageId: 'pkg-1', rankedProviders: [],
      providerPackageByProviderId: { 'prov-1': 'pp-1' }, unitPrice: 5,
    })

    expect(result.status).toBe('AMBIGUOUS')
    expect(result.errorCode).toBe('INCOMPLETE_RESPONSE')

    const attemptUpdate = mockPrisma.providerAttempt.update.mock.calls.find(
      (c: any) => c[0]?.data?.status === 'AMBIGUOUS'
    )
    expect(attemptUpdate).toBeDefined()
    expect(attemptUpdate![0].data.retryClassification).toBe('NON_RETRYABLE')

    expect(activateESIM).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 2: testApiOrder cannot bypass purchase engine in production
// ═══════════════════════════════════════════════════════════════════════════════
describe('CERT-2: testApiOrder refuses in production', () => {
  const originalEnv = process.env.NODE_ENV

  afterEach(() => { process.env.NODE_ENV = originalEnv })

  it('returns error when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production' as any

    mockGetServerSession.mockResolvedValue({
      user: { id: 'u1', role: 'BUSINESS_USER', businessId: 'biz-1' },
    } as any)
    mockPrisma.businessUser.findFirst.mockResolvedValue({ role: 'ADMIN' } as any)
    mockPrisma.business.findUnique.mockResolvedValue({ status: 'APPROVED' } as any)

    const { testApiOrder } = await import('@/lib/actions/api-test-console')
    const fd = new FormData()
    fd.set('customerName', 'X')
    fd.set('customerEmail', 'x@x.com')
    fd.set('packageId', 'pkg-1')
    const result = await testApiOrder(fd)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/disabled in production/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 3: Ambiguous reconciliation is wired + recovery routes into it
// ═══════════════════════════════════════════════════════════════════════════════
describe('CERT-3a: recovery classifier routes PROVIDER_RECONCILIATION orders', () => {
  it('PROVIDER_RECONCILIATION status routes to RECONCILIATION_REQUIRED', () => {
    const c = classifyOrderRecovery({
      order: {
        id: 'o1', status: 'PROVIDER_RECONCILIATION',
        providerFulfillId: null, providerReservationId: null,
        retryCount: 0, maxRetries: 5,
        providerId: 'prov-1', businessId: 'biz-1', totalAmount: 10,
      },
      esims: [],
      walletReserved: true,
      walletCaptured: false,
      providerAttempts: [
        { id: 'a1', status: 'AMBIGUOUS', source: 'PURCHASE', retryClassification: 'NON_RETRYABLE', errorCode: 'UNKNOWN', providerReference: null },
      ],
      providerPollingSupported: true,
    } as any)

    expect(c.action).toBe('RECONCILIATION_REQUIRED')
  })
})

describe('CERT-3b: reconciliation engine uses connector-specific Strategy 3', () => {
  it('reaches Strategy 3 and calls connector.reconcileAmbiguousPurchase', async () => {
    const reconcile = vi.fn().mockResolvedValue({ success: true, data: { resolved: true, iccid: '89012345' } })
    const connector = { reconcileAmbiguousPurchase: reconcile } as any
    mockBuildConnector.mockResolvedValue(connector)

    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({
      id: 'o1', status: 'PROVIDER_RECONCILIATION', providerId: 'prov-1',
      providerFulfillId: null, providerReservationId: null,
      esims: [], quantity: 1, totalAmount: 10, createdAt: new Date(),
      userId: 'u1', businessId: 'biz-1',
      package: { providerPlanId: 'plan-ext' },
      provider: { id: 'prov-1', type: 'URL_TOKEN', apiBaseUrl: '', apiToken: '', environment: 'staging', authUrl: '', name: 'Choice' },
      business: { id: 'biz-1' },
    } as any)
    mockPrisma.providerAttempt.count.mockResolvedValue(1)

    const adapter = { getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PENDING' } }) } as any
    mockAdapter.mockResolvedValue(adapter)

    const { reconcileProviderOrder } = await import('./reconciliation')
    const result = await reconcileProviderOrder('o1')

    expect(reconcile).toHaveBeenCalled()
    expect(result.outcome).toBe('FOUND_SUCCESS')
  })

  it('without connector support, falls through to STILL_PENDING', async () => {
    mockBuildConnector.mockResolvedValue({} as any)

    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({
      id: 'o1', status: 'PROVIDER_RECONCILIATION', providerId: 'prov-1',
      providerFulfillId: null, providerReservationId: null,
      esims: [], quantity: 1, totalAmount: 10, createdAt: new Date(),
      userId: 'u1', businessId: 'biz-1',
      package: null,
      provider: { id: 'prov-1', type: 'AIRHUB', apiBaseUrl: '', apiToken: '', environment: 'staging', authUrl: '', name: 'Airhub' },
      business: { id: 'biz-1' },
    } as any)
    mockPrisma.providerAttempt.count.mockResolvedValue(0)

    const adapter = { getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PENDING' } }) } as any
    mockAdapter.mockResolvedValue(adapter)

    const { reconcileProviderOrder } = await import('./reconciliation')
    const result = await reconcileProviderOrder('o1')

    expect(result.outcome).toBe('STILL_PENDING')
    expect(mockComplete).not.toHaveBeenCalled()
  })
})

import { classifyOrderRecovery } from './recovery'

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 4: Recovery provider-neutral redispatch — no Custom Package Builder dep
// ═══════════════════════════════════════════════════════════════════════════════

function setupRedispatchMocks(overrides: {
  backing?: any
  retailPkg?: any
  adapterResult?: any
} = {}) {
  const { backing = { kind: 'BOUND', backing: { providerPackageId: 'pp-1', providerId: 'prov-1', providerPlanId: 'EXT-123' } }, retailPkg = { id: 'pkg-1', providerPackageId: 'pp-1', providerId: 'prov-1', providerPlanId: 'local-plan' }, adapterResult = { success: true, data: { status: 'ACTIVE', activationId: 'act-1', iccids: ['iccid-1'] } } } = overrides

  mockResolveBacking.mockReset()
  mockResolveBacking.mockResolvedValue(backing)
  mockComplete.mockReset()
  mockComplete.mockResolvedValue({ success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true } as any)
  mockAdapter.mockReset()
  mockAdapter.mockResolvedValue({
    activateESIM: vi.fn().mockResolvedValue(adapterResult),
    validatePurchase: vi.fn().mockResolvedValue({ valid: true }),
    getActivationStatus: vi.fn(),
  } as any)

  // order lookup
  mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({
    id: 'o1', status: 'PAYMENT_RESERVED', providerId: 'prov-1', businessId: 'biz-1',
    totalAmount: 10, retryCount: 0, maxRetries: 5, packageId: 'pkg-1', userId: 'u1',
    quantity: 1, providerFulfillId: null, providerReservationId: null,
    esims: [], provider: { id: 'prov-1', type: 'URL_TOKEN', code: 'CHOICE' },
    business: { id: 'biz-1', walletBalance: 100, status: 'APPROVED' },
  } as any)

  // wallet txs — none (reserved but not captured/released)
  mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)

  // provider attempts — one FAILED retryable = triggers REDISPATCH_PROVIDER
  mockPrisma.providerAttempt.findMany.mockResolvedValue([
    { id: 'a1', status: 'FAILED', source: 'PURCHASE', retryClassification: 'RETRYABLE', errorCode: 'PROVIDER_TIMEOUT', providerReference: null },
  ] as any)
  mockPrisma.providerAttempt.count.mockResolvedValue(1)
  mockPrisma.providerAttempt.create.mockResolvedValue({ id: 'a2', attemptNumber: 2, startedAt: new Date() } as any)
  mockPrisma.providerAttempt.update.mockResolvedValue({})

  // provider lookup
  mockPrisma.provider.findUnique.mockResolvedValue({
    id: 'prov-1', type: 'URL_TOKEN', apiBaseUrl: '', apiToken: '', environment: 'staging', authUrl: '', name: 'Choice', status: 'ACTIVE',
  } as any)

  // adapter
  const freshAdapter = {
    activateESIM: vi.fn().mockResolvedValue(adapterResult),
    validatePurchase: vi.fn().mockResolvedValue({ valid: true }),
    getActivationStatus: vi.fn(),
  }
  mockAdapter.mockResolvedValue(freshAdapter as any)

  // retail package lookup
  mockPrisma.eSIMPackage.findUnique.mockResolvedValue(retailPkg)

  // backing resolver
  mockResolveBacking.mockReset()
  mockResolveBacking.mockResolvedValue(backing)

  // fulfillment
  mockComplete.mockResolvedValue({ success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true } as any)
}

describe('CERT-4a: recovery redispatch uses resolvePackageBinding (no eSIMPackageProviderBinding)', () => {
  it('BOUND backing resolves correct external providerPlanId and calls adapter', async () => {
    setupRedispatchMocks({
      backing: { kind: 'BOUND', backing: { providerPackageId: 'pp-1', providerId: 'prov-1', providerPlanId: 'EXT-123' } },
      adapterResult: { success: true, data: { status: 'PENDING_ACTIVATION', iccids: [], imsis: [] } },
    })

    const { recoverOrder } = await import('./recovery')
    const result = await recoverOrder('o1')

    expect(mockResolveBacking).toHaveBeenCalledTimes(1)
    const calledPkg = mockResolveBacking.mock.calls[0][0]
    expect(calledPkg.id).toBe('pkg-1')
    expect(calledPkg.providerPackageId).toBe('pp-1')

    const adapter = await mockAdapter.mock.results[0].value
    const callArgs = adapter.activateESIM.mock.calls[0][0]
    expect(callArgs.planId).toBe('EXT-123')
    expect(callArgs.planId).not.toBe('pkg-1')
    expect(callArgs.planId).not.toBe('local-plan')

    expect(result.success || result.action === 'REDISPATCH_PROVIDER').toBe(true)
  })

  it('provider mismatch blocks redispatch and returns reconciliation', async () => {
    setupRedispatchMocks({
      backing: { kind: 'BOUND', backing: { providerPackageId: 'pp-wrong', providerId: 'prov-other', providerPlanId: 'EXT-456' } },
    })

    const { recoverOrder } = await import('./recovery')
    const result = await recoverOrder('o1')

    expect(result.success).toBe(false)
    expect(result.action).toBe('RECONCILIATION_REQUIRED')
    expect(result.message).toMatch(/No authoritative provider package backing/)
  })

  it('NONE backing blocks redispatch — no fallback to order.packageId', async () => {
    setupRedispatchMocks({
      backing: { kind: 'NONE' },
      retailPkg: { id: 'pkg-1', providerPackageId: null, providerId: null, providerPlanId: null },
    })

    const { recoverOrder } = await import('./recovery')
    const result = await recoverOrder('o1')

    expect(result.success).toBe(false)
    expect(result.action).toBe('RECONCILIATION_REQUIRED')
    expect(result.message).toMatch(/No authoritative provider package binding/)
  })

  it('UNAVAILABLE backing blocks redispatch', async () => {
    setupRedispatchMocks({
      backing: { kind: 'UNAVAILABLE' },
      retailPkg: { id: 'pkg-1', providerPackageId: 'pp-1', providerId: 'prov-1', providerPlanId: 'local-plan' },
    })

    const { recoverOrder } = await import('./recovery')
    const result = await recoverOrder('o1')

    expect(result.success).toBe(false)
    expect(result.action).toBe('RECONCILIATION_REQUIRED')
    expect(result.message).toMatch(/No authoritative provider package binding/)
  })

  it('CUSTOM backing with matching provider loads ProviderPackage.providerPlanId', async () => {
    setupRedispatchMocks({
      backing: { kind: 'CUSTOM', backings: [{ providerPackageId: 'pp-c1', providerId: 'prov-1', providerName: 'Choice', priority: 1 }] },
      retailPkg: { id: 'pkg-1', providerPackageId: null, providerId: null, providerPlanId: null },
      adapterResult: { success: true, data: { status: 'PENDING_ACTIVATION', iccids: [], imsis: [] } },
    })

    mockPrisma.providerPackage.findUnique.mockResolvedValue({ providerPlanId: 'CUSTOM-PLAN-99' } as any)

    const { recoverOrder } = await import('./recovery')
    const result = await recoverOrder('o1')

    expect(mockResolveBacking).toHaveBeenCalledTimes(1)
    const adapter = await mockAdapter.mock.results[0].value
    expect(adapter.activateESIM).toHaveBeenCalledTimes(1)
    expect(adapter.activateESIM.mock.calls[0][0].planId).toBe('CUSTOM-PLAN-99')
    expect(adapter.activateESIM.mock.calls[0][0].planId).not.toBe('pkg-1')
    expect(result.success || result.action === 'REDISPATCH_PROVIDER').toBe(true)
  })

  it('CUSTOM backing with no matching provider blocks redispatch', async () => {
    setupRedispatchMocks({
      backing: { kind: 'CUSTOM', backings: [{ providerPackageId: 'pp-c1', providerId: 'prov-other', providerName: 'Other', priority: 1 }] },
      retailPkg: { id: 'pkg-1', providerPackageId: null, providerId: null, providerPlanId: null },
    })

    const { recoverOrder } = await import('./recovery')
    const result = await recoverOrder('o1')

    expect(result.success).toBe(false)
    expect(result.action).toBe('RECONCILIATION_REQUIRED')
    expect(result.message).toMatch(/No authoritative provider package backing/)
  })

  it('order.packageId is NEVER sent upstream as provider planId', async () => {
    setupRedispatchMocks({
      backing: { kind: 'BOUND', backing: { providerPackageId: 'pp-1', providerId: 'prov-1', providerPlanId: 'EXT-123' } },
      adapterResult: { success: true, data: { status: 'PENDING_ACTIVATION', iccids: [], imsis: [] } },
    })

    const { recoverOrder } = await import('./recovery')
    const result = await recoverOrder('o1')

    const adapter = await mockAdapter.mock.results[0].value
    const callArgs = adapter.activateESIM.mock.calls[0][0]

    expect(callArgs.planId).toBe('EXT-123')
    expect(callArgs.planId).not.toBe('pkg-1')
    expect(JSON.stringify(callArgs)).not.toContain('"pkg-1"')
    expect(result.success || result.action === 'REDISPATCH_PROVIDER').toBe(true)
  })
})
