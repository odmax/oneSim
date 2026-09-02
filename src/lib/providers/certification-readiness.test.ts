import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrismaDb = vi.hoisted(() => ({
  provider: { findUnique: vi.fn(), findFirst: vi.fn() },
  providerPackage: { findMany: vi.fn() },
  eSIMPackage: { findFirst: vi.fn() },
  business: { findUnique: vi.fn(), findFirst: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({ prisma: mockPrismaDb }))

import { prisma } from '@/lib/prisma'
import { providerCertificationReadiness, classifyBaseHost } from './certification-readiness'
import { classifyProviderEndpointClass, classifyOneSIMEnvironment } from './certification-readiness'
import { resolveProviderCertificationConfig } from './certification-config'

const mock = vi.mocked(prisma)

function providerRow(over: Record<string, any> = {}) {
  return {
    id: 'prov-airhub-test', code: 'AIRHUB', name: 'AirHub Staging',
    status: 'TESTING', environment: 'staging',
    apiBaseUrl: 'https://api-staging.airhubapp.com',
    apiToken: 'enc:fake-staging-token',
    config: { partnerCode: '1234', upstreamEnvironment: 'staging', authEnvironmentAtAuth: 'staging' },
    ...over,
  }
}

function packageRow(over: Record<string, any> = {}) {
  return {
    id: 'pp-test-1', providerPlanId: 'TEST-AIRHUB-1', name: 'AirHub Test Plan',
    costPrice: 0, sellingPrice: 1, currency: 'USD', costStatus: 'VALID', pricingStatus: 'READY',
    publishStatus: 'PUBLISHED', configurationStatus: 'CONFIGURED',
    activePriceSnapshotId: 'snap-1', isAvailable: true,
    ...over,
  }
}

function businessRow(over: Record<string, any> = {}) {
  return { id: 'biz-cert-1', status: 'APPROVED', walletBalance: 10, ...over }
}

function setupValid(over: {
  provider?: Record<string, any>
  pkg?: Record<string, any>
  business?: Record<string, any>
} = {}) {
  mock.provider.findFirst.mockResolvedValue(providerRow(over.provider))
  mock.provider.findUnique.mockResolvedValue(providerRow(over.provider))
  mock.providerPackage.findMany.mockResolvedValue([packageRow(over.pkg)])
  mock.eSIMPackage.findFirst.mockResolvedValue({ priceUSD: 1, isActive: true })
  mock.business.findUnique.mockResolvedValue(businessRow(over.business))
  mock.business.findFirst.mockResolvedValue(businessRow(over.business))
}

beforeEach(() => { vi.clearAllMocks() })

describe('provider certification readiness preflight', () => {
  it('fully valid staging fixture → READY', async () => {
    setupValid()
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 4, appEnv: 'staging', businessId: 'biz-cert-1', packageId: 'TEST-AIRHUB-1' })
    expect(r.readiness).toBe('READY')
    expect(r.gates.environment).toBe('PASS')
    expect(r.gates.auth).toBe('PASS')
    expect(r.gates.package).toBe('PASS')
    expect(r.gates.business).toBe('PASS')
    expect(r.gates.provider).toBe('PASS')
    expect(r.gates.budget).toBe('PASS')
    expect(r.testPackage?.classification).toBe('EXPLICIT_TEST_PLAN')
    expect(r.blockers).toEqual([])
  })

  it('production-like upstream → BLOCKED (environment gate)', async () => {
    setupValid({ provider: { apiBaseUrl: 'https://api.airhubapp.com', config: { partnerCode: 'x', upstreamEnvironment: 'production' } } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 4, appEnv: 'staging' })
    expect(r.readiness).toBe('BLOCKED')
    expect(r.gates.environment).toBe('FAIL')
    expect(r.baseHostClass).toBe('PRODUCTION_LIKE')
    expect(r.blockers.some((b) => b.includes('upstream'))).toBe(true)
  })

  it('APP_ENV=production → BLOCKED (even with staged host)', async () => {
    setupValid()
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 4, appEnv: 'production' })
    expect(r.gates.environment).toBe('FAIL')
    expect(r.readiness).toBe('BLOCKED')
  })

  it('unknown/unprovable host → BLOCKED', () => {
    expect(classifyBaseHost('https://example.com', 'staging')).toBe('UNKNOWN')
  })

  it('production metadata WINS over a misleading staging hostname → PRODUCTION_LIKE/BLOCKED', () => {
    // Host looks like staging/test, but upstreamEnvironment=production must win.
    expect(classifyBaseHost('https://staging-names-node.something.net', 'production')).toBe('PRODUCTION_LIKE')
    expect(classifyBaseHost('https://api-test.example.com', 'production')).toBe('PRODUCTION_LIKE')
    expect(classifyBaseHost('https://sandbox.example.com', undefined, 'production')).toBe('PRODUCTION_LIKE')
    // Authentic staging stays STAGING_SAFE once production metadata is absent.
    expect(classifyBaseHost('https://api-staging.airhubapp.com', 'staging', 'staging')).toBe('STAGING_SAFE')
  })

  it('missing credentials → BLOCKED (auth gate)', async () => {
    setupValid({ provider: { apiToken: null, config: { partnerCode: 'x', upstreamEnvironment: 'staging' } } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 1, appEnv: 'staging', packageId: 'pp-test-1' })
    expect(r.gates.auth).toBe('FAIL')
    expect(r.blockers.some((b) => b.toLowerCase().includes('auth'))).toBe(true)
  })

  it('no safe test package → BLOCKED (package gate)', async () => {
    setupValid({ pkg: { providerPlanId: 'PROD-AIRHUB-99', name: 'Commercial 5GB', costPrice: 12, sellingPrice: 20 } })
    mock.eSIMPackage.findFirst.mockResolvedValue(null)
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 1, appEnv: 'staging' })
    expect(r.gates.package).toBe('FAIL')
    expect(r.blockers.some((b) => b.includes('test package'))).toBe(true)
  })

  it('operator-approved (non-test-labelled) package with valid pricing → LOW_COST_OPERATOR_APPROVED and PASSES', async () => {
    setupValid({ pkg: { providerPlanId: 'AH-555', name: '5GB', costPrice: 1, sellingPrice: 2 } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 1, appEnv: 'staging', packageId: 'pp-test-1' })
    expect(r.testPackage?.classification).toBe('LOW_COST_OPERATOR_APPROVED')
    expect(r.gates.package).toBe('PASS')
  })

  it('business PENDING → BLOCKED (business gate)', async () => {
    setupValid({ business: { status: 'PENDING', walletBalance: 10 } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 1, appEnv: 'staging', packageId: 'pp-test-1' })
    expect(r.gates.business).toBe('FAIL')
    expect(r.businessReady).toBe(false)
  })

  it('insufficient wallet → BLOCKED (business gate)', async () => {
    setupValid({ business: { status: 'APPROVED', walletBalance: 0.5 } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 1, appEnv: 'staging', packageId: 'pp-test-1' })
    expect(r.gates.business).toBe('FAIL')
  })

  it('provider DISABLED → BLOCKED (provider gate)', async () => {
    setupValid({ provider: { status: 'DISABLED' } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 1, appEnv: 'staging', packageId: 'pp-test-1' })
    expect(r.gates.provider).toBe('FAIL')
  })

  it('purchase capability absent → BLOCKED (provider gate)', async () => {
    setupValid({ provider: { config: { upstreamEnvironment: 'staging' } } }) // no PURCHASE in enabledCapabilities/defaults for code=TEST? code AIRHUB defaults include PURCHASE, so strip via enabledCapabilities
    // Force no purchase capability: use a code with no defaults and no enabledCapabilities.
    mock.provider.findFirst.mockResolvedValue(providerRow({ code: 'NEWVENDOR', config: { upstreamEnvironment: 'staging' }, enabledCapabilities: ['STATUS'] }))
    mock.provider.findUnique.mockResolvedValue(providerRow({ code: 'NEWVENDOR', config: { upstreamEnvironment: 'staging' }, enabledCapabilities: ['STATUS'] }))
    const r = await providerCertificationReadiness({ provider: 'NEWVENDOR', maxRealPurchases: 1, appEnv: 'staging', packageId: 'pp-test-1' })
    expect(r.gates.provider).toBe('FAIL')
  })

  it('MAX_REAL_PURCHASES=0 → BLOCKED (budget gate)', async () => {
    setupValid()
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 0, appEnv: 'staging', packageId: 'pp-test-1' })
    expect(r.gates.budget).toBe('FAIL')
    expect(r.readiness).toBe('BLOCKED')
  })

  it('defaults budget to 0 when omitted → BLOCKED on budget', async () => {
    setupValid()
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', appEnv: 'staging', packageId: 'pp-test-1' })
    expect(r.maxRealPurchases).toBe(0)
    expect(r.gates.budget).toBe('FAIL')
  })
})

