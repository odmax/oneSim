import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    providerAttempt: { findMany: vi.fn() },
    backgroundJob: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}))

vi.mock('@/lib/services/jobs/queue', () => ({
  enqueueJob: vi.fn(async () => ({ id: 'job-new' })),
}))

// executeOrderRecovery dynamically imports recoverOrder — isolate the dispatcher.
vi.mock('@/lib/services/orders/recovery', () => ({
  recoverOrder: vi.fn(),
}))

const { prisma } = await import('@/lib/prisma')
const { enqueueJob } = await import('@/lib/services/jobs/queue')
const { recoverOrder } = await import('@/lib/services/orders/recovery')
const {
  discoverStrandedOrders,
  enqueueRecoveryForOrder,
  executeOrderRecovery,
  recoveryIdempotencyKey,
  RECOVERY_SCOPE_STATUSES,
} = await import('./order-recovery-dispatcher')

const mockFindMany = vi.mocked(prisma.eSIMPurchase.findMany)
const mockUnique = vi.mocked(prisma.eSIMPurchase.findUnique)
const mockUpdateMany = vi.mocked(prisma.eSIMPurchase.updateMany)
const mockAttemptFindMany = vi.mocked(prisma.providerAttempt.findMany)
const mockBgFindMany = vi.mocked(prisma.backgroundJob.findMany)
const mockBgFindFirst = vi.mocked(prisma.backgroundJob.findFirst)
const mockEnqueue = vi.mocked(enqueueJob)
const mockRecover = vi.mocked(recoverOrder)

const NOW = new Date('2026-09-09T12:34:56Z')

function order(overrides: any = {}) {
  return {
    id: 'order-1',
    status: 'PENDING_PROVIDER',
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    providerId: 'prov-1',
    businessId: 'biz-1',
    totalAmount: 10,
    providerFulfillId: null,
    providerReservationId: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFindMany.mockResolvedValue([])
  mockUnique.mockResolvedValue(order() as any)
  mockUpdateMany.mockResolvedValue({ count: 1 })
  mockAttemptFindMany.mockResolvedValue([])
  mockBgFindMany.mockResolvedValue([])
  mockBgFindFirst.mockResolvedValue(null)
  mockEnqueue.mockResolvedValue({ id: 'job-new' } as any)
  mockRecover.mockResolvedValue({ success: true, action: 'POLL_PROVIDER', status: 'PROCESSING', retryCount: 0 } as any)
})

describe('recoveryIdempotencyKey — time-bucketed dedup key', () => {
  it('scopes a 10-minute bucket: same window → same key, next window → new key', () => {
    const t1 = new Date('2026-09-09T12:34:00Z').getTime()
    const t2 = new Date('2026-09-09T12:37:00Z').getTime()
    const t3 = new Date('2026-09-09T12:41:00Z').getTime()
    expect(recoveryIdempotencyKey('order-1', t1)).toBe(recoveryIdempotencyKey('order-1', t2))
    expect(recoveryIdempotencyKey('order-1', t1)).not.toBe(recoveryIdempotencyKey('order-1', t3))
    expect(recoveryIdempotencyKey('order-1', t1)).toMatch(/^recovery:order-1:\d+$/)
  })
})

