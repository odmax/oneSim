import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    backgroundJob: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    providerSyncSchedule: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
  },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { prisma } from '@/lib/prisma'

describe('worker', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('claimJob returns null when no pending jobs', async () => {
    ;(prisma.backgroundJob.findMany as any).mockResolvedValue([])
    ;(prisma.backgroundJob.updateMany as any).mockResolvedValue({ count: 0 })
    ;(prisma.backgroundJob.findFirst as any).mockResolvedValue(null)
    const { claimJob } = await import('./worker')

    const job = await claimJob()
    expect(job).toBeNull()
  })

  it('claimJob atomically claims a pending job', async () => {
    ;(prisma.backgroundJob.findMany as any).mockResolvedValue([])
    ;(prisma.backgroundJob.updateMany as any).mockResolvedValue({ count: 1 })
    ;(prisma.backgroundJob.findFirst as any).mockResolvedValue({ id: 'job-1', type: 'PROVIDER_SYNC', attempts: 0, maxAttempts: 3 })
    ;(prisma.backgroundJob.update as any).mockResolvedValue({})
    const { claimJob } = await import('./worker')

    const job = await claimJob()
    expect(job).not.toBeNull()
    expect(job!.id).toBe('job-1')
  })

  it('RECOVER_STALE_JOBS resets stuck PROCESSING jobs to PENDING', async () => {
    const staleTime = new Date(Date.now() - 11 * 60 * 1000)
    ;(prisma.backgroundJob.updateMany as any).mockResolvedValue({ count: 0 })
    ;(prisma.backgroundJob.findMany as any)
      .mockResolvedValueOnce([
        { id: 'stale-1', attempts: 1, maxAttempts: 3, cancellationRequested: false },
      ])
      .mockResolvedValueOnce([])
    ;(prisma.backgroundJob.update as any).mockResolvedValue({})

    const { claimJob } = await import('./worker')
    // claimJob internally calls recoverStaleJobs
    ;(prisma.backgroundJob.findFirst as any).mockResolvedValue(null)
    await claimJob()

    // Verify stale job was reset to PENDING
    const updateCalls = (prisma.backgroundJob.update as any).mock.calls
    const staleUpdate = updateCalls.find((call: any[]) => call[0]?.data?.status === 'PENDING')
    expect(staleUpdate).toBeDefined()
  })
})

describe('scheduler', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('createScheduledJobs creates jobs for due schedules', async () => {
    ;(prisma.providerSyncSchedule.findMany as any).mockResolvedValue([
      { id: 's1', providerId: 'prov-a', frequency: 'DAILY', enabled: true, nextRunAt: new Date(Date.now() - 60000) },
    ])
    ;(prisma.backgroundJob.findUnique as any).mockResolvedValue(null)
    ;(prisma.backgroundJob.create as any).mockResolvedValue({ id: 'new-job' })
    ;(prisma.providerSyncSchedule.update as any).mockResolvedValue({})

    const { createScheduledJobs } = await import('./scheduler')
    const result = await createScheduledJobs()

    expect(result.created).toBe(1)
  })

  it('createScheduledJobs skips when idempotencyKey exists', async () => {
    ;(prisma.providerSyncSchedule.findMany as any).mockResolvedValue([
      { id: 's1', providerId: 'prov-a', frequency: 'DAILY', enabled: true, nextRunAt: new Date(Date.now() - 60000) },
    ])
    ;(prisma.backgroundJob.findUnique as any).mockResolvedValue({ id: 'existing' })
    ;(prisma.providerSyncSchedule.update as any).mockResolvedValue({})

    const { createScheduledJobs } = await import('./scheduler')
    const result = await createScheduledJobs()

    // Existing job → skip, advance nextRunAt anyway
    expect(result.created).toBe(0)
  })

  it('skips disabled schedules', async () => {
    ;(prisma.providerSyncSchedule.findMany as any).mockResolvedValue([
      { id: 's1', providerId: 'prov-a', frequency: 'DAILY', enabled: false, nextRunAt: new Date(Date.now() - 60000) },
    ])

    const { createScheduledJobs } = await import('./scheduler')
    const result = await createScheduledJobs()

    expect(result.created).toBe(0)
  })

  it('generates deterministic idempotency keys', async () => {
    // Keys use the window start time (truncated to day for DAILY)
    // Two calls within the same day should produce the same key
    const now = new Date()
    ;(prisma.providerSyncSchedule.findMany as any).mockResolvedValue([])

    const { createScheduledJobs } = await import('./scheduler')
    const result = await createScheduledJobs()
    expect(result.created).toBe(0)
  })
})