// ─────────────────────────────────────────────────────────────
// Phase 6.5 (V2) certification readiness matrix — cases A–T
// ─────────────────────────────────────────────────────────────

/** A typed authorization block for a CONTROLLED_LIVE_TEST (safe fields only). */
function liveAuthz(over: Record<string, any> = {}) {
  return {
    type: 'CONTROLLED_LIVE_TEST',
    approvedAt: '2026-01-01T00:00:00Z',
    approvedBy: 'OP-7',
    evidenceReference: 'TICKET-987',
    approvedPackageIds: ['TEST-AIRHUB-1'],
    maxRealPurchases: 2,
    maxProviderSpend: 10,
    ...over,
  }
}

/** A LIVE provider (documented production host + explicit production metadata). */
function liveProvider(over: Record<string, any> = {}, cert: Record<string, any> = {}) {
  return providerRow({
    apiBaseUrl: 'https://api.airhubapp.com',
    config: {
      partnerCode: '1234',
      upstreamEnvironment: 'production',
      authEnvironmentAtAuth: 'production',
      certification: { allowedModes: ['CONTROLLED_LIVE_TEST'], testAuthorization: liveAuthz(), ...cert },
    },
    ...over,
  })
}

/** A READY controlled-live call hit (provider pinning honoured, budget set). */
function setupLiveValid(over: { provider?: Record<string, any>; pkg?: Record<string, any>; business?: Record<string, any> } = {}) {
  mock.provider.findFirst.mockResolvedValue(liveProvider(over.provider))
  mock.provider.findUnique.mockResolvedValue(liveProvider(over.provider))
  mock.providerPackage.findMany.mockResolvedValue([packageRow(over.pkg)])
  mock.eSIMPackage.findFirst.mockResolvedValue({ priceUSD: 1, isActive: true })
  mock.business.findUnique.mockResolvedValue(businessRow(over.business))
  mock.business.findFirst.mockResolvedValue(businessRow(over.business))
}

