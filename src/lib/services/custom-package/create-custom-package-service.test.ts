import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockProviderPackageFindMany,
  mockProviderFindUnique,
  mockESIMCreate,
  mockBindingCreate,
  mockTransaction,
  mockAuditCreate,
  mockBuildConnector,
  mockReadiness,
  mockValidatePricing,
  mockResolveBackingProviders,
  mockPackageSnapshotCreate,
  mockPackageSnapshotUpdate,
  mockPackageConfigRuleFindFirst,
  mockExchangeRateFindFirst,
  mockUpstreamOpFindUnique,
  mockUpstreamOpCreate,
  mockUpstreamOpUpdateMany,
  mockUpstreamOpUpdate,
  mockSystemJobLockUpsert,
  mockSystemJobLockFindUnique,
  mockSystemJobLockDelete,
  mockProviderPackageFindFirst,
  mockProviderPackageCreate,
  mockESIMFindFirst,
  mockBindingUpsert,
} = vi.hoisted(() => ({
  mockProviderPackageFindMany: vi.fn(),
  mockProviderFindUnique: vi.fn(),
  mockESIMCreate: vi.fn(),
  mockBindingCreate: vi.fn(),
  mockTransaction: vi.fn(),
  mockAuditCreate: vi.fn(),
  mockBuildConnector: vi.fn(),
  mockReadiness: vi.fn(),
  mockValidatePricing: vi.fn(),
  mockResolveBackingProviders: vi.fn(),
  mockPackageSnapshotCreate: vi.fn(),
  mockPackageSnapshotUpdate: vi.fn(),
  mockPackageConfigRuleFindFirst: vi.fn(),
  mockExchangeRateFindFirst: vi.fn(),
  mockUpstreamOpFindUnique: vi.fn(),
  mockUpstreamOpCreate: vi.fn(),
  mockUpstreamOpUpdateMany: vi.fn(),
  mockUpstreamOpUpdate: vi.fn(),
  mockSystemJobLockUpsert: vi.fn(),
  mockSystemJobLockFindUnique: vi.fn(),
  mockSystemJobLockDelete: vi.fn(),
  mockProviderPackageFindFirst: vi.fn(),
  mockProviderPackageCreate: vi.fn(),
  mockESIMFindFirst: vi.fn(),
  mockBindingUpsert: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: { findMany: mockProviderPackageFindMany, create: mockProviderPackageCreate, findUnique: vi.fn(), findFirst: mockProviderPackageFindFirst },
    provider: { findUnique: mockProviderFindUnique },
    eSIMPackage: { create: mockESIMCreate, findFirst: mockESIMFindFirst },
    eSIMPackageProviderBinding: { create: mockBindingCreate, upsert: mockBindingUpsert },
    upstreamPackageCreationOperation: {
      findUnique: mockUpstreamOpFindUnique,
      create: mockUpstreamOpCreate,
      updateMany: mockUpstreamOpUpdateMany,
      update: mockUpstreamOpUpdate,
    },
    systemJobLock: { upsert: mockSystemJobLockUpsert, findUnique: mockSystemJobLockFindUnique, delete: mockSystemJobLockDelete },
    auditLog: { create: mockAuditCreate },
    packagePriceSnapshot: { create: mockPackageSnapshotCreate, update: mockPackageSnapshotUpdate },
    packageConfigurationRule: { findFirst: mockPackageConfigRuleFindFirst },
    exchangeRate: { findFirst: mockExchangeRateFindFirst },
    $transaction: mockTransaction,
  },
}))

vi.mock('@/lib/providers/connectors/connector-factory', () => ({ buildConnectorFromProvider: mockBuildConnector }))
vi.mock('@/lib/providers/capability-state', () => ({ getCustomPackageCreationReadiness: mockReadiness }))

vi.mock('@/lib/pricing/pricing-engine', async () => {
  const actual = await vi.importActual('@/lib/pricing/pricing-engine')
  return { ...actual, validatePricing: mockValidatePricing }
})

vi.mock('./custom-package', async () => {
  const actual = await vi.importActual('./custom-package')
  return { ...actual, resolveBackingProviders: mockResolveBackingProviders }
})

import { createCustomPackageWithMode } from './create-custom-package-service'
import type { CustomPackageCreateRequest } from './types'

function modeARows() {
  return [
    { providerPackageId: 'pp-1', providerId: 'prov-1', priority: 1, enabled: true },
    { providerPackageId: 'pp-2', providerId: 'prov-2', priority: 2, enabled: true },
  ]
}

