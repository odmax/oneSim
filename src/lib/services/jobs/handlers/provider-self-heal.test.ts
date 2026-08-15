import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    provider: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    backgroundJob: { findFirst: vi.fn().mockResolvedValue(null) },
    eSIM: { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  },
}))

vi.mock('@/lib/services/operations/provider-health-score', () => ({
  computeProviderHealth: vi.fn().mockResolvedValue({ score: 100, health: 'HEALTHY', components: { auth: { score: 5 }, catalog: { score: 10 }, purchase: { score: 25 } }, activeAlerts: 0, stuckOrders: 0 }),
}))

vi.mock('@/lib/services/operations/provider-alerts', () => ({
  upsertProviderAlert: vi.fn().mockResolvedValue(undefined),
  resolveProviderAlert: vi.fn().mockResolvedValue(undefined),
}))

const { prisma } = await import('@/lib/prisma')
const { claimProviderHeal } = await import('./provider-self-heal')

const mockExec = vi.mocked(prisma.$executeRawUnsafe)

describe('provider self-heal claim lease — UTC clock semantics', () => {
  it('compares selfHealLeaseUntil against UTC wall-clock, not server-local NOW()', async () => {
    mockExec.mockResolvedValue(1)
    await claimProviderHeal('prov-1')
    expect(mockExec).toHaveBeenCalledTimes(1)
    const [sql, lease] = mockExec.mock.calls[0]
    const text = String(sql)
    expect(text).toContain('UPDATE providers SET "selfHealLeaseUntil" = $1')
    expect(text).toContain('NOW() AT TIME ZONE \'UTC\'')
    expect(text).not.toContain('NOW())') // no bare NOW() expiry comparison
    expect(lease).toBeInstanceOf(Date)
  })

  it('grants a 4-minute lease', async () => {
    const before = Date.now()
    mockExec.mockResolvedValue(1)
    await claimProviderHeal('prov-1')
    const lease = mockExec.mock.calls[0][1] as Date
    expect(lease.getTime() - before).toBeGreaterThanOrEqual(4 * 60_000 - 2000)
    expect(lease.getTime() - before).toBeLessThan(4 * 60_000 + 5000)
  })
})