describe('V2 provider certification readiness (Phase 6.5)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('A: SANDBOX endpoint + budget → READY, V2 fields populated (onesim/endpoint/mode separate)', async () => {
    setupValid()
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 4, appEnv: 'staging', businessId: 'biz-cert-1', packageId: 'TEST-AIRHUB-1' })
    expect(r.readiness).toBe('READY')
    expect(r.onesimEnvironment).toBe('STAGING')
    expect(r.providerEndpointClass).toBe('SANDBOX')
    expect(r.certificationMode).toBe('SANDBOX')
    expect(r.gates.authorization).toBe('PASS')
    expect(r.gates.spend).toBe('PASS')
    expect(r.gates.resource).toBe('PASS')
  })

  it('B: classification helpers separate OneSIM env from endpoint class', () => {
    expect(classifyOneSIMEnvironment('staging')).toBe('STAGING')
    expect(classifyOneSIMEnvironment('test')).toBe('TEST')
    expect(classifyOneSIMEnvironment('production')).toBe('PRODUCTION')
    expect(classifyOneSIMEnvironment(undefined)).toBe('UNKNOWN')
    expect(classifyProviderEndpointClass('https://api-staging.airhubapp.com', 'staging', 'staging')).toBe('SANDBOX')
    expect(classifyProviderEndpointClass('https://api.airhubapp.com', 'production', 'production')).toBe('LIVE')
    // Production metadata WINS over a misleading staging hostname.
    expect(classifyProviderEndpointClass('https://staging-names-node.net', 'production')).toBe('LIVE')
    // Bare staging metadata with no convincing host does NOT certify SANDBOX (fail closed).
    expect(classifyProviderEndpointClass('https://example.com', 'staging')).toBe('UNKNOWN')
  })

  it('C: CONTROLLED_LIVE_TEST with typed authorization + spend guard → READY', async () => {
    setupLiveValid({ pkg: { costPrice: 2 } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', businessId: 'biz-cert-1', packageId: 'TEST-AIRHUB-1' })
    expect(r.certificationMode).toBe('CONTROLLED_LIVE_TEST')
    expect(r.providerEndpointClass).toBe('LIVE')
    expect(r.testAuthorizationPresent).toBe(true)
    expect(r.gates.authorization).toBe('PASS')
    expect(r.gates.resource).toBe('PASS')
    expect(r.gates.spend).toBe('PASS')
    expect(r.maximumExposure).toBe(4) // 2 purchases × 2 cost
    expect(r.maxProviderSpend).toBe(10)
    expect(r.approvedResourceId).toBe('pp-test-1')
    expect(r.readiness).toBe('READY')
  })

  it('D: LIVE provider WITHOUT authorization → BLOCKED (authorization gate, mode UNKNOWN)', async () => {
    // LIVE endpoint but config carries NO testAuthorization (and no cert block at all).
    mock.provider.findFirst.mockResolvedValue(providerRow({
      apiBaseUrl: 'https://api.airhubapp.com',
      config: { partnerCode: '1234', upstreamEnvironment: 'production', authEnvironmentAtAuth: 'production' },
    }))
    mock.provider.findUnique.mockResolvedValue(providerRow({
      apiBaseUrl: 'https://api.airhubapp.com',
      config: { partnerCode: '1234', upstreamEnvironment: 'production', authEnvironmentAtAuth: 'production' },
    }))
    mock.providerPackage.findMany.mockResolvedValue([packageRow({ costPrice: 2 })])
    mock.eSIMPackage.findFirst.mockResolvedValue({ priceUSD: 1, isActive: true })
    mock.business.findUnique.mockResolvedValue(businessRow())
    mock.business.findFirst.mockResolvedValue(businessRow())
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', packageId: 'TEST-AIRHUB-1' })
    expect(r.providerEndpointClass).toBe('LIVE')
    expect(r.certificationMode).toBe('UNKNOWN')
    expect(r.gates.authorization).toBe('FAIL')
    expect(r.gates.environment).toBe('FAIL')
    expect(r.readiness).toBe('BLOCKED')
  })

  it('E: TEST name/label alone must NOT authorize CONTROLLED_LIVE_TEST (endpoint not provably sandbox) → BLOCKED', async () => {
    setupValid({ provider: { name: 'X (Test)', apiBaseUrl: 'https://example.com', config: { upstreamEnvironment: 'staging', authEnvironmentAtAuth: 'staging' } } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', packageId: 'TEST-AIRHUB-1' })
    expect(r.providerEndpointClass).toBe('UNKNOWN')
    expect(r.certificationMode).toBe('UNKNOWN')
    expect(r.readiness).toBe('BLOCKED')
    expect(r.gates.environment).toBe('FAIL')
  })

  it('F: "(Staging)" provider name alone stays SANDBOX (never silently LIVE)', async () => {
    setupValid({ provider: { name: 'AirHub (Staging)' } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', packageId: 'TEST-AIRHUB-1' })
    expect(r.providerEndpointClass).toBe('SANDBOX')
    expect(r.certificationMode).toBe('SANDBOX')
    expect(r.readiness).toBe('READY')
  })

  it('G: spend guard — exposure exceeds maxProviderSpend → BLOCKED', async () => {
    setupLiveValid({ pkg: { costPrice: 10 } }) // 2 × 10 = 20 > maxProviderSpend 10
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', packageId: 'TEST-AIRHUB-1' })
    expect(r.gates.spend).toBe('FAIL')
    expect(r.maximumExposure).toBe(20)
    expect(r.blockers.some((b) => b.includes('exceeds maxProviderSpend'))).toBe(true)
    expect(r.readiness).toBe('BLOCKED')
  })

  it('H: spend guard — unknown package cost → BLOCKED (no exposure computed)', async () => {
    setupLiveValid({ pkg: { costPrice: null, costStatus: 'MISSING' } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', packageId: 'TEST-AIRHUB-1' })
    expect(r.gates.spend).toBe('FAIL')
    expect(r.blockers.some((b) => b.includes('cost is unknown'))).toBe(true)
  })

  it('I: spend guard — unknown currency → BLOCKED (no FX guessing)', async () => {
    setupLiveValid({ pkg: { costPrice: 2, currency: null } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', packageId: 'TEST-AIRHUB-1' })
    expect(r.gates.spend).toBe('FAIL')
    expect(r.blockers.some((b) => b.includes('currency is unknown'))).toBe(true)
  })

  it('J: OneSIM PRODUCTION + valid sandbox → BLOCKED (ONESIM_PRODUCTION_CERTIFICATION_ALLOWED=NO)', async () => {
    setupValid()
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'production', packageId: 'TEST-AIRHUB-1' })
    expect(r.onesimEnvironment).toBe('PRODUCTION')
    expect(r.gates.environment).toBe('FAIL')
    expect(r.readiness).toBe('BLOCKED')
  })

  it('K: OneSIM STAGING + LIVE + authorization → READY (same surface as C)', async () => {
    setupLiveValid({ pkg: { costPrice: 2 } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', packageId: 'TEST-AIRHUB-1' })
    expect(r.onesimEnvironment).toBe('STAGING')
    expect(r.certificationMode).toBe('CONTROLLED_LIVE_TEST')
    expect(r.readiness).toBe('READY')
  })

  it('L: provider with ranked/failover alternates → BLOCKED (provider pinning)', async () => {
    setupLiveValid({ provider: { config: { partnerCode: '1234', upstreamEnvironment: 'production', rankedProviders: [{ providerId: 'prov-other' }], certification: { allowedModes: ['CONTROLLED_LIVE_TEST'], testAuthorization: liveAuthz() } } }, pkg: { costPrice: 2 } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', packageId: 'TEST-AIRHUB-1' })
    expect(r.blockers.some((b) => b.includes('ranked/failover'))).toBe(true)
    expect(r.gates.resource).toBe('FAIL')
    expect(r.readiness).toBe('BLOCKED')
  })

  it('M: pinned approved package NOT in authorization ids → BLOCKED (resource pinning)', async () => {
    setupLiveValid({ pkg: { costPrice: 2 } })
    mock.provider.findFirst.mockResolvedValue(liveProvider(undefined, { testAuthorization: liveAuthz({ approvedPackageIds: ['OTHER-UNRELATED'] }) }))
    mock.provider.findUnique.mockResolvedValue(liveProvider(undefined, { testAuthorization: liveAuthz({ approvedPackageIds: ['OTHER-UNRELATED'] }) }))
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', packageId: 'TEST-AIRHUB-1' })
    expect(r.gates.resource).toBe('FAIL')
    expect(r.readiness).toBe('BLOCKED')
  })

  it('N: SANDBOX endpoint with stray authorization never upgrades to LIVE → SANDBOX', async () => {
    setupValid({ provider: { config: { partnerCode: '1234', upstreamEnvironment: 'staging', authEnvironmentAtAuth: 'staging', certification: { allowedModes: ['CONTROLLED_LIVE_TEST'], testAuthorization: liveAuthz() } } } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', packageId: 'TEST-AIRHUB-1' })
    expect(r.providerEndpointClass).toBe('SANDBOX')
    expect(r.certificationMode).toBe('SANDBOX')
    expect(r.readiness).toBe('READY')
  })

  it('O: "_productionUrlPending" endpoint is LIVE (not test) → without authorization BLOCKED', async () => {
    setupValid({ provider: { name: 'AirHub Staging', apiBaseUrl: 'https://_productionUrlPending.example.com/v1', config: { partnerCode: '1234', upstreamEnvironment: 'production' } } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', packageId: 'TEST-AIRHUB-1' })
    expect(r.providerEndpointClass).toBe('LIVE')
    expect(r.certificationMode).toBe('UNKNOWN')
    expect(r.readiness).toBe('BLOCKED')
  })

  it('P: APP_ENV unset → OneSIM UNKNOWN → BLOCKED', async () => {
    setupValid()
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, packageId: 'TEST-AIRHUB-1' })
    expect(r.onesimEnvironment).toBe('UNKNOWN')
    expect(r.gates.environment).toBe('FAIL')
    expect(r.readiness).toBe('BLOCKED')
  })

  it('Q: OneSIM PRODUCTION wins even WITH live authorization → BLOCKED', async () => {
    setupLiveValid({ pkg: { costPrice: 2 } })
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'production', packageId: 'TEST-AIRHUB-1' })
    expect(r.onesimEnvironment).toBe('PRODUCTION')
    expect(r.certificationMode).toBe('CONTROLLED_LIVE_TEST')
    expect(r.gates.environment).toBe('FAIL')
    expect(r.readiness).toBe('BLOCKED')
  })

  it('R: OneSIM PRODUCTION + sandbox → BLOCKED on environment', async () => {
    setupValid()
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'prod', packageId: 'TEST-AIRHUB-1' })
    expect(r.onesimEnvironment).toBe('PRODUCTION')
    expect(r.readiness).toBe('BLOCKED')
  })

  it('S: provider not found → BLOCKED', async () => {
    mock.provider.findFirst.mockResolvedValue(null)
    mock.provider.findUnique.mockResolvedValue(null)
    const r = await providerCertificationReadiness({ provider: 'NOPE', maxRealPurchases: 2, appEnv: 'staging' })
    expect(r.blockers.some((b) => b.includes('provider not found'))).toBe(true)
    expect(r.readiness).toBe('BLOCKED')
  })

  it('T: output never surfaces secret/token/evidence raw values', async () => {
    setupLiveValid({ provider: { apiToken: 'SUPERSECRETLIVETOKEN' }, pkg: { costPrice: 2 } })
    mock.provider.findFirst.mockResolvedValue(liveProvider({ apiToken: 'SUPERSECRETLIVETOKEN' }))
    mock.provider.findUnique.mockResolvedValue(liveProvider({ apiToken: 'SUPERSECRETLIVETOKEN' }))
    const r = await providerCertificationReadiness({ provider: 'AIRHUB', maxRealPurchases: 2, appEnv: 'staging', packageId: 'TEST-AIRHUB-1' })
    const serialized = JSON.stringify(r)
    expect(serialized.includes('SUPERSECRETLIVETOKEN')).toBe(false)
    expect(serialized.includes('TICKET-987')).toBe(true) // safe evidenceReference (ticket ref) MAY appear
  })

  it('config normalization: invalid authorization fails closed (absent)', () => {
    const cfg = resolveProviderCertificationConfig({ config: { certification: { allowedModes: ['CONTROLLED_LIVE_TEST'], testAuthorization: { type: 'CONTROLLED_LIVE_TEST', approvedAt: '', approvedBy: '', evidenceReference: '', approvedPackageIds: [], maxRealPurchases: 0, maxProviderSpend: 0 } } } })
    expect(cfg.testAuthorization).toBeUndefined()
    expect(cfg.allowedModes).toEqual(['CONTROLLED_LIVE_TEST'])
  })
})