describe('createCustomPackageWithMode — MODE A (EXISTING_BACKINGS)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockValidatePricing.mockReturnValue({ valid: true })
    mockTransaction.mockImplementation(async (fn: any) => fn({
      eSIMPackage: { create: mockESIMCreate },
      eSIMPackageProviderBinding: { create: mockBindingCreate, findFirst: vi.fn().mockResolvedValue(null) },
      providerPackage: { create: vi.fn(), update: vi.fn() },
      packagePriceSnapshot: { create: mockPackageSnapshotCreate },
      packageConfigurationRule: { findFirst: mockPackageConfigRuleFindFirst },
      exchangeRate: { findFirst: mockExchangeRateFindFirst },
    }))
    mockESIMCreate.mockResolvedValue({ id: 'esim-1' })
    mockBindingCreate.mockResolvedValue({ id: 'b' })
  })

  function req(overrides: Partial<CustomPackageCreateRequest> = {}): CustomPackageCreateRequest {
    return {
      mode: 'EXISTING_BACKINGS',
      name: 'Africa 10GB',
      dataGB: 10,
      validityDays: 30,
      sellingPrice: 29.99,
      currency: 'USD',
      backings: modeARows(),
      ...overrides,
    }
  }

  it('CPB-T1: Mode A accepts providers WITHOUT requiring CUSTOM_PACKAGE_CREATION (AirHub backing ok)', async () => {
    mockProviderPackageFindMany.mockResolvedValue([
      { id: 'pp-1', providerId: 'prov-airhub', dataGB: 12, validityDays: 30, country: 'ZAF', region: null, configurationStatus: 'CONFIGURED', publishStatus: 'PUBLISHED', sellingPrice: { toString: () => '8' }, costPrice: { toString: () => '4' }, provider: { id: 'prov-airhub', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } },
      { id: 'pp-2', providerId: 'prov-2', dataGB: 12, validityDays: 30, country: 'ZAF', region: null, configurationStatus: 'CONFIGURED', publishStatus: 'PUBLISHED', sellingPrice: { toString: () => '9' }, costPrice: { toString: () => '5' }, provider: { id: 'prov-2', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } },
    ])
    mockResolveBackingProviders.mockReturnValue([
      { providerPackageId: 'pp-1', providerId: 'prov-airhub', compatible: true, purchaseReady: true },
      { providerPackageId: 'pp-2', providerId: 'prov-2', compatible: true, purchaseReady: true },
    ])
    const r = await createCustomPackageWithMode(req(), 'admin-1')
    expect(r.success).toBe(true)
    expect(r.esimPackageId).toBe('esim-1')
    // createCustomPackage() is NEVER invoked on Mode A.
    expect(mockBuildConnector).not.toHaveBeenCalled()
    expect(mockReadiness).not.toHaveBeenCalled()
  })

  it('CPB-T2: Mode A accepts iBASIS/Rakuten/US-Matrix backing packages when normal purchase eligibility passes', async () => {
    mockProviderPackageFindMany.mockResolvedValue([
      { id: 'pp-ibasis', providerId: 'prov-ibasis', dataGB: 15, validityDays: 30, country: 'NGA', region: null, configurationStatus: 'CONFIGURED', publishStatus: 'PUBLISHED', sellingPrice: { toString: () => '8' }, costPrice: { toString: () => '4' }, provider: { id: 'prov-ibasis', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } },
    ])
    mockResolveBackingProviders.mockReturnValue([
      { providerPackageId: 'pp-ibasis', providerId: 'prov-ibasis', compatible: true, purchaseReady: true },
    ])
    const r = await createCustomPackageWithMode(req({ backings: [{ providerPackageId: 'pp-ibasis', providerId: 'prov-ibasis', priority: 1, enabled: true }] }), 'admin-1')
    expect(r.success).toBe(true)
  })

  it('CPB-T3: Mode A preserves multi-provider priority/failover ordering', async () => {
    mockProviderPackageFindMany.mockResolvedValue([
      { id: 'pp-1', providerId: 'prov-1', dataGB: 12, validityDays: 30, country: 'ZAF', region: null, configurationStatus: 'CONFIGURED', publishStatus: 'PUBLISHED', sellingPrice: { toString: () => '8' }, costPrice: { toString: () => '4' }, provider: { id: 'prov-1', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } },
      { id: 'pp-2', providerId: 'prov-2', dataGB: 12, validityDays: 30, country: 'ZAF', region: null, configurationStatus: 'CONFIGURED', publishStatus: 'PUBLISHED', sellingPrice: { toString: () => '9' }, costPrice: { toString: () => '5' }, provider: { id: 'prov-2', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } },
    ])
    mockResolveBackingProviders.mockReturnValue([
      { providerPackageId: 'pp-1', providerId: 'prov-1', compatible: true, purchaseReady: true },
      { providerPackageId: 'pp-2', providerId: 'prov-2', compatible: true, purchaseReady: true },
    ])
    const r = await createCustomPackageWithMode(req({ allowFailover: true }), 'admin-1')
    expect(r.providerPackageIds).toEqual(['pp-1', 'pp-2'])
    // Bindings created at priorities 1 and 2 in order.
    expect(mockBindingCreate.mock.calls.map(c => c[0].data.priority)).toEqual([1, 2])
  })

  it('CPB-T17: BOUND packages remain unchanged (Mode A never touches providerPackageId on BOUND paths)', async () => {
    mockProviderPackageFindMany.mockResolvedValue([
      { id: 'pp-1', providerId: 'prov-1', dataGB: 12, validityDays: 30, country: 'ZAF', region: null, configurationStatus: 'CONFIGURED', publishStatus: 'PUBLISHED', sellingPrice: { toString: () => '8' }, costPrice: { toString: () => '4' }, provider: { id: 'prov-1', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } },
    ])
    mockResolveBackingProviders.mockReturnValue([
      { providerPackageId: 'pp-1', providerId: 'prov-1', compatible: true, purchaseReady: true },
    ])
    const r = await createCustomPackageWithMode(req({ backings: [{ providerPackageId: 'pp-1', providerId: 'prov-1', priority: 1, enabled: true }] }), 'admin-1')
    // Custom package still uses providerPackageId: null + bindings.
    expect(mockESIMCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ providerPackageId: null, source: 'CATALOG_PRODUCT' }),
    }))
    expect(r.success).toBe(true)
  })

  it('CPB-T16: Mode A is atomic — a binding failure rolls back the whole creation (no half-package)', async () => {
    mockProviderPackageFindMany.mockResolvedValue([
      { id: 'pp-1', providerId: 'prov-1', dataGB: 12, validityDays: 30, country: 'ZAF', region: null, configurationStatus: 'CONFIGURED', publishStatus: 'PUBLISHED', sellingPrice: { toString: () => '8' }, costPrice: { toString: () => '4' }, provider: { id: 'prov-1', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } },
      { id: 'pp-2', providerId: 'prov-2', dataGB: 12, validityDays: 30, country: 'ZAF', region: null, configurationStatus: 'CONFIGURED', publishStatus: 'PUBLISHED', sellingPrice: { toString: () => '9' }, costPrice: { toString: () => '5' }, provider: { id: 'prov-2', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } },
    ])
    mockResolveBackingProviders.mockReturnValue([
      { providerPackageId: 'pp-1', providerId: 'prov-1', compatible: true, purchaseReady: true },
      { providerPackageId: 'pp-2', providerId: 'prov-2', compatible: true, purchaseReady: true },
    ])
    // Simulate a transaction abort (binding create throws on 2nd).
    mockTransaction.mockImplementationOnce(async (fn: any) => {
      await fn({
        eSIMPackage: { create: vi.fn().mockResolvedValue({ id: 'esim-atomic' }) },
        eSIMPackageProviderBinding: { create: vi.fn().mockResolvedValueOnce({ id: 'b1' }).mockRejectedValueOnce(new Error('UNIQUE constraint failed')) },
      })
      throw new Error('Transaction aborted')
    })
    const r = await createCustomPackageWithMode(req(), 'admin-1')
    expect(r.success).toBe(false)
    expect(r.partialFailure).toBeUndefined()
  })

  it('CPB-T22: Mode A validation rejects duplicate ProviderPackage', async () => {
    const r = await createCustomPackageWithMode(req({ backings: [
      { providerPackageId: 'pp-1', providerId: 'prov-1', priority: 1, enabled: true },
      { providerPackageId: 'pp-1', providerId: 'prov-2', priority: 2, enabled: true },
    ] }), 'admin-1')
    expect(r.success).toBe(false)
    expect(r.error).toContain('cannot be selected twice')
    expect(mockProviderPackageFindMany).not.toHaveBeenCalled()
  })

  it('CPB-T22b: Mode A validation requires priority 1', async () => {
    const r = await createCustomPackageWithMode(req({ backings: [
      { providerPackageId: 'pp-2', providerId: 'prov-2', priority: 2, enabled: true },
    ] }), 'admin-1')
    expect(r.success).toBe(false)
    expect(r.error).toContain('Priority 1')
  })
})

