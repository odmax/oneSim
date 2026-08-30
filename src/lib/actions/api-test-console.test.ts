import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    businessUser: { findFirst: vi.fn() },
    business: { findUnique: vi.fn() },
  },
}))

import { getServerSession } from 'next-auth'
import { prisma } from '@/lib/prisma'
import { testApiOrder } from './api-test-console'

const mockSession = vi.mocked(getServerSession)
const mockPrisma = vi.mocked(prisma)

function makeFormData(values: Record<string, string>) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(values)) fd.append(k, v)
  return fd as unknown as FormData
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSession.mockResolvedValue({ user: { id: 'u1', businessId: 'biz-1', role: 'BUSINESS_USER' } } as any)
})

afterEach(() => {
  delete process.env.NODE_ENV
})

describe('api-test-console production guard', () => {
  it('is hard-disabled in production — the diagnostic path can never become the production purchase route', async () => {
    mockPrisma.businessUser.findFirst.mockResolvedValue({ id: 'bu-1', userId: 'u1', businessId: 'biz-1', role: 'ADMIN' } as any)
    mockPrisma.business.findUnique.mockResolvedValue({ id: 'biz-1', status: 'APPROVED', walletBalance: { toString: () => '100' } } as any)

    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const result = await testApiOrder(makeFormData({ customerName: 'A', customerEmail: 'a@b.com', packageId: 'pkg-1', quantity: '1' }))
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/disabled in production/)
    } finally {
      if (original === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = original
    }
  })
})