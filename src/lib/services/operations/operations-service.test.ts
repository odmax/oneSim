import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { count: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    backgroundJob: { count: vi.fn(), findMany: vi.fn() },
    eSIMPurchase: { count: vi.fn() },
    providerAttempt: { count: vi.fn(), aggregate: vi.fn().mockResolvedValue({ _max: { attemptNumber: null } }) },
    providerPackage: { groupBy: vi.fn(), count: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { getOpsMetrics, getProviderHealthList, getJobAnalytics, getCatalogAnalytics, generateAlerts } from '@/lib/services/operations/operations-service'

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

  describe('getJobAnalytics', () => {
    it('returns job counts by type and status', async () => {
      mockPrisma.backgroundJob.findMany.mockResolvedValue([
        { type: 'PROVIDER_OPERATION', status: 'COMPLETED' },
        { type: 'PROVIDER_OPERATION', status: 'FAILED' },
        { type: 'ACTIVATION_SYNC', status: 'PENDING' },
      ] as any)
      const result = await getJobAnalytics()
      expect(result.byType['PROVIDER_OPERATION']).toBe(2)
      expect(result.byStatus['COMPLETED']).toBe(1)
      expect(result.byStatus['FAILED']).toBe(1)
    })
  })

  describe('getCatalogAnalytics', () => {
    it('returns config and publish counts', async () => {
      mockPrisma.providerPackage.groupBy.mockResolvedValueOnce([{ configurationStatus: 'UNCONFIGURED', _count: 3 }, { configurationStatus: 'CONFIGURED', _count: 5 }] as any)
      mockPrisma.providerPackage.groupBy.mockResolvedValueOnce([{ publishStatus: 'DRAFT', _count: 4 }, { publishStatus: 'PUBLISHED', _count: 2 }] as any)
      mockPrisma.providerPackage.count.mockResolvedValue(10)
      const result = await getCatalogAnalytics()
      expect(result.configCounts['UNCONFIGURED']).toBe(3)
      expect(result.publishCounts['PUBLISHED']).toBe(2)
      expect(result.total).toBe(10)
    })
  })

  describe('generateAlerts', () => {
    it('generates alert for inactive provider', () => {
      const alerts = generateAlerts(
        { providers: { total: 2, online: 1, offline: 1, healthPct: 50 }, jobs: { total: 0, running: 0, queued: 0, failed: 0 }, orders: { today: 0, successful: 0, failed: 0, successRate: 100 }, latency: { avgActivationMs: null, avgResponseMs: null }, routing: { totalDecisions: 0, avgCandidates: 0 }, failover: { total: 0, successful: 0, retryableFailures: 0 }, alerts: { total: 0, active: 0 } },
        [{ id: 'p1', code: 'CHOICE', name: 'Choice', status: 'INACTIVE', healthScore: 0, errorCount: 0, lastSuccess: null, lastFailure: null, balance: null, activations: 0, successRate: null, avgLatency: null }]
      )
      expect(alerts.some(a => a.type === 'PROVIDER_OFFLINE')).toBe(true)
    })

    it('generates alert for critical health', () => {
      const alerts = generateAlerts(
        { providers: { total: 1, online: 1, offline: 0, healthPct: 100 }, jobs: { total: 0, running: 0, queued: 0, failed: 0 }, orders: { today: 0, successful: 0, failed: 0, successRate: 100 }, latency: { avgActivationMs: null, avgResponseMs: null }, routing: { totalDecisions: 0, avgCandidates: 0 }, failover: { total: 0, successful: 0, retryableFailures: 0 }, alerts: { total: 0, active: 0 } },
        [{ id: 'p1', code: 'CHOICE', name: 'Choice', status: 'ACTIVE', healthScore: 20, errorCount: 0, lastSuccess: null, lastFailure: null, balance: null, activations: 0, successRate: null, avgLatency: null }]
      )
      expect(alerts.some(a => a.type === 'PROVIDER_HEALTH_CRITICAL')).toBe(true)
    })
  })
})