describe('discoverStrandedOrders — canonical selection', () => {
  it('selects PENDING_PROVIDER + PROVIDER_RECONCILIATION, null-or-due nextRetryAt', async () => {
    mockFindMany.mockResolvedValue([order()])
    await discoverStrandedOrders({ source: 'PROVIDER_SELF_HEAL' }, NOW)
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: ['PENDING_PROVIDER', 'PROVIDER_RECONCILIATION'] },
        OR: [{ nextRetryAt: { equals: null } }, { nextRetryAt: { lte: NOW } }],
      }),
    }))
  })

  it('enqueues one recovery operation per eligible order (bucket idempotencyKey + providerId column)', async () => {
    mockFindMany.mockResolvedValue([order({ id: 'order-1' }), order({ id: 'order-2', status: 'PROVIDER_RECONCILIATION' })])
    const result = await discoverStrandedOrders({ source: 'PROVIDER_SELF_HEAL' }, NOW)
    expect(result.enqueued).toBe(2)
    expect(result.eligible).toBe(2)
    expect(mockEnqueue).toHaveBeenCalledTimes(2)
    const call = mockEnqueue.mock.calls[0]
    expect(call[0]).toBe('PROVIDER_OPERATION')
    expect(call[1]).toEqual(expect.objectContaining({ operation: 'recovery', orderId: 'order-1', providerId: 'prov-1', businessId: 'biz-1' }))
    expect(call[4]).toBe(recoveryIdempotencyKey('order-1', NOW.getTime()))
  })

  it('respects budget: budget-exhausted orders with NO acceptance evidence are not enqueued', async () => {
    mockFindMany.mockResolvedValue([order({ retryCount: 3, maxRetries: 3 })])
    const result = await discoverStrandedOrders({ source: 'MANUAL' }, NOW)
    expect(result.eligible).toBe(0)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('budget-exhausted orders WITH a provider-owned reference stay recoverable (read-only continuation)', async () => {
    mockFindMany.mockResolvedValue([order({ id: 'order-ev', retryCount: 3, maxRetries: 3 })])
    mockAttemptFindMany.mockResolvedValue([{ orderId: 'order-ev', providerId: 'prov-1', providerReference: '12811381', status: 'PROCESSING', dispatchStartedAt: new Date() }] as any)
    const result = await discoverStrandedOrders({ source: 'MANUAL' }, NOW)
    expect(result.eligible).toBe(1)
    expect(mockEnqueue).toHaveBeenCalledWith('PROVIDER_OPERATION', expect.objectContaining({ orderId: 'order-ev' }), expect.any(Date), 5, expect.any(String))
  })

  it('skips orders already covered by an in-flight PROVIDER_OPERATION job (activation or recovery)', async () => {
    mockFindMany.mockResolvedValue([order({ id: 'order-act' })])
    mockBgFindMany.mockResolvedValue([{ payload: { operation: 'activation', orderId: 'order-act', providerId: 'prov-1' } }] as any)
    const result = await discoverStrandedOrders({ source: 'PROVIDER_SELF_HEAL' }, NOW)
    expect(result.skippedInFlight).toBe(1)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('a duplicate enqueue (unique idempotencyKey) is counted, never thrown', async () => {
    mockFindMany.mockResolvedValue([order()])
    mockEnqueue.mockRejectedValue(new Error('Unique constraint failed on idempotencyKey'))
    const result = await discoverStrandedOrders({ source: 'PROVIDER_SELF_HEAL' }, NOW)
    expect(result.duplicateSkipped).toBe(1)
    expect(result.enqueued).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('no candidates → zero result without extra queries', async () => {
    const result = await discoverStrandedOrders({ source: 'PROVIDER_SELF_HEAL' }, NOW)
    expect(result.scanned).toBe(0)
    expect(mockAttemptFindMany).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})

describe('enqueueRecoveryForOrder — single-order manual path', () => {
  it('enqueues an in-scope order', async () => {
    mockUnique.mockResolvedValue(order() as any)
    const r = await enqueueRecoveryForOrder('order-1', { source: 'MANUAL' }, NOW)
    expect(r.enqueued).toBe(true)
    expect(mockEnqueue).toHaveBeenCalledWith('PROVIDER_OPERATION', expect.objectContaining({ operation: 'recovery', orderId: 'order-1' }), expect.any(Date), 5, expect.stringContaining('recovery:order-1:'))
  })

  it('rejects out-of-scope statuses (CREATED/PAYMENT_RESERVED stay audit-only)', async () => {
    for (const status of RECOVERY_SCOPE_STATUSES) { void status }
    for (const status of ['CREATED', 'PAYMENT_RESERVED', 'FULFILLED', 'FAILED']) {
      mockUnique.mockResolvedValue(order({ status }) as any)
      const r = await enqueueRecoveryForOrder('order-1', { source: 'MANUAL' }, NOW)
      expect(r.enqueued).toBe(false)
    }
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('refuses when an in-flight job already covers the order', async () => {
    mockBgFindFirst.mockResolvedValue({ id: 'job-x' } as any)
    const r = await enqueueRecoveryForOrder('order-1', { source: 'MANUAL' }, NOW)
    expect(r.enqueued).toBe(false)
    expect(r.reason).toMatch(/already scheduled|in-flight/i)
  })

  it('reports duplicate-window and not-found as not enqueued', async () => {
    mockEnqueue.mockRejectedValue(new Error('Unique constraint failed on idempotencyKey'))
    const dup = await enqueueRecoveryForOrder('order-1', { source: 'MANUAL' }, NOW)
    expect(dup.enqueued).toBe(false)
    mockUnique.mockResolvedValue(null as any)
    const missing = await enqueueRecoveryForOrder('nope', { source: 'MANUAL' }, NOW)
    expect(missing.enqueued).toBe(false)
    expect(missing.reason).toBe('Order not found')
  })
})

describe('executeOrderRecovery — leased claim + execution', () => {
  it('terminal orders are a no-op without recovering', async () => {
    mockUnique.mockResolvedValue(order({ status: 'FULFILLED' }) as any)
    const r = await executeOrderRecovery({ orderId: 'order-1' })
    expect(r.completed).toBe(true)
    expect(mockUpdateMany).not.toHaveBeenCalled()
    expect(mockRecover).not.toHaveBeenCalled()
  })

  it('claims via nextRetryAt (only when null-or-due) then runs recoverOrder exactly once', async () => {
    const r = await executeOrderRecovery({ orderId: 'order-1' })
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'order-1',
        status: { in: ['PENDING_PROVIDER', 'PROVIDER_RECONCILIATION'] },
        OR: [{ nextRetryAt: { equals: null } }, { nextRetryAt: { lte: expect.any(Date) } }],
      }),
    }))
    expect(mockRecover).toHaveBeenCalledTimes(1)
    expect(mockRecover).toHaveBeenCalledWith('order-1')
    expect(r.completed).toBe(true)
  })

  it('never runs twice concurrently — the loser of the claim skips (count 0)', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    const r = await executeOrderRecovery({ orderId: 'order-1' })
    expect(r.completed).toBe(true)
    expect(r.error).toMatch(/already being recovered/i)
    expect(mockRecover).not.toHaveBeenCalled()
  })

  it('still-processing / unresolved results complete the job; the order-level nextRetryAt drives re-polls', async () => {
    mockRecover.mockResolvedValue({ success: false, action: 'POLL_PROVIDER', status: 'PENDING_PROVIDER', retryCount: 1, message: 'Provider still processing' } as any)
    const r = await executeOrderRecovery({ orderId: 'order-1' })
    expect(r.completed).toBe(true)
    expect(r.error).toBe('Provider still processing')
  })

  it('NOT_RETRYABLE suppresses the 5-minute discovery loop (anti-churn 1-hour pause)', async () => {
    mockRecover.mockResolvedValue({ success: false, action: 'NOT_RETRYABLE', status: 'PENDING_PROVIDER', retryCount: 0, message: 'Cannot classify recovery' } as any)
    const r = await executeOrderRecovery({ orderId: 'order-1' })
    expect(r.completed).toBe(true)
    expect(mockUpdateMany).toHaveBeenCalledTimes(2) // claim + anti-churn pause
    const antiChurn = mockUpdateMany.mock.calls[1][0]
    expect(antiChurn.data.nextRetryAt.getTime() - Date.now()).toBeGreaterThan(50 * 60 * 1000)
  })

  it('infra errors surface as completed:false so the queue retries with backoff', async () => {
    mockRecover.mockRejectedValue(new Error('DB connection lost'))
    const r = await executeOrderRecovery({ orderId: 'order-1' })
    expect(r.completed).toBe(false)
    expect(r.error).toBe('DB connection lost')
  })

  it('guards payload shape', async () => {
    const missing = await executeOrderRecovery({})
    expect(missing.completed).toBe(false)
    expect(missing.error).toMatch(/orderId/i)
    mockUnique.mockResolvedValue(null as any)
    const gone = await executeOrderRecovery({ orderId: 'nope' })
    expect(gone.completed).toBe(false)
  })
})