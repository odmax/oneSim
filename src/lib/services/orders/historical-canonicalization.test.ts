import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const tx = {
    eSIMPurchase: { findUnique: vi.fn(), updateMany: vi.fn() },
    eSIM: { updateMany: vi.fn() },
    walletTransaction: { findMany: vi.fn(), count: vi.fn() },
    providerAttempt: { findFirst: vi.fn() },
  }
  return { tx }
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (fn: any) => fn(h.tx)),
    eSIMPurchase: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    eSIM: { updateMany: vi.fn(), update: vi.fn() },
    walletTransaction: { findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    providerAttempt: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}))

const { prisma } = await import('@/lib/prisma')
const { canonicalizeHistoricalOrders } = await import('./historical-canonicalization')

const mockPrisma = vi.mocked(prisma)
const mockTx = h.tx

const C = '8656cce5-ad38-4378-915d-3cbc68181850'
const ICCID = '8910300000016182009'

function makeEsim(overrides: any = {}) {
  return {
    id: 'esim-1',
    iccid: ICCID,
    status: 'PROCESSING',
    providerActivationId: 'esim-1',
    providerSubscriptionId: null,
    statusNextSyncAt: null,
    activationCode: 'LPA:1$rsp.example.com$mid-9',
    providerStatus: 'ACTIVE',
    ...overrides,
  }
}

function makeOrder(overrides: any = {}) {
  return {
    id: 'order-1',
    status: 'FULFILLED',
    quantity: 1,
    quotedQuantity: null,
    fulfilledQuantity: 0,
    failedQuantity: 0,
    capturedAmount: null,
    releasedAmount: null,
    refundedAmount: null,
    fulfillmentCompletedAt: null,
    nextRetryAt: new Date('2026-09-11T10:03:00.294Z'),
    retryReason: 'Reconciliation attempt #1 — next check in 1min',
    providerFulfillId: C,
    statusChangedAt: new Date('2026-09-10T09:00:00Z'),
    updatedAt: new Date('2026-09-11T10:05:00Z'),
    esims: [makeEsim()],
    ...overrides,
  }
}

function walletRow(type: string, amount: number, createdAt = new Date('2026-09-10T09:01:00Z')) {
  return { id: `${type}-1`, orderId: 'order-1', type, amount, createdAt }
}

function defaultReads(
  order: any = makeOrder(),
  captures: any[] = [walletRow('WALLET_CAPTURE', 1.1)],
  releases = 0,
  refunds = 0,
  attemptCompletedAt = new Date('2026-09-10T09:05:00Z'),
) {
  mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(order as any)
  mockPrisma.walletTransaction.findMany.mockResolvedValue(captures as any)
  mockPrisma.walletTransaction.count.mockImplementation(async ({ where }: any) => {
    if (where.type === 'WALLET_RELEASE') return releases
    if (where.type === 'WALLET_REFUND') return refunds
    return 0
  })
  mockPrisma.providerAttempt.findFirst.mockResolvedValue(attemptCompletedAt ? { completedAt: attemptCompletedAt } as any : null)
}

function applyDefaults() {
  mockTx.eSIMPurchase.updateMany.mockResolvedValue({ count: 1 })
  mockTx.eSIM.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.eSIMPurchase.findMany.mockResolvedValue([{ id: 'order-1' }] as any)
  mockPrisma.eSIMPurchase.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.eSIM.updateMany.mockResolvedValue({ count: 1 })
}

beforeEach(() => {
  vi.clearAllMocks()
  applyDefaults()
})

