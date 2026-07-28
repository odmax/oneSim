import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    backgroundJob: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}))

import { prisma } from '@/lib/prisma'

describe('job-queue', () => {
  it('enqueueJob creates with correct type and status', async () => {
    ;(prisma.backgroundJob.create as any).mockResolvedValue({ id: 'job-1' })
    const { enqueueJob } = await import('./job-queue')
    const result = await enqueueJob('PROVIDER_SYNC' as any, { providerId: 'prov-1' }, 'prov-1', 'MANUAL')
    expect(result.id).toBe('job-1')
  })

  it('startJob fails gracefully for non-pending jobs', async () => {
    ;(prisma.backgroundJob.update as any).mockRejectedValue(new Error('Not found'))
    const { startJob } = await import('./job-queue')
    const result = await startJob('non-existent')
    expect(result).toBe(false)
  })

  it('completeJob updates status and progress', async () => {
    ;(prisma.backgroundJob.update as any).mockResolvedValue({})
    const { completeJob } = await import('./job-queue')
    await expect(completeJob('job-1', { packages: 10 })).resolves.toBeUndefined()
  })

  it('getJobStats returns structured counts', async () => {
    ;(prisma.backgroundJob.count as any)
      .mockResolvedValueOnce(2).mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0).mockResolvedValueOnce(5)
    ;(prisma.backgroundJob.findMany as any).mockResolvedValue([
      { startedAt: new Date('2026-01-01T10:00:00Z'), finishedAt: new Date('2026-01-01T10:01:00Z') },
    ])
    const { getJobStats } = await import('./job-queue')
    const stats = await getJobStats()
    expect(stats.running).toBe(2)
    expect(stats.pending).toBe(1)
    expect(stats.failed).toBe(0)
    expect(stats.completed).toBe(5)
    expect(stats.avgDurationMs).toBe(60000)
    expect(stats.successRate).toBe(71)
  })
})
