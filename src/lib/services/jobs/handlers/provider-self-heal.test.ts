import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    provider: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    backgroundJob: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'job-new' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    eSIM: { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    eSIMPurchase: { findMany: vi.fn().mockResolvedValue([]) },
    providerAttempt: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) },
  },
}))

vi.mock('@/lib/services/operations/provider-health-score', () => ({
  computeProviderHealth: vi.fn().mockResolvedValue({ score: 100, health: 'HEALTHY', components: { auth: { score: 5 }, catalog: { score: 10 }, purchase: { score: 25 } }, activeAlerts: 0, stuckOrders: 0 }),
}))

vi.mock('@/lib/services/operations/provider-alerts', () => ({
  upsertProviderAlert: vi.fn().mockResolvedValue(undefined),
  resolveProviderAlert: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/services/orders/order-recovery-dispatcher', () => ({
  discoverStrandedOrders: vi.fn(),
}))

const { prisma } = await import('@/lib/prisma')
const { claimProviderHeal } = await import('./provider-self-heal')
const { discoverStrandedOrders } = await import('@/lib/services/orders/order-recovery-dispatcher')

const mockExec = vi.mocked(prisma.$executeRawUnsafe)
const mockDiscover = vi.mocked(discoverStrandedOrders)

describe('provider self-heal — claim lease UTC clock semantics', () => {
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

describe('provider self-heal — canonical stranded-order recovery', () => {
  const mockBgCreate = vi.mocked(prisma.backgroundJob.create)
  const mockProviderFindMany = vi.mocked(prisma.provider.findMany)

  beforeEach(() => {
    vi.clearAllMocks()
    mockProviderFindMany.mockResolvedValue([{ id: 'prov-1', name: 'TestProvider', type: 'CUSTOM', config: {} } as any])
    mockBgCreate.mockResolvedValue({ id: 'job-new' })
    mockDiscover.mockResolvedValue({ source: 'PROVIDER_SELF_HEAL', scanned: 0, eligible: 0, enqueued: 0, duplicateSkipped: 0, skippedInFlight: 0, errors: [] } as any)
  })

  it('drives the canonical recovery discovery from the recurring tick (source PROVIDER_SELF_HEAL)', async () => {
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    expect(mockDiscover).toHaveBeenCalledWith({ source: 'PROVIDER_SELF_HEAL' })
  })

  it('reports discovery counts alongside provider-health results', async () => {
    mockDiscover.mockResolvedValue({ source: 'PROVIDER_SELF_HEAL', scanned: 2, eligible: 2, enqueued: 2, duplicateSkipped: 0, skippedInFlight: 0, errors: [] } as any)
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    const out = await executeProviderSelfHeal()
    expect(out.result.recovery).toEqual(expect.objectContaining({ enqueued: 2 }))
  })

  it('does not itself create PROVIDER_OPERATION jobs — discovery is delegated', async () => {
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    expect(mockBgCreate).not.toHaveBeenCalled()
  })
})