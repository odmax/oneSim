import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}))

vi.mock('@/lib/auth/config', () => ({
  authOptions: {},
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    apiRequestLog: {
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    business: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}))

import { getServerSession } from 'next-auth'
import { prisma } from '@/lib/prisma'
import { getBusinessApiUsage, getApiLogs, getApiLogSummary } from './api-logs'

const mockSession = vi.mocked(getServerSession)
const mockPrisma = vi.mocked(prisma)

function businessSession(businessId: string | null | undefined) {
  return { user: { role: 'BUSINESS_USER', businessId } }
}

const adminSession = () => ({ user: { role: 'INTERNAL_ADMIN', businessId: undefined } })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getBusinessApiUsage (business-tenant scoped)', () => {
  it('BUSINESS_USER with a businessId can call getBusinessApiUsage', async () => {
    mockSession.mockResolvedValue(businessSession('biz-1') as any)
    mockPrisma.apiRequestLog.findMany.mockResolvedValue([{ id: 'l1', method: 'GET' }] as any)
    mockPrisma.apiRequestLog.count.mockResolvedValue(7)

    const r = await getBusinessApiUsage()

    expect(r.logs).toEqual([{ id: 'l1', method: 'GET' }])
    expect(r.requestsToday).toBe(7)
    expect(r.failedToday).toBe(7)
    expect(r.rateLimitHits).toBe(7)
  })

  it('queries prisma.apiRequestLog ONLY for session.user.businessId', async () => {
    mockSession.mockResolvedValue(businessSession('biz-42') as any)
    mockPrisma.apiRequestLog.findMany.mockResolvedValue([])
    mockPrisma.apiRequestLog.count.mockResolvedValue(0)

    await getBusinessApiUsage()

    expect(mockPrisma.apiRequestLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ businessId: 'biz-42' }),
    }))
    for (const call of mockPrisma.apiRequestLog.count.mock.calls) {
      expect(call[0].where.businessId).toBe('biz-42')
    }
  })

  it('rejects a BUSINESS_USER without a businessId (no tenant scope)', async () => {
    mockSession.mockResolvedValue(businessSession(null) as any)
    await expect(getBusinessApiUsage()).rejects.toThrow('Unauthorized')
    expect(mockPrisma.apiRequestLog.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.apiRequestLog.count).not.toHaveBeenCalled()
  })

  it('rejects INTERNAL_ADMIN (admins use getApiLogs/getApiLogSummary, not this function)', async () => {
    mockSession.mockResolvedValue(adminSession() as any)
    await expect(getBusinessApiUsage()).rejects.toThrow('Unauthorized')
    expect(mockPrisma.apiRequestLog.findMany).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated request', async () => {
    mockSession.mockResolvedValue(null)
    await expect(getBusinessApiUsage()).rejects.toThrow('Unauthorized')
    expect(mockPrisma.apiRequestLog.findMany).not.toHaveBeenCalled()
  })

  it('STRUCTURALLY prevents reading another tenant: takes zero arguments (no caller-supplied businessId)', () => {
    // Tenant identity is derived only from the authenticated session. With a
    // zero-argument signature it is impossible to supply another businessId at
    // the call boundary.
    expect(getBusinessApiUsage.length).toBe(0)
  })
})

describe('admin api-log functions keep INTERNAL_ADMIN guard', () => {
  it('getApiLogs works for INTERNAL_ADMIN', async () => {
    mockSession.mockResolvedValue(adminSession() as any)
    mockPrisma.apiRequestLog.findMany.mockResolvedValue([])
    mockPrisma.apiRequestLog.count.mockResolvedValue(3)

    const r = await getApiLogs({ page: 1 })
    expect(r.total).toBe(3)
    expect(r.logs).toEqual([])
  })

  it('getApiLogs rejects a BUSINESS_USER', async () => {
    mockSession.mockResolvedValue(businessSession('biz-1') as any)
    await expect(getApiLogs({ page: 1 })).rejects.toThrow('Unauthorized')
    expect(mockPrisma.apiRequestLog.findMany).not.toHaveBeenCalled()
  })

  it('getApiLogSummary works for INTERNAL_ADMIN', async () => {
    mockSession.mockResolvedValue(adminSession() as any)
    mockPrisma.apiRequestLog.count.mockResolvedValue(2)
    mockPrisma.apiRequestLog.groupBy.mockResolvedValue([])
    mockPrisma.business.findMany.mockResolvedValue([])

    const r = await getApiLogSummary()
    expect(r.requestsToday).toBe(2)
    expect(r.topBusinessList).toEqual([])
  })

  it('getApiLogSummary rejects a BUSINESS_USER', async () => {
    mockSession.mockResolvedValue(businessSession('biz-1') as any)
    await expect(getApiLogSummary()).rejects.toThrow('Unauthorized')
    expect(mockPrisma.apiRequestLog.count).not.toHaveBeenCalled()
  })
})
