import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findMany: vi.fn(), findUnique: vi.fn() },
    providerPackage: { findMany: vi.fn() },
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  isProviderOperational: vi.fn((s: string) => ['ACTIVE', 'DEGRADED', 'TESTING'].includes(s)),
}))

vi.mock('@/lib/services/providers/provider-balance', () => ({
  getProviderBalance: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { getProviderBalance } from '@/lib/services/providers/provider-balance'
import { ProviderRoutingEngine } from '@/lib/services/routing/provider-routing-engine'

const mockPrisma = vi.mocked(prisma)

describe('ProviderRoutingEngine', () => {
  let engine: ProviderRoutingEngine

  beforeEach(() => {
    vi.clearAllMocks()
    engine = new ProviderRoutingEngine()
  })

  function mockProviders(providers: any[]) {
    mockPrisma.provider.findMany.mockResolvedValue(providers as any)
  }

  it('returns single provider when only one eligible', async () => {
    mockProviders([{ id: 'p1', name: 'Choice', code: 'CHOICE', status: 'ACTIVE', errorCount: 0, priority: 0 }])
    const result = await engine.selectBestProvider({})
    expect(result.success).toBe(true)
    expect(result.selected?.providerName).toBe('Choice')
  })

  it('returns error when no eligible providers', async () => {
    mockProviders([])
    const result = await engine.selectBestProvider({})
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('ranks providers by score', async () => {
    mockProviders([
      { id: 'p1', name: 'Choice', code: 'CHOICE', status: 'ACTIVE', errorCount: 0, priority: 1, lastSuccessfulConnection: new Date(), activationSuccessRate: 0.95, averageActivationTimeMs: 500 },
      { id: 'p2', name: 'AirHub', code: 'AIRHUB', status: 'ACTIVE', errorCount: 5, priority: 10, lastFailedConnection: new Date(), activationSuccessRate: 0.5, averageActivationTimeMs: 5000 },
    ])
    const result = await engine.selectBestProvider({})
    expect(result.success).toBe(true)
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates![0].providerName).toBe('Choice')
    expect(result.candidates![1].providerName).toBe('AirHub')
  })

  it('returns preferred provider when specified', async () => {
    mockProviders([{ id: 'p1', name: 'Choice', code: 'CHOICE', status: 'ACTIVE', errorCount: 0, priority: 0 }])
    mockPrisma.provider.findUnique.mockResolvedValue({ id: 'p1', name: 'Choice', code: 'CHOICE', status: 'ACTIVE' } as any)
    const result = await engine.selectBestProvider({ preferredProviderId: 'p1' })
    expect(result.success).toBe(true)
    expect(result.selected?.providerId).toBe('p1')
  })

  it('includes price scoring when packageId is provided', async () => {
    mockProviders([
      { id: 'p1', name: 'Cheap', code: 'C1', status: 'ACTIVE', errorCount: 0, priority: 0 },
      { id: 'p2', name: 'Expensive', code: 'C2', status: 'ACTIVE', errorCount: 0, priority: 0 },
    ])
    mockPrisma.providerPackage.findMany.mockResolvedValue([
      { providerId: 'p1', costPrice: { toString: () => '5' } },
      { providerId: 'p2', costPrice: { toString: () => '20' } },
    ] as any)
    const result = await engine.selectBestProvider({ packageId: 'pkg-1' })
    expect(result.success).toBe(true)
    expect(result.candidates![0].providerName).toBe('Cheap')
  })

  it('scores stale/unhealthy providers lower', async () => {
    mockProviders([
      { id: 'p1', name: 'Healthy', code: 'H', status: 'ACTIVE', errorCount: 0, lastSuccessfulConnection: new Date(), priority: 0 },
      { id: 'p2', name: 'Down', code: 'D', status: 'ACTIVE', errorCount: 15, lastFailedConnection: new Date(), priority: 0 },
    ])
    const result = await engine.selectBestProvider({})
    expect(result.candidates![0].providerName).toBe('Healthy')
    expect(result.candidates![1].providerName).toBe('Down')
  })
})
