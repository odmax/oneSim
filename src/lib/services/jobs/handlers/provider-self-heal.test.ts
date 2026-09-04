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

describe('provider self-heal — order-level reconciliation discovery', () => {
  const mockFindMany = vi.mocked(prisma.eSIMPurchase.findMany)
  const mockBgCreate = vi.mocked(prisma.backgroundJob.create)
  const mockBgUpdateMany = vi.mocked(prisma.backgroundJob.updateMany)
  const mockProviderFindMany = vi.mocked(prisma.provider.findMany)

  beforeEach(() => {
    vi.clearAllMocks()
    mockProviderFindMany.mockResolvedValue([{ id: 'prov-1', name: 'TestProvider', type: 'CUSTOM', config: {} } as any])
    mockFindMany.mockResolvedValue([])
    mockBgCreate.mockResolvedValue({ id: 'job-new' })
    mockBgUpdateMany.mockResolvedValue({ count: 1 })
  })

  function order(overrides: any = {}) {
    return {
      id: 'order-1', status: 'PROVIDER_RECONCILIATION',
      retryCount: 0, maxRetries: 3, nextRetryAt: null,
      providerFulfillId: null, providerReservationId: null,
      ...overrides,
    }
  }

  it('6. PROVIDER_RECONCILIATION + retryCount=0 + nextRetryAt=null → order-specific reconciliation job enqueued', async () => {
    mockFindMany.mockResolvedValue([order()])
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    expect(mockBgCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'PROVIDER_OPERATION',
        payload: expect.objectContaining({ operation: 'reconciliation', orderId: 'order-1' }),
      }),
    }))
  })

  it('7. future nextRetryAt → NOT enqueued', async () => {
    mockFindMany.mockResolvedValue([order({ nextRetryAt: new Date(Date.now() + 60_000) })])
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    expect(mockBgCreate).not.toHaveBeenCalled()
  })

  it('8. due nextRetryAt → enqueued', async () => {
    mockFindMany.mockResolvedValue([order({ nextRetryAt: new Date(Date.now() - 1_000) })])
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    expect(mockBgCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'PROVIDER_OPERATION',
        payload: expect.objectContaining({ operation: 'reconciliation', orderId: 'order-1' }),
      }),
    }))
  })

  it('9. no evidence + retryCount >= maxRetries → not endlessly re-enqueued', async () => {
    mockFindMany.mockResolvedValue([order({ retryCount: 3, maxRetries: 3 })])
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    expect(mockBgCreate).not.toHaveBeenCalled()
  })

  it('9b. evidence + retryCount >= maxRetries → still enqueued (read-only polling continues beyond the generic budget)', async () => {
    const mockAttemptFindMany = vi.mocked(prisma.providerAttempt.findMany)
    mockFindMany.mockResolvedValue([order({ id: 'order-ev', retryCount: 3, maxRetries: 3, providerFulfillId: null, providerReservationId: null })])
    mockAttemptFindMany.mockResolvedValue([{ orderId: 'order-ev', providerId: 'prov-1', providerReference: '12811381' }] as any)
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    expect(mockBgCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        payload: expect.objectContaining({ operation: 'reconciliation', orderId: 'order-ev' }),
      }),
    }))
  })

  it('9c. evidence + future nextRetryAt → NOT enqueued (backoff respected, no tight loop)', async () => {
    mockFindMany.mockResolvedValue([order({ id: 'order-ev', retryCount: 5, maxRetries: 3, nextRetryAt: new Date(Date.now() + 60_000), providerFulfillId: 'ref-1' })])
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    expect(mockBgCreate).not.toHaveBeenCalled()
  })

  it('9d. enqueues carry a deterministic cycle-scoped idempotencyKey `reconcile:{orderId}:{generation}` so duplicate discovery passes are DB-rejected and skipped', async () => {
    mockFindMany.mockResolvedValue([order({ id: 'order-idem', retryCount: 3, maxRetries: 3, providerFulfillId: 'ref-1' })])
    mockBgCreate.mockRejectedValue(new Error('Unique constraint failed on idempotencyKey'))
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    // Enqueue attempted with the cycle key (generation 0: no completed passes yet),
    // rejected as duplicate → safely skipped (no crash, no double dispatch).
    expect(mockBgCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ idempotencyKey: 'reconcile:order-idem:0' }),
    }))
  })

  it('9e. first reconciliation cycle derives `reconcile:{orderId}:0` (no completed passes yet)', async () => {
    mockFindMany.mockResolvedValue([order({ id: 'order-first', retryCount: 0, nextRetryAt: null })])
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    expect(mockBgCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ idempotencyKey: 'reconcile:order-first:0' }),
    }))
  })

  it('9f. duplicate discovery passes of the SAME cycle derive the SAME key → DB-unique constraint yields exactly one job', async () => {
    mockFindMany.mockResolvedValue([order({ id: 'order-dup', retryCount: 0, nextRetryAt: null })])
    mockBgCreate
      .mockResolvedValueOnce({ id: 'job-1' })
      .mockRejectedValueOnce(new Error('Unique constraint failed on idempotencyKey'))
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    await executeProviderSelfHeal()
    expect(mockBgCreate).toHaveBeenCalledTimes(2)
    const first = mockBgCreate.mock.calls[0][0].data.idempotencyKey
    const second = mockBgCreate.mock.calls[1][0].data.idempotencyKey
    expect(first).toBe('reconcile:order-dup:0')
    expect(second).toBe(first)
  })

  it('9g. when the next cycle is due, a NEW job derives a DIFFERENT key than the completed previous cycle', async () => {
    const mockGroupBy = vi.mocked(prisma.providerAttempt.groupBy)
    mockFindMany.mockResolvedValue([order({ id: 'order-cycle', retryCount: 1, nextRetryAt: new Date(Date.now() - 1000), providerFulfillId: 'ref-1' })])
    // Cycle N (pass in flight, 0 completed passes persisted yet) → key :0
    mockGroupBy.mockResolvedValueOnce([])
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    // Pass N COMPLETED (1 persisted reconciliation attempt); cycle N+1 now due → key :1
    mockGroupBy.mockResolvedValueOnce([{ orderId: 'order-cycle', _count: { _all: 1 } }] as any)
    await executeProviderSelfHeal()
    expect(mockGroupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['orderId'],
      where: expect.objectContaining({ source: 'RECONCILIATION', status: { not: 'PENDING' } }),
    }))
    const keys: string[] = mockBgCreate.mock.calls.map((c: any) => c[0].data.idempotencyKey)
    expect(keys).toEqual(['reconcile:order-cycle:0', 'reconcile:order-cycle:1'])
    expect(keys[0]).not.toBe(keys[1])
  })

  it('9h. a COMPLETED legacy `reconcile:{orderId}` job never blocks a later cycle — new key never equals the legacy format', async () => {
    mockFindMany.mockResolvedValue([order({ id: 'order-legacy', retryCount: 2, nextRetryAt: new Date(Date.now() - 1000), providerFulfillId: 'ref-1' })])
    vi.mocked(prisma.providerAttempt.groupBy).mockResolvedValue([{ orderId: 'order-legacy', _count: { _all: 2 } }] as any)
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    const key: string = mockBgCreate.mock.calls[0][0].data.idempotencyKey
    expect(key).toBe('reconcile:order-legacy:2')
    expect(key).not.toBe('reconcile:order-legacy')
    expect(key.startsWith('reconcile:order-legacy:')).toBe(true)
  })

  it('10. terminal order status → never selected', async () => {
    for (const terminal of ['FULFILLED', 'CANCELLED', 'REFUNDED', 'FAILED']) {
      vi.clearAllMocks()
      mockProviderFindMany.mockResolvedValue([{ id: 'prov-1', name: 'TestProvider', type: 'CUSTOM', config: {} } as any])
      mockFindMany.mockResolvedValue([order({ status: terminal })])
      mockBgCreate.mockResolvedValue({ id: 'job-new' })
      mockBgUpdateMany.mockResolvedValue({ count: 1 })
      const { executeProviderSelfHeal } = await import('./provider-self-heal')
      await executeProviderSelfHeal()
      expect(mockBgCreate).not.toHaveBeenCalled()
    }
  })

  it('11. no eligible orders → no jobs created', async () => {
    mockFindMany.mockResolvedValue([])
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    expect(mockBgCreate).not.toHaveBeenCalled()
  })

  it('12. multiple eligible orders → one job per order', async () => {
    mockFindMany.mockResolvedValue([
      order({ id: 'order-1', retryCount: 0 }),
      order({ id: 'order-2', retryCount: 1 }),
      order({ id: 'order-3', retryCount: 0, nextRetryAt: new Date(Date.now() - 1000) }),
    ])
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    expect(mockBgCreate).toHaveBeenCalledTimes(3)
    const orders = mockBgCreate.mock.calls.map((c: any) => c[0].data.payload.orderId)
    expect(orders).toEqual(['order-1', 'order-2', 'order-3'])
  })

  it('provider-neutral: discovery uses generic providerId filter, not provider-specific logic', async () => {
    mockFindMany.mockResolvedValue([order({ id: 'order-any-provider', retryCount: 0 })])
    const { executeProviderSelfHeal } = await import('./provider-self-heal')
    await executeProviderSelfHeal()
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'PROVIDER_RECONCILIATION' }),
    }))
    expect(mockBgCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        payload: expect.objectContaining({ orderId: 'order-any-provider' }),
      }),
    }))
  })
})
