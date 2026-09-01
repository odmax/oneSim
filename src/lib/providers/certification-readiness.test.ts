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
    costPrice: 0, sellingPrice: 1, costStatus: 'VALID', pricingStatus: 'READY',
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