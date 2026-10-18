import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    eSIM: {
      updateMany: vi.fn(),
    },
  },
}))

vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { markExpiredESIMs } from './esim-service'

describe('bulk expiry safety hold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    'ACTIVE',
    'PENDING_ACTIVATION',
    'REFUNDED',
    'INSTALLED',
    'SUSPENDED',
  ])('never bulk-expires %s based on an unverified expiry date', async () => {
    const count = await markExpiredESIMs()

    expect(count).toBe(0)
    expect(mockPrisma.eSIM.updateMany).not.toHaveBeenCalled()
  })
})