describe('canonicalizeHistoricalOrders — eligibility & fail-closed (dry-run by default)', () => {
  it('dry-run is the default (no writes, no transaction)', async () => {
    defaultReads()
    mockPrisma.eSIMPurchase.updateMany.mockClear()
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1' })
    expect(r.dryRun).toBe(true)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(r.outcomes[0].reason).toBe('REPAIRED')
    expect(r.eligible).toBe(1)
  })

  it('24. missing providerFulfillId -> skip NO_PROVIDER_FULFILL_ID', async () => {
    defaultReads(makeOrder({ providerFulfillId: '' }))
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1' })
    expect(r.outcomes[0].reason).toBe('NO_PROVIDER_FULFILL_ID')
    expect(r.repaired).toBe(0)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('24b. non-FULFILLED order -> skip ORDER_NOT_FULFILLED', async () => {
    defaultReads(makeOrder({ status: 'PROVIDER_RECONCILIATION' }))
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1' })
    expect(r.outcomes[0].reason).toBe('ORDER_NOT_FULFILLED')
  })

  it('25. zero captures -> skip WALLET_CAPTURE_MISSING', async () => {
    defaultReads(makeOrder(), [])
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1' })
    expect(r.outcomes[0].reason).toBe('WALLET_CAPTURE_MISSING')
  })

  it('26. duplicate captures -> conflict WALLET_MULTI_CAPTURE', async () => {
    defaultReads(makeOrder(), [walletRow('WALLET_CAPTURE', 1.1), walletRow('WALLET_CAPTURE', 1.1)])
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1' })
    expect(r.outcomes[0].reason).toBe('WALLET_MULTI_CAPTURE')
    expect(r.conflicts).toBe(1)
  })

  it('27. release present -> conflict WALLET_RELEASE_OR_REFUND_PRESENT', async () => {
    defaultReads(makeOrder(), [walletRow('WALLET_CAPTURE', 1.1)], 1)
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1' })
    expect(r.outcomes[0].reason).toBe('WALLET_RELEASE_OR_REFUND_PRESENT')
    expect(r.conflicts).toBe(1)
  })

  it('28. refund present -> conflict WALLET_RELEASE_OR_REFUND_PRESENT', async () => {
    defaultReads(makeOrder(), [walletRow('WALLET_CAPTURE', 1.1)], 0, 1)
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1' })
    expect(r.outcomes[0].reason).toBe('WALLET_RELEASE_OR_REFUND_PRESENT')
  })

  it('29. conflicting non-local provider identity -> fail closed IDENTITY_CONFLICT', async () => {
    defaultReads(makeOrder({ esims: [makeEsim({ providerActivationId: 'OTHER-NON-LOCAL' })] }))
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1' })
    expect(r.outcomes[0].reason).toBe('IDENTITY_CONFLICT')
    expect(r.conflicts).toBe(1)
  })

  it('29b. conflicting providerSubscriptionId -> fail closed IDENTITY_CONFLICT', async () => {
    defaultReads(makeOrder({ esims: [makeEsim({ providerSubscriptionId: 'SOME-OTHER-C' })] }))
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1' })
    expect(r.outcomes[0].reason).toBe('IDENTITY_CONFLICT')
  })

  it('31a. quantity=2 with only one ICCID and zero failed -> skip QUANTITY_UNPROVEN (never invent qty=N)', async () => {
    defaultReads(makeOrder({ quantity: 2, esims: [makeEsim()] }))
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1' })
    expect(r.outcomes[0].reason).toBe('QUANTITY_UNPROVEN')
    expect(r.skipped).toBe(1)
  })
})

function defaultTxReads(
  order: any = makeOrder(),
  captures: any[] = [walletRow('WALLET_CAPTURE', 1.1)],
  releases = 0,
  refunds = 0,
  attemptCompletedAt = new Date('2026-09-10T09:05:00Z'),
) {
  mockTx.eSIMPurchase.findUnique.mockResolvedValue(order as any)
  mockTx.walletTransaction.findMany.mockResolvedValue(captures as any)
  mockTx.walletTransaction.count.mockImplementation(async ({ where }: any) => {
    if (where.type === 'WALLET_RELEASE') return releases
    if (where.type === 'WALLET_REFUND') return refunds
    return 0
  })
  mockTx.providerAttempt.findFirst.mockResolvedValue(attemptCompletedAt ? { completedAt: attemptCompletedAt } as any : null)
}

describe('canonicalizeHistoricalOrders — apply (control-incident shape + safety)', () => {
  it('7/8/9/10/11/12/13/14/15. repairs the controlled-incident order shape', async () => {
    defaultTxReads()
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1', apply: true })
    expect(r.dryRun).toBe(false)
    expect(r.outcomes[0].reason).toBe('REPAIRED')
    expect(r.repaired).toBe(1)

    const orderWrite = mockTx.eSIMPurchase.updateMany.mock.calls[0][0]
    expect(orderWrite.where.id).toBe('order-1')
    expect(orderWrite.where.status).toBe('FULFILLED')
    expect(orderWrite.data.fulfilledQuantity).toBe(1)
    expect(orderWrite.data.failedQuantity).toBe(0)
    expect(orderWrite.data.capturedAmount).toBe(1.1) // wallet evidence, not invented
    expect(orderWrite.data.nextRetryAt).toBeNull()
    expect(orderWrite.data.retryReason).toBeNull()
    expect(orderWrite.data.fulfillmentCompletedAt).toEqual(new Date('2026-09-10T09:00:00Z')) // statusChangedAt precedence

    // eSIM identity + sync re-entry writes
    const esimWrites = mockTx.eSIM.updateMany.mock.calls
    const subWrite = esimWrites.find((c) => c[0].where.id === 'esim-1' && c[0].data.providerSubscriptionId === C)
    const actWrite = esimWrites.find((c) => c[0].where.id === 'esim-1' && c[0].data.providerActivationId === C)
    const scheduleWrite = esimWrites.find((c) => c[0].where.id === 'esim-1' && c[0].data.statusNextSyncAt)
    expect(subWrite).toBeTruthy()
    expect(actWrite).toBeTruthy()
    expect(scheduleWrite).toBeTruthy()
    // identity guards: only null/local legacy value may be replaced
    expect(actWrite[0].where.OR).toContainEqual({ providerActivationId: 'esim-1' })
  })

  it('13b. fulfillmentCompletedAt falls back to SUCCEEDED RECONCILIATION completedAt when statusChangedAt is absent', async () => {
    defaultTxReads(makeOrder({ statusChangedAt: null }))
    await canonicalizeHistoricalOrders({ orderId: 'order-1', apply: true })
    const orderWrite = mockTx.eSIMPurchase.updateMany.mock.calls[0][0]
    expect(orderWrite.data.fulfillmentCompletedAt).toEqual(new Date('2026-09-10T09:05:00Z'))
  })

  it('16/17. ICCID, activationCode and providerStatus are never rewritten', async () => {
    defaultTxReads()
    await canonicalizeHistoricalOrders({ orderId: 'order-1', apply: true })
    for (const c of mockTx.eSIM.updateMany.mock.calls) {
      expect(c[0].data?.iccid).toBeUndefined()
      expect(c[0].data?.activationCode).toBeUndefined()
      expect(c[0].data?.providerStatus).toBeUndefined()
    }
    // No single-row eSIM update, no status field rewrite anywhere.
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
  })

  it('18/19. ProviderAttempt rows and PURCHASE dispatch provenance are READ-ONLY', async () => {
    // statusChangedAt null forces the deterministic timestamp derivation to read
    // the SUCCEEDED RECONCILIATION attempt completedAt (read-only).
    defaultTxReads(makeOrder({ statusChangedAt: null }))
    await canonicalizeHistoricalOrders({ orderId: 'order-1', apply: true })
    expect(mockTx.providerAttempt.findFirst).toHaveBeenCalled()
    expect(mockPrisma.providerAttempt.create).not.toHaveBeenCalled()
    expect(mockPrisma.providerAttempt.update).not.toHaveBeenCalled()
  })

  it('20/21/22. wallet rows are READ-ONLY; capture count stays exactly one; no release/refund', async () => {
    defaultTxReads()
    await canonicalizeHistoricalOrders({ orderId: 'order-1', apply: true })
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled()
    expect(mockPrisma.walletTransaction.update).not.toHaveBeenCalled()
    expect(mockPrisma.walletTransaction.count).not.toHaveBeenCalled() // count only happens on tx client during apply
    // The repair ran inside $transaction, so capture ledger reads happened on tx.
    expect(mockTx.walletTransaction.findMany).toHaveBeenCalled()
  })

  it('23. second apply pass is idempotent (NO_CHANGES, zero extra writes)', async () => {
    const canonical = makeOrder({
      fulfilledQuantity: 1,
      failedQuantity: 0,
      capturedAmount: 1.1,
      fulfillmentCompletedAt: new Date('2026-09-10T09:00:00Z'),
      nextRetryAt: null,
      retryReason: null,
      esims: [makeEsim({ providerActivationId: C, providerSubscriptionId: C, statusNextSyncAt: new Date('2026-09-11T12:00:00Z') })],
    })
    defaultTxReads(canonical)
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1', apply: true })
    expect(r.outcomes[0].reason).toBe('NO_CHANGES')
    expect(r.repaired).toBe(0)
    expect(mockTx.eSIMPurchase.updateMany).not.toHaveBeenCalled()
    expect(mockTx.eSIM.updateMany).not.toHaveBeenCalled()
  })

  it('30. terminal eSIM lifecycle is never resurrected nor scheduled', async () => {
    defaultTxReads(makeOrder({ esims: [makeEsim({ status: 'EXPIRED', providerActivationId: 'esim-1' })] }))
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1', apply: true })
    // Order metadata may be repaired, but the terminal eSIM is left untouched.
    expect(mockTx.eSIMPurchase.updateMany).toHaveBeenCalledTimes(1)
    expect(mockTx.eSIM.updateMany).not.toHaveBeenCalled()
    expect(r.outcomes[0].reason).toBe('REPAIRED')
  })

  it('31b. quantity=2 with two persisted ICCIDs -> repaired, fulfilledQuantity=2', async () => {
    const e2 = makeEsim({ id: 'esim-2', iccid: '8910300000016182010', providerActivationId: 'esim-2' })
    defaultTxReads(makeOrder({ quantity: 2, esims: [makeEsim(), e2] }))
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1', apply: true })
    expect(r.outcomes[0].reason).toBe('REPAIRED')
    const orderWrite = mockTx.eSIMPurchase.updateMany.mock.calls[0][0]
    expect(orderWrite.data.fulfilledQuantity).toBe(2)
  })

  it('31c. quantity=2 with one ICCID + one failed -> repaired with fulfilled=1 failed=1', async () => {
    defaultTxReads(makeOrder({ quantity: 2, failedQuantity: 1, esims: [makeEsim()] }))
    const r = await canonicalizeHistoricalOrders({ orderId: 'order-1', apply: true })
    expect(r.outcomes[0].reason).toBe('REPAIRED')
    const orderWrite = mockTx.eSIMPurchase.updateMany.mock.calls[0][0]
    expect(orderWrite.data.fulfilledQuantity).toBe(1)
    expect(orderWrite.data.failedQuantity).toBe(1)
  })

  it('32/33/34. no provider connector, no wallet mutation, no finalization/recovery invoked', async () => {
    defaultTxReads()
    await canonicalizeHistoricalOrders({ orderId: 'order-1', apply: true })
    // Provider connector: the module imports no connector factory — nothing to
    // assert directly, so assert no attempt writes and no single-row order update.
    expect(mockPrisma.eSIMPurchase.update).not.toHaveBeenCalled()
    expect(mockPrisma.providerAttempt.create).not.toHaveBeenCalled()
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled()
    expect(mockPrisma.walletTransaction.update).not.toHaveBeenCalled()
    // Only guarded updateMany writes may occur (order metadata + eSIM identity/schedule).
    expect(mockTx.eSIMPurchase.updateMany).toHaveBeenCalled()
  })
})