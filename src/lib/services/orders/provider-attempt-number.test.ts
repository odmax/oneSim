import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerAttempt: { aggregate: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { allocateProviderAttemptNumber } from './provider-attempt-number'

const mockAggregate = vi.mocked(prisma.providerAttempt.aggregate)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('allocateProviderAttemptNumber', () => {
  it('returns 1 when the order has no attempts yet', async () => {
    mockAggregate.mockResolvedValue({ _max: { attemptNumber: null } } as any)
    await expect(allocateProviderAttemptNumber('order-1')).resolves.toBe(1)
  })

  it('returns max+1 across ALL sources (global per-order monotonic)', async () => {
    mockAggregate.mockResolvedValue({ _max: { attemptNumber: 5 } } as any)
    await expect(allocateProviderAttemptNumber('order-1')).resolves.toBe(6)
  })

  it('queries the order only (no cross-order influence)', async () => {
    mockAggregate.mockResolvedValue({ _max: { attemptNumber: 7 } } as any)
    await allocateProviderAttemptNumber('order-1')
    expect(mockAggregate).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: 'order-1' } }))
  })
})