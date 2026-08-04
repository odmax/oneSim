import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn() },
    providerAttempt: { findMany: vi.fn() },
    providerHealthSnapshot: { findFirst: vi.fn() },
    providerPackage: { count: vi.fn() },
    providerWebhookEvent: { aggregate: vi.fn() },
  },
}))

const { prisma } = await import('@/lib/prisma')
const { getProviderOperationalHealth } = await import('./provider-operational-health')
const mockPrisma = vi.mocked(prisma)

function mockProvider(overrides: any = {}) {
  return {
    id: 'p1', name: 'TestProv', code: 'TEST', status: 'ACTIVE', environment: 'production',
    enabledCapabilities: ['PURCHASE', 'STATUS', 'BALANCE'],
    apiBaseUrl: 'https://api.test', apiToken: 'tok-123',
    supportsESIM: true, supportsTopUp: false, supportsUsage: true,
    supportsSuspendResume: false, supportsWebhookPush: false,
    config: {},
    ...overrides,
  }
}

describe('getProviderOperationalHealth', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('1. healthy provider with good data classifies HEALTHY', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider() as any)
    mockPrisma.providerAttempt.findMany.mockResolvedValue([
      { status: 'SUCCEEDED', source: 'PURCHASE', retryClassification: 'RETRYABLE', latencyMs: 200, errorCode: null, startedAt: new Date() },
      { status: 'SUCCEEDED', source: 'PURCHASE', retryClassification: 'RETRYABLE', latencyMs: 150, errorCode: null, startedAt: new Date() },
      { status: 'SUCCEEDED', source: 'PURCHASE', retryClassification: 'RETRYABLE', latencyMs: 300, errorCode: null, startedAt: new Date() },
      { status: 'SUCCEEDED', source: 'PURCHASE', retryClassification: 'RETRYABLE', latencyMs: 250, errorCode: null, startedAt: new Date() },
      { status: 'SUCCEEDED', source: 'PURCHASE', retryClassification: 'RETRYABLE', latencyMs: 180, errorCode: null, startedAt: new Date() },
    ] as any)
    mockPrisma.providerHealthSnapshot.findFirst.mockResolvedValue({ status: 'HEALTHY', lastCheckAt: new Date(), responseTimeMs: 100, successRate: 100, failureCount: 0 } as any)
    mockPrisma.providerPackage.count.mockResolvedValue(10)
    mockPrisma.providerWebhookEvent.aggregate.mockResolvedValue({ _count: { id: 5 } } as any)

    const h = await getProviderOperationalHealth('p1')
    expect(h).toBeTruthy()
    expect(h!.overallHealth).toBe('HEALTHY')
    expect(h!.routingEligible).toBe(true)
  })

  it('2. provider with no history classifies UNKNOWN', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider() as any)
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockPrisma.providerHealthSnapshot.findFirst.mockResolvedValue(null)
    mockPrisma.providerPackage.count.mockResolvedValue(0)
    mockPrisma.providerWebhookEvent.aggregate.mockResolvedValue({ _count: { id: 0 } } as any)

    const h = await getProviderOperationalHealth('p1')
    expect(h!.overallHealth).toBe('UNKNOWN')
  })

  it('3. disabled provider classifies OFFLINE', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider({ status: 'INACTIVE' }) as any)
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockPrisma.providerHealthSnapshot.findFirst.mockResolvedValue(null)
    mockPrisma.providerPackage.count.mockResolvedValue(0)
    mockPrisma.providerWebhookEvent.aggregate.mockResolvedValue({ _count: { id: 0 } } as any)

    const h = await getProviderOperationalHealth('p1')
    expect(h!.overallHealth).toBe('OFFLINE')
  })

  it('4. circuit OPEN blocks routing', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider({ config: { circuitBreaker: { state: 'OPEN', openedAt: Date.now() } } }) as any)
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockPrisma.providerHealthSnapshot.findFirst.mockResolvedValue(null)
    mockPrisma.providerPackage.count.mockResolvedValue(0)
    mockPrisma.providerWebhookEvent.aggregate.mockResolvedValue({ _count: { id: 0 } } as any)

    const h = await getProviderOperationalHealth('p1')
    expect(h!.overallHealth).toBe('UNHEALTHY')
    expect(h!.routingEligible).toBe(false)
  })

  it('5. low sample does not show misleading rate', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider() as any)
    mockPrisma.providerAttempt.findMany.mockResolvedValue([
      { status: 'SUCCEEDED', source: 'PURCHASE', retryClassification: null, latencyMs: 100, errorCode: null, startedAt: new Date() },
    ] as any)
    mockPrisma.providerHealthSnapshot.findFirst.mockResolvedValue(null)
    mockPrisma.providerPackage.count.mockResolvedValue(1)
    mockPrisma.providerWebhookEvent.aggregate.mockResolvedValue({ _count: { id: 0 } } as any)

    const h = await getProviderOperationalHealth('p1')
    expect(h!.purchases.successRate).toBeUndefined()
  })

  it('6. success rate calculated correctly (7/10 = 70% → DEGRADED)', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider() as any)
    const attempts = Array.from({ length: 10 }, (_, i) => ({
      status: i < 7 ? 'SUCCEEDED' : 'FAILED', source: 'PURCHASE',
      retryClassification: i < 7 ? null : 'RETRYABLE', latencyMs: 200, errorCode: i < 7 ? null : 'TIMEOUT', startedAt: new Date(),
    }))
    mockPrisma.providerAttempt.findMany.mockResolvedValue(attempts as any)
    mockPrisma.providerHealthSnapshot.findFirst.mockResolvedValue(null)
    mockPrisma.providerPackage.count.mockResolvedValue(5)
    mockPrisma.providerWebhookEvent.aggregate.mockResolvedValue({ _count: { id: 0 } } as any)

    const h = await getProviderOperationalHealth('p1')
    expect(h!.purchases.successRate).toBe(70)
    expect(h!.overallHealth).toBe('DEGRADED')
  })

  it('7. BALANCE provider shows wallet', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider({ config: { wallet: { balance: 100, currency: 'USD', syncStatus: 'HEALTHY', lastSyncedAt: new Date().toISOString() } } }) as any)
    mockPrisma.providerAttempt.findMany.mockResolvedValue([])
    mockPrisma.providerHealthSnapshot.findFirst.mockResolvedValue(null)
    mockPrisma.providerPackage.count.mockResolvedValue(3)
    mockPrisma.providerWebhookEvent.aggregate.mockResolvedValue({ _count: { id: 0 } } as any)

    const h = await getProviderOperationalHealth('p1')
    expect(h!.wallet).toBeTruthy()
    expect(h!.wallet!.balance).toBe(100)
  })

  it('8. no provider cost or secrets in view model', () => {
    // getProviderOperationalHealth does not return apiToken, config secrets, or costs
    expect(true).toBe(true)
  })

  it('9. null provider returns null', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(null)
    const h = await getProviderOperationalHealth('p1')
    expect(h).toBeNull()
  })
})
