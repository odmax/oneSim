import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    backgroundJob: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    catalogReviewItem: { count: vi.fn().mockResolvedValue(0) },
    provider: {
      count: vi.fn().mockResolvedValue(3),
      findMany: vi.fn().mockResolvedValue([]),
    },
    providerPackage: {
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  },
}))

import { prisma } from '@/lib/prisma'

describe('operations-monitoring', () => {
  it('getSystemHealth returns structured health data', async () => {
    const { getSystemHealth } = await import('./operations-monitoring')
    ;(prisma.backgroundJob.findFirst as any).mockResolvedValue(null)
    const result = await getSystemHealth()
    expect(result).toHaveProperty('activeWorkers')
    expect(result).toHaveProperty('runningJobs')
    expect(result).toHaveProperty('successRate')
    expect(result).toHaveProperty('pendingReviews')
    expect(result).toHaveProperty('activeProviders')
  })

  it('getProviderHealth returns array', async () => {
    ;(prisma.provider.findMany as any).mockResolvedValue([])
    const { getProviderHealth } = await import('./operations-monitoring')
    const result = await getProviderHealth()
    expect(Array.isArray(result)).toBe(true)
  })

  it('getAlerts generates all-clear when no issues', async () => {
    const { getAlerts } = await import('./operations-monitoring')
    const alerts = await getAlerts()
    expect(alerts.length).toBeGreaterThanOrEqual(1)
    expect(alerts.some(a => a.type === 'ALL_CLEAR')).toBe(true)
  })

  it('getSystemMetrics returns structured metrics', async () => {
    const { getSystemMetrics } = await import('./operations-monitoring')
    const result = await getSystemMetrics()
    expect(result).toHaveProperty('jobsPerHour')
    expect(result).toHaveProperty('syncsPerDay')
    expect(result).toHaveProperty('queueLength')
    expect(result).toHaveProperty('workerUtilization')
  })

  it('getPipelineMetrics returns stage data', async () => {
    const { getPipelineMetrics } = await import('./operations-monitoring')
    const result = await getPipelineMetrics()
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(2)
  })

  it('truncates long error messages in error center', async () => {
    const { getErrors } = await import('./operations-monitoring')
    ;(prisma.backgroundJob.findMany as any).mockResolvedValue([
      { id: 'e1', type: 'PROVIDER_SYNC', providerId: 'prov-1', lastError: 'A'.repeat(200), retryClassification: 'NON_RETRYABLE', finishedAt: new Date(), attempts: 3 },
    ])
    ;(prisma.backgroundJob.count as any).mockResolvedValue(1)
    const result = await getErrors({})
    expect(result.items[0].lastError.length).toBe(200)
  })
})
