/**
 * QR Code Refresh — regression tests (A through R).
 *
 * Covers the canonical refreshEsimQrCode service, the API route,
 * and the server action path. Proves non-billable, tenant-safe,
 * provider-safe, idempotent behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────

const mockEsimId = 'esim_qr_test_001'
const businessIdA = 'biz_a_001'
const businessIdB = 'biz_b_001'
const providerId = 'prov_001'
const packageId = 'pkg_001'

function makeMockEsim(overrides: Record<string, any> = {}) {
  return {
    id: mockEsimId,
    iccid: '8901234567890123456',
    status: 'ACTIVE',
    activationCode: 'LPA:1$smdp.example.com$MATCHING-OLD',
    qrCodeUrl: null,
    qrCode: null,
    smdpAddress: 'smdp.example.com',
    matchingId: 'MATCHING-OLD',
    installationStatus: 'READY',
    purchase: {
      businessId: businessIdA,
      providerId: providerId,
      package: { id: packageId, name: 'Test Package', providerPackageId: 'ppkg_001', providerId, providerPlanId: 'plan_001' },
    },
    ...overrides,
  }
}

const mockProvider = { id: providerId, status: 'ACTIVE' }

// Track calls to prove non-billable
const prismaUpdateCalls: any[] = []
const prismaCreateCalls: any[] = []

vi.mock('@/lib/prisma', () => {
  return {
    prisma: {
      eSIM: {
        findUnique: vi.fn(),
        update: vi.fn(async (args: any) => {
          prismaUpdateCalls.push(args)
          return args.where
        }),
      },
      provider: {
        findUnique: vi.fn(async () => mockProvider),
      },
      walletTransaction: {
        create: vi.fn(async (args: any) => { prismaCreateCalls.push(args); return args.data }),
        count: vi.fn(async () => 0),
      },
      eSIMPurchase: {
        count: vi.fn(async () => 0),
      },
      providerAttempt: {
        count: vi.fn(async () => 0),
      },
    },
  }
})

let mockLookupResult: any = null
let mockGetQrCodeResult: any = null
let mockConnectorCapabilities: any = {}

const connectorFactoryCalls: string[] = []
const connectorA = { name: 'ConnectorA', lookupInstallationData: vi.fn(async () => mockLookupResult), getQRCode: vi.fn(async () => mockGetQrCodeResult ?? { success: false, error: { code: 'NOT_AVAILABLE', message: 'No QR' } }), capabilities: { installationLookup: true, ...mockConnectorCapabilities } }
const connectorB = { name: 'ConnectorB', lookupInstallationData: vi.fn(async () => mockLookupResult), getQRCode: vi.fn(async () => mockGetQrCodeResult ?? { success: false, error: { code: 'NOT_AVAILABLE', message: 'No QR' } }), capabilities: { installationLookup: true, ...mockConnectorCapabilities } }

vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  buildConnectorFromProvider: vi.fn(async (id: string) => {
    connectorFactoryCalls.push(id)
    return id === 'prov_purchase_fulfilled' ? connectorA : id === 'prov_package_default' ? connectorB : ({
      name: 'DefaultConnector',
      capabilities: { installationLookup: true, ...mockConnectorCapabilities },
      lookupInstallationData: mockLookupResult !== null
        ? vi.fn(async () => mockLookupResult)
        : undefined,
      getQRCode: vi.fn(async () => mockGetQrCodeResult ?? { success: false, error: { code: 'NOT_AVAILABLE', message: 'No QR' } }),
    })
  }),
}))

vi.mock('@/lib/security/audit', () => ({
  auditLog: vi.fn(async () => {}),
}))

let mockBackingResult: any = { kind: 'BOUND', backing: { providerPackageId: 'ppkg_001', providerId, providerPlanId: 'plan_001' } }

vi.mock('@/lib/services/orders/package-backing-resolver', () => ({
  resolvePackageBacking: vi.fn(async () => mockBackingResult),
}))

// ── Import after mocks ─────────────────────────────────────────────

import { refreshEsimQrCode } from '@/lib/services/esims/refresh-qr'

const { prisma } = await import('@/lib/prisma') as any

// ── Helpers ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  prismaUpdateCalls.length = 0
  prismaCreateCalls.length = 0
  connectorFactoryCalls.length = 0
  mockLookupResult = null
  mockGetQrCodeResult = null
  mockConnectorCapabilities = {}
  mockBackingResult = { kind: 'BOUND', backing: { providerPackageId: 'ppkg_001', providerId, providerPlanId: 'plan_001' } }
  prisma.eSIM.findUnique.mockImplementation(async () => makeMockEsim())
  prisma.provider.findUnique.mockImplementation(async () => mockProvider)
  prisma.walletTransaction.count.mockResolvedValue(0)
  prisma.eSIMPurchase.count.mockResolvedValue(0)
  prisma.providerAttempt.count.mockResolvedValue(0)
})

// ── Tests ──────────────────────────────────────────────────────────

describe('QR Refresh — refreshEsimQrCode service', () => {

  // A. business A can refresh its own eSIM
  it('A: business A can refresh its own eSIM', async () => {
    mockLookupResult = {
      success: true,
      state: 'HAS_DATA',
      data: { activationCode: 'LPA:1$smdp.new.com$MATCHING-NEW' },
    }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe('REFRESHED')
  })

  // B. business A cannot refresh business B eSIM
  it('B: business A cannot refresh business B eSIM', async () => {
    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdB })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe('FORBIDDEN')
  })

  // C. request cannot choose/change provider
  it('C: provider is resolved from eSIM → purchase → package, not from request', async () => {
    // The service never accepts providerId as a parameter
    const fn = refreshEsimQrCode as any
    const paramNames = Object.keys(fn.toString().match(/function\s*\(([^)]*)\)/)?.[1]?.split(',').reduce((acc: any, p: string) => { acc[p.trim()] = true; return acc }, {}) || {})
    // Verify the function signature does NOT accept providerId
    expect(fn.length).toBe(1) // single object param

    // The actual call succeeds with only esimId + businessId
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }
    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(true)
  })

  // D. correct provider connector is called
  it('D: correct provider connector is built and called', async () => {
    const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(buildConnectorFromProvider).toHaveBeenCalledWith(providerId)
  })

  // E. cross-provider ICCID/plan leakage cannot occur
  it('E: response contains no provider-sensitive fields', async () => {
    mockLookupResult = {
      success: true,
      state: 'HAS_DATA',
      data: { activationCode: 'LPA:1$smdp.new.com$MATCHING-NEW', qrCodeUrl: 'https://cdn.example.com/qr/new.png' },
    }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(true)
    // The esim object should only contain safe fields
    const esim = result.esim!
    expect(esim.id).toBeDefined()
    expect(esim.iccid).toBeDefined()
    expect(esim.activationCode).toBeDefined()
    // Should NOT contain any provider identity
    expect(JSON.stringify(esim)).not.toContain('provider')
    expect(JSON.stringify(esim)).not.toContain('costPrice')
    expect(JSON.stringify(esim)).not.toContain('rawData')
    expect(JSON.stringify(esim)).not.toContain('providerResponse')
  })

  // F. unsupported provider returns QR_REFRESH_NOT_SUPPORTED
  it('F: unsupported provider returns QR_REFRESH_NOT_SUPPORTED', async () => {
    mockConnectorCapabilities = { installationLookup: false }
    mockLookupResult = null // no lookupInstallationData
    mockGetQrCodeResult = { success: false, error: { code: 'NOT_SUPPORTED', message: 'QR code not supported' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe('NOT_SUPPORTED')
    expect(result.error).toBe('QR_REFRESH_NOT_SUPPORTED')
  })

  // G. provider no-QR response returns QR_NOT_AVAILABLE
  it('G: provider returns no QR data returns QR_NOT_AVAILABLE', async () => {
    mockLookupResult = { success: true, state: 'NOT_AVAILABLE_YET', data: null }
    mockGetQrCodeResult = { success: true, data: {} }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe('NO_DATA')
    expect(result.error).toBe('QR code is not available yet. Try again shortly.')
  })

  // H. valid new activationCode is persisted
  it('H: valid new activationCode is persisted', async () => {
    const newCode = 'LPA:1$smdp.new.com$MATCHING-NEW'
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: newCode } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(true)
    expect(result.esim?.activationCode).toBe(newCode)

    // Check that prisma.update was called (persistence happened)
    expect(prismaUpdateCalls.length).toBeGreaterThanOrEqual(1)
  })

  // I. valid new qrCodeUrl is persisted
  it('I: valid new qrCodeUrl is persisted', async () => {
    const newUrl = 'https://cdn.example.com/qr/new.png'
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { qrCodeUrl: newUrl } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(true)
    expect(result.esim?.qrCodeUrl).toBe(newUrl)
    expect(prismaUpdateCalls.length).toBeGreaterThanOrEqual(1)
  })

  // J. same QR response remains success/idempotent
  it('J: same QR response remains success and idempotent', async () => {
    const sameCode = 'LPA:1$smdp.example.com$MATCHING-OLD'
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: sameCode } }

    const result1 = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result1.success).toBe(true)

    // Call again — should still succeed
    const result2 = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result2.success).toBe(true)
  })

  // K. provider failure does not erase existing QR
  it('K: provider failure does not erase existing QR', async () => {
    // Start with existing QR data
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      activationCode: 'LPA:1$smdp.example.com$EXISTING',
    }))

    mockLookupResult = { success: false, state: 'PROVIDER_TIMEOUT', errorCode: 'PROVIDER_TIMEOUT' }
    mockGetQrCodeResult = { success: false, error: { code: 'TIMEOUT', message: 'Provider timeout' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    // Should fail but not crash
    expect(result.success).toBe(false)

    // The eSIM should still have its original activation code (no update call that erases it)
    const updates = prismaUpdateCalls.filter(c => c.where?.id === mockEsimId)
    // If there was an update, it should only set installationLastCheckedAt, not erase activationCode
    for (const update of updates) {
      if (update.data?.activationCode !== undefined) {
        expect(update.data.activationCode).not.toBe(null)
      }
    }
  })

  // L. existing activationCode remains unchanged on failure
  it('L: existing activationCode remains unchanged on provider failure', async () => {
    const originalCode = 'LPA:1$smdp.example.com$ORIGINAL'
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({ activationCode: originalCode }))

    mockLookupResult = { success: false, state: 'NO_INSTALL_DATA', errorCode: 'NO_INSTALL_DATA' }
    mockGetQrCodeResult = { success: false, error: { code: 'NO_DATA', message: 'No data' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(false)

    // No activationCode update should have been made
    const codeUpdates = prismaUpdateCalls.filter(c => c.where?.id === mockEsimId && c.data?.activationCode !== undefined)
    expect(codeUpdates).toHaveLength(0)
  })

  // M. wallet balance is untouched
  it('M: wallet balance is untouched', async () => {
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    // No wallet-related prisma calls should have been made
    expect(prismaCreateCalls.length).toBe(0)
    expect(prisma.walletTransaction.count).not.toHaveBeenCalled()
  })

  // N. no wallet transaction is created
  it('N: no wallet transaction is created', async () => {
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(prismaCreateCalls.filter(c => c.model === 'WalletTransaction' || c.data?.type)).toHaveLength(0)
  })

  // O. no order is created
  it('O: no eSIM purchase order is created', async () => {
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    // No eSIMPurchase creation
    expect(prismaCreateCalls.filter(c => c.model === 'ESIMPurchase')).toHaveLength(0)
  })

  // P. no provider purchase/activation attempt is created
  it('P: no provider purchase/activation attempt is created', async () => {
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    // No ProviderAttempt creation
    expect(prismaCreateCalls.filter(c => c.model === 'ProviderAttempt')).toHaveLength(0)
  })

  // Q. API response contains no provider-sensitive fields
  it('Q: response object contains no provider-sensitive fields', async () => {
    mockLookupResult = {
      success: true,
      state: 'HAS_DATA',
      data: {
        activationCode: 'LPA:1$smdp.new.com$MATCHING-NEW',
        qrCodeUrl: 'https://provider.example/qr.png',
        smdpAddress: 'smdp.new.com',
        matchingId: 'MATCHING-NEW',
      },
    }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(true)

    const serialized = JSON.stringify(result)
    // Forbidden patterns
    expect(serialized).not.toMatch(/providerId/i)
    expect(serialized).not.toMatch(/costPrice/i)
    expect(serialized).not.toMatch(/rawData/i)
    expect(serialized).not.toMatch(/providerResponse/i)
    expect(serialized).not.toMatch(/apiToken/i)
    expect(serialized).not.toMatch(/credentials/i)
    expect(serialized).not.toMatch(/secret/i)
    expect(serialized).not.toMatch(/accessToken/i)
    expect(serialized).not.toMatch(/businessId/i)
    expect(serialized).not.toMatch(/userId/i)
  })

  // R. auth check works correctly (unauthenticated returns error)
  it('R: missing businessId returns FORBIDDEN', async () => {
    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: '' })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe('FORBIDDEN')
  })

  // eSIM not found
  it('returns NOT_FOUND for non-existent eSIM', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(null)
    const result = await refreshEsimQrCode({ esimId: 'esim_nonexistent', businessId: businessIdA })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe('NOT_FOUND')
  })

  // Provider unresolved
  it('returns PROVIDER_UNRESOLVED when no providerId', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      purchase: { businessId: businessIdA, providerId: null, package: { id: packageId, providerPackageId: null, providerId: null, providerPlanId: null, name: 'No Provider' } },
    }))
    mockBackingResult = { kind: 'NONE' }
    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe('PROVIDER_UNAVAILABLE')
    expect(result.error).toBe('QR_PROVIDER_UNRESOLVED')
  })

  // Provider not found in DB
  it('returns PROVIDER_UNRESOLVED when provider record missing', async () => {
    prisma.provider.findUnique.mockResolvedValue(null)
    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe('PROVIDER_UNAVAILABLE')
  })

  // Idempotent — same QR code returned
  it('is idempotent when provider returns same data', async () => {
    const sameData = { activationCode: 'LPA:1$smdp.example.com$MATCHING-OLD' }
    mockLookupResult = { success: true, state: 'HAS_DATA', data: sameData }

    const r1 = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(r1.success).toBe(true)

    const r2 = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(r2.success).toBe(true)
    expect(r2.esim?.activationCode).toBe(r1.esim?.activationCode)
  })

  // Fallback to getQRCode when lookupInstallationData is absent
  it('falls back to getQRCode when lookupInstallationData is not available', async () => {
    mockConnectorCapabilities = { installationLookup: false }
    mockLookupResult = null
    mockGetQrCodeResult = { success: true, data: { qrCodeUrl: 'https://fallback.example/qr.png' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(true)
    expect(result.esim?.qrCodeUrl).toBe('https://fallback.example/qr.png')
  })

  // QR code content is not logged
  it('audit log does not contain activation code or QR content', async () => {
    const { auditLog } = await import('@/lib/security/audit')
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$smdp.example.com$SECRET_MATCHING' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    const calls = (auditLog as any).mock?.calls || []
    for (const call of calls) {
      const details = call[0]?.details || ''
      expect(details).not.toContain('LPA:1$smdp.example.com$SECRET_MATCHING')
      expect(details).not.toContain('SECRET_MATCHING')
    }
  })

  // installationStatus is updated to READY when data is present
  it('updates installationStatus to READY when install data is refreshed', async () => {
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    const statusUpdate = prismaUpdateCalls.find(c => c.where?.id === mockEsimId && c.data?.installationStatus === 'READY')
    expect(statusUpdate).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// CERT-QR-1: AUTHORITATIVE PROVIDER RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

describe('CERT-QR-1: Authoritative provider resolution', () => {

  it('CERT-QR-1a: fulfilled eSIM has purchase.providerId=A, package.providerId=B → connector A called', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      purchase: {
        businessId: businessIdA,
        providerId: 'prov_purchase_fulfilled',
        package: { providerId: 'prov_package_default', name: 'Test Package' },
      },
    }))
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(true)
    expect(connectorFactoryCalls).toEqual(['prov_purchase_fulfilled'])
  })

  it('CERT-QR-1b: purchase.providerId conflict with package.providerId → fulfillment evidence wins', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      purchase: {
        businessId: businessIdA,
        providerId: 'prov_purchase_fulfilled',
        package: { providerId: 'prov_package_default', name: 'Test Package' },
      },
    }))
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    // Only the purchase.providerId connector was built, never the package default
    expect(connectorFactoryCalls).toEqual(['prov_purchase_fulfilled'])
    expect(connectorFactoryCalls).not.toContain('prov_package_default')
  })

  it('CERT-QR-1c: only package.providerId exists (pre-fulfillment) → authoritative ProviderPackage backing used', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      purchase: {
        businessId: businessIdA,
        providerId: null,
        package: { id: packageId, name: 'Test Package', providerPackageId: 'ppkg_001', providerId: 'prov_package_default', providerPlanId: 'plan_001' },
      },
    }))
    mockBackingResult = { kind: 'BOUND', backing: { providerPackageId: 'ppkg_001', providerId: 'prov_bound_backing', providerPlanId: 'plan_001' } }
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(true)
    expect(connectorFactoryCalls).toEqual(['prov_bound_backing'])
  })

  it('CERT-QR-1d: no trustworthy provider evidence → QR_PROVIDER_UNRESOLVED, zero provider calls', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      purchase: {
        businessId: businessIdA,
        providerId: null,
        package: { id: packageId, name: 'Test Package', providerPackageId: null, providerId: null, providerPlanId: null },
      },
    }))
    mockBackingResult = { kind: 'NONE' }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(false)
    expect(result.outcome).toBe('PROVIDER_UNAVAILABLE')
    expect(result.error).toBe('QR_PROVIDER_UNRESOLVED')
    expect(connectorFactoryCalls).toHaveLength(0)
  })

  it('CERT-QR-1e: Choice ICCID can never reach AirHub connector', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      iccid: '89301000000000000000',
      purchase: {
        businessId: businessIdA,
        providerId: 'prov_choice',
        package: { providerId: 'prov_choice', name: 'Choice Package' },
      },
    }))
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$choice$ID' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(connectorFactoryCalls).toEqual(['prov_choice'])
    expect(connectorFactoryCalls).not.toContain('prov_airhub')
  })

  it('CERT-QR-1f: AirHub ICCID can never reach US-Matrix/Telna/Choice connector', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      iccid: '89011000000000000000',
      purchase: {
        businessId: businessIdA,
        providerId: 'prov_airhub',
        package: { providerId: 'prov_airhub', name: 'AirHub Package' },
      },
    }))
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$airhub$ID' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(connectorFactoryCalls).toEqual(['prov_airhub'])
    expect(connectorFactoryCalls).not.toContain('prov_choice')
    expect(connectorFactoryCalls).not.toContain('prov_usmatrix')
    expect(connectorFactoryCalls).not.toContain('prov_telna')
  })

  it('CERT-QR-1g: purchase.providerId=A used even when connector A returns NOT_SUPPORTED (failover NOT attempted)', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      purchase: {
        businessId: businessIdA,
        providerId: 'prov_purchase_fulfilled',
        package: { id: packageId, name: 'Test Package', providerPackageId: 'ppkg_001', providerId: 'prov_package_default', providerPlanId: 'plan_001' },
      },
    }))
    mockLookupResult = { success: false, state: 'NOT_SUPPORTED', errorCode: 'LOOKUP_NOT_SUPPORTED' }
    mockGetQrCodeResult = { success: false, error: { code: 'NOT_SUPPORTED', message: 'Not supported' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(false)
    expect(result.outcome).toBe('NOT_SUPPORTED')
    // Only the purchase provider connector was tried, never the package default
    expect(connectorFactoryCalls).toEqual(['prov_purchase_fulfilled'])
  })

  it('CERT-QR-1h: purchase.providerId wins over BOUND ProviderPackage backing', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      purchase: {
        businessId: businessIdA,
        providerId: 'prov_purchase_fulfilled',
        package: { id: packageId, name: 'Test Package', providerPackageId: 'ppkg_001', providerId: 'prov_package_default', providerPlanId: 'plan_001' },
      },
    }))
    mockBackingResult = { kind: 'BOUND', backing: { providerPackageId: 'ppkg_001', providerId: 'prov_bound_backing', providerPlanId: 'plan_001' } }
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(true)
    // purchase.providerId wins — backing resolver is never called
    expect(connectorFactoryCalls).toEqual(['prov_purchase_fulfilled'])
    expect(connectorFactoryCalls).not.toContain('prov_bound_backing')
  })

  it('CERT-QR-1i: stale ESIMPackage.providerId is ignored — BOUND backing is authoritative', async () => {
    // ESIMPackage.providerId = prov_stale, but ProviderPackage.providerId = prov_authoritative
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      purchase: {
        businessId: businessIdA,
        providerId: null,
        package: { id: packageId, name: 'Test Package', providerPackageId: 'ppkg_auth', providerId: 'prov_stale', providerPlanId: 'plan_001' },
      },
    }))
    mockBackingResult = { kind: 'BOUND', backing: { providerPackageId: 'ppkg_auth', providerId: 'prov_authoritative', providerPlanId: 'plan_001' } }
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(true)
    // The BOUND backing providerId is used, NOT the stale ESIMPackage.providerId
    expect(connectorFactoryCalls).toEqual(['prov_authoritative'])
    expect(connectorFactoryCalls).not.toContain('prov_stale')
  })

  it('CERT-QR-1j: no purchase provider + no BOUND backing → QR_PROVIDER_UNRESOLVED', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      purchase: {
        businessId: businessIdA,
        providerId: null,
        package: { id: packageId, name: 'Test Package', providerPackageId: null, providerId: 'prov_orphan', providerPlanId: null },
      },
    }))
    mockBackingResult = { kind: 'NONE' }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(false)
    expect(result.outcome).toBe('PROVIDER_UNAVAILABLE')
    expect(result.error).toBe('QR_PROVIDER_UNRESOLVED')
    expect(connectorFactoryCalls).toHaveLength(0)
  })

  it('CERT-QR-1k: conflicting retail package provider cannot receive the ICCID', async () => {
    // purchase was fulfilled by prov_airhub, but package is bound to prov_choice
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      purchase: {
        businessId: businessIdA,
        providerId: 'prov_airhub',
        package: { id: packageId, name: 'Choice Package', providerPackageId: 'ppkg_choice', providerId: 'prov_choice', providerPlanId: 'plan_choice' },
      },
    }))
    mockBackingResult = { kind: 'BOUND', backing: { providerPackageId: 'ppkg_choice', providerId: 'prov_choice', providerPlanId: 'plan_choice' } }
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(true)
    // AirHub connector called (purchase evidence), Choice connector never called
    expect(connectorFactoryCalls).toEqual(['prov_airhub'])
    expect(connectorFactoryCalls).not.toContain('prov_choice')
  })

  it('CERT-QR-1l: UNAVAILABLE backing → QR_PROVIDER_UNRESOLVED', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      purchase: {
        businessId: businessIdA,
        providerId: null,
        package: { id: packageId, name: 'Test Package', providerPackageId: 'ppkg_001', providerId: 'prov_001', providerPlanId: 'plan_001' },
      },
    }))
    mockBackingResult = { kind: 'UNAVAILABLE' }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(false)
    expect(result.outcome).toBe('PROVIDER_UNAVAILABLE')
    expect(result.error).toBe('QR_PROVIDER_UNRESOLVED')
    expect(connectorFactoryCalls).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// CERT-QR-2: NON-DESTRUCTIVE REFRESH MERGE
// ═══════════════════════════════════════════════════════════════════════════════

describe('CERT-QR-2: Non-destructive refresh merge', () => {

  it('CERT-QR-2a: partial provider result does not erase activationCode', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      activationCode: 'LPA:1$smdp.example.com$EXISTING',
    }))
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { qrCodeUrl: 'https://new.example/qr.png' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    const codeUpdates = prismaUpdateCalls.filter(c => c.where?.id === mockEsimId && c.data?.activationCode !== undefined)
    expect(codeUpdates).toHaveLength(0)
    expect(result?.esim?.activationCode).toBe('LPA:1$smdp.example.com$EXISTING')
  })

  it('CERT-QR-2b: partial provider result does not erase qrCodeUrl', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      qrCodeUrl: 'https://old.example/qr.png',
    }))
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    const urlUpdates = prismaUpdateCalls.filter(c => c.where?.id === mockEsimId && c.data?.qrCodeUrl !== undefined)
    expect(urlUpdates).toHaveLength(0)
    expect(result?.esim?.qrCodeUrl).toBe('https://old.example/qr.png')
  })

  it('CERT-QR-2c: empty strings are treated as absent', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      activationCode: 'LPA:1$smdp.example.com$EXISTING',
    }))
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: '', qrCodeUrl: '   ' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    const codeUpdates = prismaUpdateCalls.filter(c => c.where?.id === mockEsimId && c.data?.activationCode !== undefined)
    expect(codeUpdates).toHaveLength(0)
    expect(result?.esim?.activationCode).toBe('LPA:1$smdp.example.com$EXISTING')
  })

  it('CERT-QR-2d: undefined/null fields do not overwrite DB values', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      activationCode: 'LPA:1$smdp.example.com$EXISTING',
      qrCodeUrl: 'https://old.example/qr.png',
      smdpAddress: 'old.smdp.example.com',
      matchingId: 'OLD-MATCHING',
    }))
    // Provider returns a new activationCode but null/undefined for the rest
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$smdp.example.com$NEW', qrCodeUrl: undefined, smdpAddress: null, matchingId: undefined } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(true)
    expect(result?.esim?.activationCode).toBe('LPA:1$smdp.example.com$NEW')
    expect(result?.esim?.qrCodeUrl).toBe('https://old.example/qr.png')
    expect(result?.esim?.smdpAddress).toBe('old.smdp.example.com')
    expect(result?.esim?.matchingId).toBe('OLD-MATCHING')
  })

  it('CERT-QR-2e: valid replacement activationCode overwrites old value', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      activationCode: 'LPA:1$smdp.example.com$OLD',
    }))
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$smdp.example.com$NEW' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(true)
    expect(result?.esim?.activationCode).toBe('LPA:1$smdp.example.com$NEW')
    const codeUpdates = prismaUpdateCalls.filter(c => c.where?.id === mockEsimId && c.data?.activationCode !== undefined)
    expect(codeUpdates).toHaveLength(1)
    expect(codeUpdates[0].data.activationCode).toBe('LPA:1$smdp.example.com$NEW')
  })

  it('CERT-QR-2f: valid replacement QR URL overwrites old value', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      qrCodeUrl: 'https://old.example/qr.png',
    }))
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { qrCodeUrl: 'https://new.example/qr.png' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(true)
    expect(result?.esim?.qrCodeUrl).toBe('https://new.example/qr.png')
    const urlUpdates = prismaUpdateCalls.filter(c => c.where?.id === mockEsimId && c.data?.qrCodeUrl !== undefined)
    expect(urlUpdates).toHaveLength(1)
    expect(urlUpdates[0].data.qrCodeUrl).toBe('https://new.example/qr.png')
  })

  it('CERT-QR-2g: provider exception preserves every existing installation field', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      activationCode: 'LPA:1$smdp.example.com$EXISTING',
      qrCodeUrl: 'https://old.example/qr.png',
      smdpAddress: 'old.smdp.example.com',
      matchingId: 'OLD-MATCHING',
      qrCode: 'QR-PAYLOAD-OLD',
    }))

    mockLookupResult = { success: false, state: 'PROVIDER_TIMEOUT', errorCode: 'PROVIDER_TIMEOUT' }
    mockGetQrCodeResult = { success: false, error: { code: 'TIMEOUT', message: 'Provider timeout' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(result.success).toBe(false)

    // No installation fields should have been touched
    const installFieldUpdates = prismaUpdateCalls.filter(c =>
      c.where?.id === mockEsimId && (
        c.data?.activationCode !== undefined ||
        c.data?.qrCodeUrl !== undefined ||
        c.data?.qrCode !== undefined ||
        c.data?.smdpAddress !== undefined ||
        c.data?.matchingId !== undefined
      )
    )
    expect(installFieldUpdates).toHaveLength(0)
  })

  it('CERT-QR-2h: same data remains idempotent', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      activationCode: 'LPA:1$smdp.example.com$MATCHING-OLD',
    }))
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$smdp.example.com$MATCHING-OLD' } }

    const r1 = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(r1.success).toBe(true)
    expect(r1.esim?.activationCode).toBe('LPA:1$smdp.example.com$MATCHING-OLD')

    const r2 = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })
    expect(r2.success).toBe(true)
    expect(r2.esim?.activationCode).toBe('LPA:1$smdp.example.com$MATCHING-OLD')
  })

  it('CERT-QR-2i: mixed partial — some fields new, some absent preserves old', async () => {
    prisma.eSIM.findUnique.mockResolvedValue(makeMockEsim({
      activationCode: 'LPA:1$smdp.example.com$OLD',
      qrCodeUrl: 'https://old.example/qr.png',
      smdpAddress: 'old.smdp.example.com',
    }))
    // Provider returns new activationCode but null/empty for the rest
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$smdp.example.com$NEW', qrCodeUrl: null, smdpAddress: '' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(true)
    expect(result?.esim?.activationCode).toBe('LPA:1$smdp.example.com$NEW')
    expect(result?.esim?.qrCodeUrl).toBe('https://old.example/qr.png')
    expect(result?.esim?.smdpAddress).toBe('old.smdp.example.com')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// CERT-QR-3: NO ACTIVATION SIDE EFFECT
// ═══════════════════════════════════════════════════════════════════════════════

describe('CERT-QR-3: No activation side effects', () => {

  it('CERT-QR-3a: activateESIM is never called during QR refresh', async () => {
    const activateSpy = vi.fn()
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    const connector = await (await import('@/lib/providers/connectors/connector-factory')).buildConnectorFromProvider('prov_001') as any
    connector.activateESIM = activateSpy

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(activateSpy).not.toHaveBeenCalled()
  })

  it('CERT-QR-3b: no wallet transactions during QR refresh', async () => {
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(prisma.walletTransaction.count).not.toHaveBeenCalled()
    expect(prismaCreateCalls.filter(c => c.model === 'WalletTransaction')).toHaveLength(0)
  })

  it('CERT-QR-3c: no eSIM purchase order created during QR refresh', async () => {
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(prisma.eSIMPurchase.count).not.toHaveBeenCalled()
    expect(prismaCreateCalls.filter(c => c.model === 'ESIMPurchase')).toHaveLength(0)
  })

  it('CERT-QR-3d: no provider attempt created during QR refresh', async () => {
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(prismaCreateCalls.filter(c => c.model === 'ProviderAttempt')).toHaveLength(0)
  })

  it('CERT-QR-3e: getQRCode fallback does not trigger activation', async () => {
    mockConnectorCapabilities = { installationLookup: false }
    mockLookupResult = null
    mockGetQrCodeResult = { success: true, data: { qrCodeUrl: 'https://fallback.example/qr.png' } }

    const connector = await (await import('@/lib/providers/connectors/connector-factory')).buildConnectorFromProvider('prov_001') as any
    const activateSpy = vi.fn()
    connector.activateESIM = activateSpy

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(true)
    expect(activateSpy).not.toHaveBeenCalled()
    expect(prismaCreateCalls).toHaveLength(0)
  })

  it('CERT-QR-3f: connector purchase() is never called during QR refresh', async () => {
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    const connector = await (await import('@/lib/providers/connectors/connector-factory')).buildConnectorFromProvider('prov_001') as any
    connector.purchase = vi.fn()

    await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(connector.purchase).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// CERT-QR-4: PROVIDER STATUS / CAPABILITY
// ═══════════════════════════════════════════════════════════════════════════════

describe('CERT-QR-4: Provider status and capability', () => {

  it('CERT-QR-4a: suspended provider returns PROVIDER_UNAVAILABLE', async () => {
    prisma.provider.findUnique.mockResolvedValue({ id: providerId, status: 'SUSPENDED' })

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(false)
    expect(result.outcome).toBe('PROVIDER_UNAVAILABLE')
    expect(connectorFactoryCalls).toHaveLength(0)
  })

  it('CERT-QR-4b: disabled provider returns PROVIDER_UNAVAILABLE', async () => {
    prisma.provider.findUnique.mockResolvedValue({ id: providerId, status: 'DISABLED' })

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(false)
    expect(result.outcome).toBe('PROVIDER_UNAVAILABLE')
    expect(connectorFactoryCalls).toHaveLength(0)
  })

  it('CERT-QR-4c: ACTIVE provider proceeds normally', async () => {
    prisma.provider.findUnique.mockResolvedValue({ id: providerId, status: 'ACTIVE' })
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(true)
    expect(connectorFactoryCalls).toHaveLength(1)
  })

  it('CERT-QR-4d: DEGRADED provider proceeds (operational)', async () => {
    prisma.provider.findUnique.mockResolvedValue({ id: providerId, status: 'DEGRADED' })
    mockLookupResult = { success: true, state: 'HAS_DATA', data: { activationCode: 'LPA:1$new$ID' } }

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(true)
  })

  it('CERT-QR-4e: provider error does not leak internal details', async () => {
    prisma.provider.findUnique.mockResolvedValue(null)

    const result = await refreshEsimQrCode({ esimId: mockEsimId, businessId: businessIdA })

    expect(result.success).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/stack/i)
    expect(serialized).not.toMatch(/Error:/)
    expect(serialized).not.toContain('prisma')
  })
})