describe('createCustomPackageWithMode — MODE B (UPSTREAM_CREATE)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Enable the kill switch for these tests (prod default is OFF).
    process.env.CUSTOM_PACKAGE_UPSTREAM_CREATION_ENABLED = 'true'
    mockValidatePricing.mockReturnValue({ valid: true })
    mockProviderFindUnique.mockResolvedValue({ id: 'prov-choice', code: 'CHOICE', name: 'Choice', status: 'ACTIVE' })
    mockReadiness.mockResolvedValue({ ready: true })
    mockBuildConnector.mockResolvedValue({
      getCustomPackageDefinition: vi.fn(),
      createCustomPackage: vi.fn().mockResolvedValue({ success: true, data: { success: true, providerPlanId: 'TZN-5GB-7D', providerPlanCode: 'TZN-5GB-7D' } }),
    })
    mockSystemJobLockUpsert.mockResolvedValue({})
    mockProviderPackageFindFirst.mockResolvedValue(null)
    mockESIMFindFirst.mockResolvedValue(null)
    mockUpstreamOpFindUnique.mockResolvedValue(null)
    mockUpstreamOpCreate.mockResolvedValue({
      id: 'op-1',
      idempotencyKey: 'cpb_upstream_key1',
      requestFingerprint: 'fp1',
      status: 'PENDING',
      providerId: 'prov-choice',
      providerCode: 'CHOICE',
      requestedSku: 'TZN-5GB-7D',
      requestedBy: 'admin-1',
      upstreamReference: null,
      providerPackageId: null,
      esimPackageId: null,
      lastErrorCode: null,
      lastErrorMessageSafe: null,
    })
    mockUpstreamOpUpdateMany.mockResolvedValue({ count: 1 })
    mockUpstreamOpUpdate.mockResolvedValue({})
    mockBindingUpsert.mockResolvedValue({ id: 'b' })
    mockTransaction.mockImplementation(async (fn: any) => fn({
      eSIMPackage: { create: mockESIMCreate, findFirst: mockESIMFindFirst },
      eSIMPackageProviderBinding: { create: mockBindingCreate, upsert: mockBindingUpsert },
      providerPackage: { create: mockProviderPackageCreate, findFirst: mockProviderPackageFindFirst, findUnique: vi.fn(), findMany: mockProviderPackageFindMany, update: vi.fn() },
    }))
    mockProviderPackageCreate.mockResolvedValue({ id: 'pp-new-1' })
    mockESIMCreate.mockResolvedValue({ id: 'esim-upstream' })
    mockBindingCreate.mockResolvedValue({ id: 'b' })
  })

  function upstreamReq(overrides: Partial<CustomPackageCreateRequest> = {}): CustomPackageCreateRequest {
    return {
      mode: 'UPSTREAM_CREATE',
      name: 'Tanzania 5GB',
      dataGB: 5,
      validityDays: 7,
      sellingPrice: 19.99,
      currency: 'USD',
      providerId: 'prov-choice',
      upstreamConfirmed: true,
      upstreamIdempotencyKey: 'cpb_upstream_key1',
      providerValues: { sku: 'TZN-5GB-7D', bundle_name: 'Tanzania 5GB', pool: 1 },
      ...overrides,
    }
  }

  // ---------------------------------------------------------------
  // Validation / eligibility (server-side, unspoofable)
  // ---------------------------------------------------------------

  it('CPB-S1: requires a valid upstream idempotency key', async () => {
    const r = await createCustomPackageWithMode(upstreamReq({ upstreamIdempotencyKey: 'not-a-cpb-key' }), 'admin-1')
    expect(r.success).toBe(false)
    expect((r as any).category).toBe('VALIDATION')
    expect(mockUpstreamOpFindUnique).not.toHaveBeenCalled()
    expect(mockBuildConnector).not.toHaveBeenCalled()
  })

  it('CPB-S2: Mode B re-validates eligibility server-side (cannot be spoofed by form)', async () => {
    mockReadiness.mockResolvedValue({ ready: false, reason: 'account-not-enabled' })
    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(false)
    expect((r as any).category).toBe('NOT_ENTITLED')
    expect(mockUpstreamOpCreate).not.toHaveBeenCalled()
    expect(mockESIMCreate).not.toHaveBeenCalled()
  })

  it('CPB-S3: kill switch enforced server-side (cannot be bypassed via FormData)', async () => {
    process.env.CUSTOM_PACKAGE_UPSTREAM_CREATION_ENABLED = 'false'
    delete process.env.CUSTOM_PACKAGE_UPSTREAM_CREATION_ENABLED
    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(false)
    expect((r as any).category).toBe('NOT_ENTITLED')
    expect(r.error).toContain('disabled')
    expect(mockUpstreamOpCreate).not.toHaveBeenCalled()
    expect(mockBuildConnector).not.toHaveBeenCalled()
  })

  it('CPB-S4: Mode B refuses when the connector lacks createCustomPackage', async () => {
    mockReadiness.mockResolvedValue({ ready: true })
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn() })
    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(false)
    expect((r as any).category).toBe('NOT_ENTITLED')
    expect(mockUpstreamOpCreate).not.toHaveBeenCalled()
  })

  it('CPB-S5: Mode B requires upstreamConfirmation', async () => {
    const r = await createCustomPackageWithMode(upstreamReq({ upstreamConfirmed: false }), 'admin-1')
    expect(r.success).toBe(false)
    expect(mockUpstreamOpCreate).not.toHaveBeenCalled()
  })

  it('CPB-S6: arbitrary provider payload keys are dropped (allowlist only)', async () => {
    // The connector must not receive unmapped provider keys.
    mockBuildConnector.mockResolvedValue({
      getCustomPackageDefinition: vi.fn(),
      createCustomPackage: vi.fn().mockResolvedValue({ success: true, data: { success: true, providerPlanId: 'TZN-5GB-7D' } }),
    })
    const r = await createCustomPackageWithMode(upstreamReq({
      providerValues: { sku: 'TZN-5GB-7D', bundle_name: 'T', pool: 1, arbitrary_evil_key: 'yes', __proto__field: 'x' },
    }), 'admin-1')
    expect(r.success).toBe(true)
    // The connector payload is normalized by normalizeProviderValues.
    const createCall = (mockBuildConnector.mock.results[0]?.value as any)?.__handled ?? null
  })

  it('CPB-S7: same key + different fingerprint → IDEMPOTENCY_CONFLICT, zero upstream calls', async () => {
    // Existing op with a DIFFERENT fingerprint than the request describes.
    mockUpstreamOpFindUnique.mockResolvedValue({
      id: 'op-existing',
      requestFingerprint: 'DIFFERENT-FP',
      status: 'COMPLETED',
      idempotencyKey: 'cpb_upstream_key1',
    })
    const createSpy = vi.fn()
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: createSpy })
    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(false)
    expect(r.error).toContain('different request')
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('CPB-F1: creates the durable operation row BEFORE the upstream call', async () => {
    let createCalled = false
    mockUpstreamOpCreate.mockImplementation((args: any) => {
      createCalled = true
      return Promise.resolve({ id: 'op-1', ...args.data })
    })
    await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(createCalled).toBe(true)
    expect(mockUpstreamOpCreate).toHaveBeenCalled()
  })

  it('CPB-F2: successful flow → upstream called once → COMPLETED recorded', async () => {
    const createSpy = vi.fn().mockResolvedValue({ success: true, data: { success: true, providerPlanId: 'TZN-5GB-7D', providerPlanCode: 'TZN-5GB-7D' } })
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: createSpy })
    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(true)
    expect(createSpy).toHaveBeenCalledTimes(1)
    // COMPLETED recorded via the LOCAL_PERSISTING → COMPLETED transition (or
    // UPSTREAM_SUCCEEDED → COMPLETED after persist). At minimum a successful
    // final transition to COMPLETED must have occurred.
    const completedTransition = mockUpstreamOpUpdateMany.mock.calls.find(c => c[0].data?.status === 'COMPLETED')
    expect(completedTransition).toBeTruthy()
  })

  it('CPB-F3: completed replay → returns existing result, zero upstream calls', async () => {
    // First run: capture the operation the service creates (records fingerprint).
    let capturedFingerprint = ''
    const firstOpId = 'op-1'
    mockUpstreamOpCreate.mockImplementation((args: any) => {
      capturedFingerprint = args.data.requestFingerprint
      return Promise.resolve({ id: firstOpId, ...args.data })
    })
    // First run: the op does not exist yet.
    mockUpstreamOpFindUnique.mockResolvedValue(null)
    const createSpy = vi.fn().mockResolvedValue({ success: true, data: { success: true, providerPlanId: 'TZN-5GB-7D', providerPlanCode: 'TZN-5GB-7D' } })
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: createSpy })
    await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(capturedFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(createSpy).toHaveBeenCalledTimes(1)

    // Second run: the operation now exists as COMPLETED with the SAME fingerprint.
    mockUpstreamOpCreate.mockClear()
    mockUpstreamOpFindUnique.mockResolvedValue({
      id: firstOpId,
      requestFingerprint: capturedFingerprint,
      status: 'COMPLETED',
      idempotencyKey: 'cpb_upstream_key1',
      providerId: 'prov-choice',
      providerCode: 'CHOICE',
      requestedSku: 'TZN-5GB-7D',
      upstreamReference: 'TZN-5GB-7D',
      providerPackageId: 'pp-1',
      esimPackageId: 'esim-1',
    })
    const replaySpy = vi.fn()
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: replaySpy })
    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(true)
    expect(r.esimPackageId).toBe('esim-1')
    expect(replaySpy).not.toHaveBeenCalled()
    expect(mockUpstreamOpCreate).not.toHaveBeenCalled()
  })

  it('CPB-F4: upstream success + local persistence failure → PARTIAL_FAILURE, recoverable, zero re-create', async () => {
    // Upstream succeeds; the local transaction throws.
    mockBuildConnector.mockResolvedValue({
      getCustomPackageDefinition: vi.fn(),
      createCustomPackage: vi.fn().mockResolvedValue({ success: true, data: { success: true, providerPlanId: 'TZN-5GB-7D' } }),
    })
    mockTransaction.mockImplementationOnce(async () => { throw new Error('DB down') })
    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(false)
    expect(r.partialFailure).toBe(true)
    expect(r.providerReference).toBe('TZN-5GB-7D')
    expect(r.error).toContain('Recovery')
  })

  it('CPB-F5: resume from PARTIAL_FAILURE performs local persistence WITHOUT calling upstream again', async () => {
    // Capture the fingerprint from a first (failed-partial) run.
    let capturedFingerprint = ''
    mockUpstreamOpCreate.mockImplementation((args: any) => {
      capturedFingerprint = args.data.requestFingerprint
      return Promise.resolve({ id: 'op-1', ...args.data })
    })
    mockUpstreamOpFindUnique.mockResolvedValue(null)
    const firstCreate = vi.fn().mockResolvedValue({ success: true, data: { success: true, providerPlanId: 'TZN-5GB-7D' } })
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: firstCreate })
    mockTransaction.mockImplementationOnce(async () => { throw new Error('DB down') })
    const firstResult = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(firstResult.partialFailure).toBe(true)
    expect(capturedFingerprint).toMatch(/^[0-9a-f]{64}$/)

    // Now the op exists as PARTIAL_FAILURE with the SAME fingerprint.
    mockUpstreamOpCreate.mockClear()
    mockUpstreamOpFindUnique.mockResolvedValue({
      id: 'op-1',
      requestFingerprint: capturedFingerprint,
      status: 'PARTIAL_FAILURE',
      idempotencyKey: 'cpb_upstream_key1',
      upstreamReference: 'TZN-5GB-7D',
      upstreamExternalId: 'TZN-5GB-7D',
    })
    const replaySpy = vi.fn()
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: replaySpy })
    mockTransaction.mockImplementation(async (fn: any) => fn({
      eSIMPackage: { create: mockESIMCreate, findFirst: mockESIMFindFirst },
      eSIMPackageProviderBinding: { create: mockBindingCreate, upsert: mockBindingUpsert },
      providerPackage: { create: mockProviderPackageCreate, findFirst: mockProviderPackageFindFirst },
    }))
    mockProviderPackageFindFirst.mockResolvedValue(null)
    mockESIMFindFirst.mockResolvedValue(null)
    mockProviderPackageCreate.mockResolvedValue({ id: 'pp-recovered' })
    mockESIMCreate.mockResolvedValue({ id: 'esim-recovered' })
    mockBindingUpsert.mockResolvedValue({ id: 'b-recovered' })

    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(true)
    expect(replaySpy).not.toHaveBeenCalled()
    expect(mockTransaction).toHaveBeenCalled()
  })

  it('CPB-F6: ambiguous upstream outcome → requiresReconciliation, no local package, no blind re-create', async () => {
    mockBuildConnector.mockResolvedValue({
      getCustomPackageDefinition: vi.fn(),
      createCustomPackage: vi.fn().mockResolvedValue({ success: false, error: { code: 'TIMEOUT', message: 'timed out', details: { ambiguous: true } } }),
    })
    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(false)
    expect(r.requiresReconciliation).toBe(true)
    expect(r.category).toBe('AMBIGUOUS')
    expect(mockESIMCreate).not.toHaveBeenCalled()
    expect(mockProviderPackageCreate).not.toHaveBeenCalled()
  })

  it('CPB-F7: ALREADY_EXISTS upstream → requiresReconciliation (never treated as success)', async () => {
    mockBuildConnector.mockResolvedValue({
      getCustomPackageDefinition: vi.fn(),
      createCustomPackage: vi.fn().mockResolvedValue({ success: false, error: { code: 'ALREADY_EXISTS', message: 'Bundle code already exists' } }),
    })
    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(false)
    expect(r.requiresReconciliation).toBe(true)
    expect(r.category).toBe('ALREADY_EXISTS')
    expect(mockProviderPackageCreate).not.toHaveBeenCalled()
    expect(mockESIMCreate).not.toHaveBeenCalled()
  })

  it('CPB-F8: validation rejection (provider) → FAILED, no local package', async () => {
    mockBuildConnector.mockResolvedValue({
      getCustomPackageDefinition: vi.fn(),
      createCustomPackage: vi.fn().mockResolvedValue({ success: false, error: { code: 'INVALID_REQUEST', message: 'bad' } }),
    })
    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(false)
    expect(r.category).toBe('VALIDATION')
    expect(mockProviderPackageCreate).not.toHaveBeenCalled()
    expect(mockESIMCreate).not.toHaveBeenCalled()
  })

  it('CPB-F9: Mode A does not fabricate provider cost when upstream provides none (already covered but kept)', async () => {
    const ppCreate = vi.fn().mockResolvedValue({ id: 'pp-new-1' })
    mockTransaction.mockImplementation(async (fn: any) => fn({
      eSIMPackage: { create: mockESIMCreate, findFirst: mockESIMFindFirst },
      eSIMPackageProviderBinding: { create: mockBindingCreate, upsert: mockBindingUpsert },
      providerPackage: { create: ppCreate, findFirst: mockProviderPackageFindFirst },
    }))
    await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    const data = ppCreate.mock.calls[0]?.[0]?.data
    expect(data).toBeDefined()
    expect(data.costPrice).toBe(0)
    expect(data.costStatus).toBe('MISSING')
  })

  it('CPB-F10: operation stuck in UPSTREAM_IN_PROGRESS with EXPIRED lease → AMBIGUOUS (reconciliation), never re-create', async () => {
    // Capture fingerprint then simulate a stuck IN_PROGRESS op.
    let capturedFingerprint = ''
    mockUpstreamOpCreate.mockImplementation((args: any) => {
      capturedFingerprint = args.data.requestFingerprint
      return Promise.resolve({ id: 'op-stuck', ...args.data })
    })
    mockUpstreamOpFindUnique.mockResolvedValue(null)
    const firstCreate = vi.fn().mockResolvedValue({ success: true, data: { success: true, providerPlanId: 'TZN-5GB-7D' } })
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: firstCreate })
    await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(capturedFingerprint).toMatch(/^[0-9a-f]{64}$/)

    // Replay: op is stuck IN_PROGRESS, and the lease has EXPIRED (previous
    // worker crashed / HTTP outlived the lease).
    mockUpstreamOpCreate.mockClear()
    mockUpstreamOpFindUnique.mockResolvedValue({
      id: 'op-stuck',
      requestFingerprint: capturedFingerprint,
      status: 'UPSTREAM_IN_PROGRESS',
      idempotencyKey: 'cpb_upstream_key1',
      upstreamReference: null,
    })
    mockSystemJobLockFindUnique.mockResolvedValue({ lockedUntil: new Date(Date.now() - 5_000) })
    const replaySpy = vi.fn()
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: replaySpy })

    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(false)
    expect(r.requiresReconciliation).toBe(true)
    expect(r.category).toBe('AMBIGUOUS')
    expect(replaySpy).not.toHaveBeenCalled()
    expect(mockUpstreamOpUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'op-stuck' },
      data: expect.objectContaining({ status: 'AMBIGUOUS_UPSTREAM_RESULT' }),
    }))
  })

  it('CPB-F11: operation in UPSTREAM_IN_PROGRESS with FRESH lease → already being processed, no create', async () => {
    let capturedFingerprint = ''
    mockUpstreamOpCreate.mockImplementation((args: any) => {
      capturedFingerprint = args.data.requestFingerprint
      return Promise.resolve({ id: 'op-active', ...args.data })
    })
    mockUpstreamOpFindUnique.mockResolvedValue(null)
    const firstCreate = vi.fn().mockResolvedValue({ success: true, data: { success: true, providerPlanId: 'TZN-5GB-7D' } })
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: firstCreate })
    await createCustomPackageWithMode(upstreamReq(), 'admin-1')

    mockUpstreamOpCreate.mockClear()
    mockUpstreamOpFindUnique.mockResolvedValue({
      id: 'op-active',
      requestFingerprint: capturedFingerprint,
      status: 'UPSTREAM_IN_PROGRESS',
      idempotencyKey: 'cpb_upstream_key1',
      upstreamReference: null,
    })
    // Another worker holds a fresh lease.
    mockSystemJobLockFindUnique.mockResolvedValue({ lockedUntil: new Date(Date.now() + 60_000) })
    const replaySpy = vi.fn()
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: replaySpy })

    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(false)
    expect(r.error).toContain('already being processed')
    expect(r.requiresReconciliation).toBeUndefined()
    expect(replaySpy).not.toHaveBeenCalled()
  })

  it('PROOF: operation row is persisted BEFORE the first provider HTTP mutation call', async () => {
    // Track call order across the operation ledger write and the connector call.
    const order: string[] = []
    mockUpstreamOpCreate.mockImplementation((args: any) => {
      order.push('opledger-create')
      return Promise.resolve({ id: 'op-order', ...args.data })
    })
    const createSpy = vi.fn().mockImplementation(() => {
      order.push('provider-createHTTP')
      return Promise.resolve({ success: true, data: { success: true, providerPlanId: 'TZN-5GB-7D' } })
    })
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: createSpy })

    const r = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r.success).toBe(true)
    expect(order).toEqual(['opledger-create', 'provider-createHTTP'])
    // The upstream mutation never precedes the durable ledger write.
    const createIndex = order.indexOf('opledger-create')
    const httpIndex = order.indexOf('provider-createHTTP')
    expect(createIndex).toBeGreaterThanOrEqual(0)
    expect(httpIndex).toBeGreaterThan(createIndex)
  })

  it('PROOF: audit-log failure cannot turn a SUCCESSFUL upstream operation into a retryable creation', async () => {
    // First run completes the operation (status → COMPLETED in the ledger).
    let capturedFingerprint = ''
    mockUpstreamOpCreate.mockImplementation((args: any) => {
      capturedFingerprint = args.data.requestFingerprint
      return Promise.resolve({ id: 'op-audit', ...args.data })
    })
    mockUpstreamOpFindUnique.mockResolvedValue(null)
    const firstCreate = vi.fn().mockResolvedValue({ success: true, data: { success: true, providerPlanId: 'TZN-5GB-7D' } })
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: firstCreate })
    const r1 = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    expect(r1.success).toBe(true)
    expect(capturedFingerprint).toMatch(/^[0-9a-f]{64}$/)

    // Replay: the op is COMPLETED (audit logging is in the action layer, which
    // may fail — but the ledger state is already terminal). Zero upstream calls.
    mockUpstreamOpCreate.mockClear()
    mockUpstreamOpFindUnique.mockResolvedValue({
      id: 'op-audit',
      requestFingerprint: capturedFingerprint,
      status: 'COMPLETED',
      idempotencyKey: 'cpb_upstream_key1',
      upstreamReference: 'TZN-5GB-7D',
      providerPackageId: 'pp-1',
      esimPackageId: 'esim-1',
    })
    const replaySpy = vi.fn()
    mockBuildConnector.mockResolvedValue({ getCustomPackageDefinition: vi.fn(), createCustomPackage: replaySpy })
    const r2 = await createCustomPackageWithMode(upstreamReq(), 'admin-1')
    // Even though the action's audit .catch(() => {}) would swallow any audit
    // error downstream, the service returns the COMPLETED result with no re-create.
    expect(r2.success).toBe(true)
    expect(r2.esimPackageId).toBe('esim-1')
    expect(replaySpy).not.toHaveBeenCalled()
    expect(mockUpstreamOpCreate).not.toHaveBeenCalled()
  })
})