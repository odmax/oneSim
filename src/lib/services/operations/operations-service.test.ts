import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { count: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    backgroundJob: { count: vi.fn() },
    eSIMPurchase: { count: vi.fn() },
    providerAttempt: { count: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { getOpsMetrics, getProviderHealthList } from '@/lib/services/operations/operations-service'

const mockPrisma = vi.mocked(prisma)

describe('Operations Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getOpsMetrics', () => {
    it('returns metrics aggregate', async () => {
      mockPrisma.provider.count.mockResolvedValue(3)
      mockPrisma.backgroundJob.count.mockResolvedValue(2)
      mockPrisma.eSIMPurchase.count.mockResolvedValue(50)
      mockPrisma.provider.aggregate.mockResolvedValue({ _avg: { averageActivationTimeMs: 250 } } as any)
      mockPrisma.providerAttempt.count.mockResolvedValue(100)

      const result = await getOpsMetrics()

      expect(result.providers.online).toBe(3)
      expect(result.jobs.running).toBe(2)
      expect(result.orders.successRate).toBeGreaterThan(0)
    })
  })

  describe('getProviderHealthList', () => {
    it('returns providers with health scores', async () => {
      mockPrisma.provider.findMany.mockResolvedValue([
        { id: 'p1', code: 'CHOICE', name: 'Choice', status: 'ACTIVE', errorCount: 0, lastSuccessfulConnection: new Date(), lastFailedConnection: null, activationSuccessRate: 0.95, averageActivationTimeMs: 500, config: { balanceSnapshot: { balance: 1000, currency: 'USD' } } },
        { id: 'p2', code: 'AIRHUB', name: 'AirHub', status: 'TESTING', errorCount: 8, lastSuccessfulConnection: null, lastFailedConnection: new Date(), activationSuccessRate: 0.5, averageActivationTimeMs: 3000, config: {} },
      ] as any)

      const result = await getProviderHealthList()
      expect(result).toHaveLength(2)
      expect(result[0].healthScore).toBe(100)
      expect(result[1].healthScore).toBe(50)
      expect(result[0].balance).toBe('1000 USD')
    })
  })
})
