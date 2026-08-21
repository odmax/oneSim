import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    backgroundJob: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('./handlers/provider-operation', () => ({
  executeProviderOperation: vi.fn().mockImplementation(async (payload: any) =>
    payload?.operation === '__unhandled__'
      ? { completed: false, error: 'Unknown provider operation' }
      : { completed: true },
  ),
}))

import { prisma } from '@/lib/prisma'
import { processDueJobs } from './queue'

const mockPrisma = vi.mocked(prisma)

function dueJob(overrides: Partial<Record<string, any>> = {}) {
  return { id: 'job-1', type: 'EMAIL_DELIVERY', payload: {}, runAt: new Date(Date.now() - 1000), attempts: 0, maxAttempts: 5, ...overrides }
}

describe('background job queue transaction safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.backgroundJob.findMany.mockResolvedValue([])
    mockPrisma.backgroundJob.updateMany.mockResolvedValue({ count: 0 })
  })

  it('recovers stale PROCESSING jobs (worker crash) back to PENDING before polling', async () => {
    await processDueJobs()

    expect(mockPrisma.backgroundJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PROCESSING', lockedAt: { lt: expect.any(Date) } }),
        data: expect.objectContaining({ status: 'PENDING', lockedAt: null }),
      }),
    )
  })

  it('claims a job atomically (PENDING → PROCESSING) and skips when another worker won the claim', async () => {
    // Two workers both list the same due job; only the first updateMany wins.
    const job = dueJob()
    mockPrisma.backgroundJob.findMany.mockResolvedValue([job, job])
    mockPrisma.backgroundJob.updateMany
      .mockResolvedValueOnce({ count: 0 }) // stale-PROCESSING sweep finds nothing
      .mockResolvedValueOnce({ count: 1 }) // worker A claims
      .mockResolvedValueOnce({ count: 0 }) // worker B loses the race

    const results = await processDueJobs()

    expect(mockPrisma.backgroundJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'PENDING' },
      data: { status: 'PROCESSING', attempts: { increment: 1 }, lockedAt: expect.any(Date) },
    })
    // Exactly one execution and one completion — no double-run.
    expect(results).toEqual([{ id: 'job-1', type: 'EMAIL_DELIVERY', status: 'COMPLETED' }])
    expect(mockPrisma.backgroundJob.update).toHaveBeenCalledTimes(1)
  })

  it('claims a due purchase job immediately (runAt now — no cron cadence dependency)', async () => {
    const job = { ...dueJob(), type: 'PROVIDER_OPERATION', payload: { operation: 'purchase', orderId: 'order-1' }, runAt: new Date() }
    mockPrisma.backgroundJob.findMany.mockResolvedValue([job])
    mockPrisma.backgroundJob.updateMany
      .mockResolvedValueOnce({ count: 0 }) // stale sweep finds nothing
      .mockResolvedValueOnce({ count: 1 }) // claim wins

    const results = await processDueJobs({ types: ['PROVIDER_OPERATION'], limit: 5 })

    // The due filter is runAt <= now, so an enqueued-now purchase is claimable
    // on the very next poll — no 30s/60s cron interval involved.
    expect(mockPrisma.backgroundJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'PENDING',
          type: { in: ['PROVIDER_OPERATION'] },
          runAt: { lte: expect.any(Date) },
        }),
        take: 5,
      }),
    )
    expect(results).toEqual([{ id: 'job-1', type: 'PROVIDER_OPERATION', status: 'COMPLETED' }])
  })

  it('a failed handler schedules a retry with backoff instead of losing the job', async () => {
    const { executePurchaseDispatch } = await import('./handlers/purchase-execution')
    ;(executePurchaseDispatch as any).mockRestore?.()
    const job = { ...dueJob(), type: 'PROVIDER_OPERATION', payload: { operation: '__unhandled__' } }
    mockPrisma.backgroundJob.findMany.mockResolvedValue([job])
    mockPrisma.backgroundJob.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.backgroundJob.findUnique.mockResolvedValue(job as any)

    const results = await processDueJobs()

    expect(results[0].status).toBe('FAILED')
    // Job returns to PENDING with a future runAt (backoff), never dropped.
    expect(mockPrisma.backgroundJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({ status: 'PENDING', runAt: expect.any(Date) }),
    })
  })

  it('exhausted retries mark the job FAILED permanently', async () => {
    const job = { ...dueJob(), type: 'PROVIDER_OPERATION', payload: { operation: '__unhandled__' }, attempts: 5, maxAttempts: 5 }
    mockPrisma.backgroundJob.findMany.mockResolvedValue([job])
    mockPrisma.backgroundJob.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.backgroundJob.findUnique.mockResolvedValue(job as any)

    const results = await processDueJobs()

    expect(results[0].status).toBe('FAILED')
    expect(mockPrisma.backgroundJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: 'FAILED', lastError: expect.any(String) },
    })
  })
})
