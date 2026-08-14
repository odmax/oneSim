import { describe, it, expect, vi, beforeEach } from 'vitest'

// ──────────────────────────────────────────────────────────────────────────
// Stateful in-memory eSIMTopUp store so the DB-backed claim/guard logic is
// exercised faithfully (atomic conditional updates, leases, status transitions).
// ──────────────────────────────────────────────────────────────────────────

function matchesWhere(row: any, where: any): boolean {
  if (!where) return true
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(cond as any[]).every(c => matchesWhere(row, c))) return false
      continue
    }
    if (key === 'OR') {
      if (!(cond as any[]).some(c => matchesWhere(row, c))) return false
      continue
    }
    if (cond && typeof cond === 'object') {
      if ('lte' in cond) {
        if (!(row[key] != null && row[key].getTime() <= cond.lte.getTime())) return false
      } else if ('lt' in cond) {
        if (!(row[key] != null && row[key].getTime() < cond.lt.getTime())) return false
      } else if ('gte' in cond) {
        if (!(row[key] != null && row[key].getTime() >= cond.gte.getTime())) return false
      } else if ('not' in cond) {
        if (cond.not === null) { if (row[key] != null) return false }
        else if (row[key] === cond.not) return false
      } else if ('in' in cond) {
        if (!(cond as any).in.includes(row[key])) return false
      } else if (Object.keys(cond).length === 0) {
        if (row[key] !== undefined && row[key] !== null) return false
      } else if (row[key] !== cond) {
        return false
      }
    } else if (cond === null) {
      if (row[key] != null) return false
    } else if (row[key] !== cond) {
      return false
    }
  }
  return true
}

function applyData(row: any, data: any): any {
  const next = { ...row }
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) {
      next[key] = (Number(next[key]) || 0) + (value as any).increment
    } else if (value && typeof value === 'object' && 'decrement' in value) {
      next[key] = (Number(next[key]) || 0) - (value as any).decrement
    } else if (value && typeof value === 'object' && 'set' in value) {
      next[key] = (value as any).set
    } else {
      next[key] = value
    }
  }
  return next
}

function makeTopUpStore(rows: any[]) {
  const store = new Map<string, any>(rows.map(r => [r.id, { ...r }]))
  const findUnique = vi.fn(({ where }: any) => {
    const row = store.get(where.id)
    return row ? { ...row } : null
  })
  const update = vi.fn(({ where, data }: any) => {
    const row = store.get(where.id)
    if (!row) return null
    store.set(where.id, applyData(row, data))
    return { ...store.get(where.id) }
  })
  const updateMany = vi.fn(({ where, data }: any) => {
    let count = 0
    for (const [id, row] of store) {
      if (matchesWhere(row, where)) {
        store.set(id, applyData(row, data))
        count++
      }
    }
    return { count }
  })
  const findMany = vi.fn(() => Array.from(store.values()).map(r => ({ ...r })))
  const get = (id: string) => ({ ...store.get(id) })

  const tx = {
    eSIMTopUp: { updateMany, update, findUnique },
    eSIM: { update: vi.fn().mockResolvedValue({}) },
    invoice: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'inv-1' }) },
    billingRecord: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'br-1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }

  return { store, findUnique, update, updateMany, findMany, get, tx }
}

// ──────────────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────────────

const topUpStoreRef: { current: ReturnType<typeof makeTopUpStore> | null } = { current: null }

vi.mock('@/lib/prisma', () => {
  const store = topUpStoreRef
  const prisma = {
    eSIMTopUp: {
      findUnique: (args: any) => store.current!.findUnique(args),
      update: (args: any) => store.current!.update(args),
      updateMany: (args: any) => store.current!.updateMany(args),
      findMany: (args: any) => store.current!.findMany(args),
    },
    eSIM: { findUnique: vi.fn() },
    provider: { findUnique: vi.fn() },
    eSIMPackage: { findUnique: vi.fn() },
    $transaction: (cb: any) => cb(store.current!.tx),
  }
  return { prisma }
})

vi.mock('@/lib/providers/adapter-manager', () => ({
  getAdapterForProvider: vi.fn(),
}))

vi.mock('@/lib/services/orders/wallet-actions', () => ({
  captureTopUpFundsUpToInTx: vi.fn().mockResolvedValue({ success: true }),
  releaseTopUpFundsUpToInTx: vi.fn().mockResolvedValue({ success: true, released: 10 }),
}))

vi.mock('@/lib/services/orders/order-state-machine', () => ({
  createTimelineEvent: vi.fn().mockResolvedValue(undefined),
}))

const { prisma } = await import('@/lib/prisma')
const { getAdapterForProvider } = await import('@/lib/providers/adapter-manager')
const { captureTopUpFundsUpToInTx, releaseTopUpFundsUpToInTx } = await import('@/lib/services/orders/wallet-actions')
const {
  reconcileTopUpById,
  manualRetryTopUpReconciliation,
  runTopUpReconciliationBatch,
  claimTopUpForReconciliation,
  getNextReconcileAt,
  getNextReconcileDelayMinutes,
  RECONCILE_ESCALATION_THRESHOLD,
  RECONCILE_LEASE_MS,
} = await import('./top-up-reconciliation')

const mockPrisma = vi.mocked(prisma)
const mockCapture = vi.mocked(captureTopUpFundsUpToInTx)
const mockRelease = vi.mocked(releaseTopUpFundsUpToInTx)
const mockGetAdapter = vi.mocked(getAdapterForProvider)

function makeTopUp(overrides: any = {}) {
  return {
    id: 'topup-1',
    businessId: 'biz-1',
    esimId: 'esim-1',
    packageId: 'pkg-1',
    providerId: 'prov-1',
    amount: 80,
    currency: 'USD',
    status: 'PENDING_REVIEW',
    quotedUnitPrice: 100,
    quotedTotalAmount: 100,
    quotedCurrency: 'USD',
    quotedQuantity: 1,
    requestedQuantity: 1,
    reconciliationAttempts: 0,
    nextReconcileAt: null,
    lastReconcileAt: null,
    lastReconcileErrorCode: null,
    reconcileLockedAt: null,
    reconcileLockOwner: null,
    reconciliationEscalatedAt: null,
    dataAddedMB: null,
    validityDaysAdded: null,
    providerReference: null,
    errorMessage: null,
    createdAt: new Date(),
    completedAt: null,
    ...overrides,
  }
}

const esim = {
  id: 'esim-1',
  iccid: '89012345678901234567',
  imsi: null,
  expiresAt: new Date('2026-09-01T00:00:00Z'),
  dataTotalMB: 1024,
  dataRemainingMB: 900,
  purchaseId: 'order-1',
}

const provider = { id: 'prov-1', adapterStrategy: 'CHOICE', type: 'CHOICE', code: 'CHOICE', statusPath: null }

const topUpPkg = { id: 'pkg-1', dataGB: 1, validityDays: 30 }

function makeAdapter(overrides: any = {}) {
  return {
    getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', rawStatus: 'active' } }),
    getUsage: vi.fn().mockResolvedValue({ success: true, data: { dataTotalMB: 2048, dataRemainingMB: 1900, expiresAt: '2026-10-01T00:00:00Z' } }),
    topUpESIM: vi.fn().mockResolvedValue({ success: true, data: {} }),
    ...overrides,
  }
}

function freshStore(topUpRow: any) {
  const store = makeTopUpStore([topUpRow])
  topUpStoreRef.current = store
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
  topUpStoreRef.current = null
  mockCapture.mockResolvedValue({ success: true })
  mockRelease.mockResolvedValue({ success: true, released: 10 })
  mockPrisma.eSIM.findUnique.mockResolvedValue({ ...esim } as any)
  mockPrisma.provider.findUnique.mockResolvedValue(provider as any)
  mockPrisma.eSIMPackage.findUnique.mockResolvedValue(topUpPkg as any)
  mockGetAdapter.mockResolvedValue(makeAdapter() as any)
})

describe('retry / escalation policy', () => {
  it('applies the documented backoff schedule', () => {
    expect(getNextReconcileDelayMinutes(1)).toBe(5)
    expect(getNextReconcileDelayMinutes(2)).toBe(15)
    expect(getNextReconcileDelayMinutes(3)).toBe(30)
    expect(getNextReconcileDelayMinutes(4)).toBe(120)
    expect(getNextReconcileDelayMinutes(5)).toBeNull()
  })

  it('schedules nextReconcileAt from the backoff', () => {
    const before = Date.now()
    const next = getNextReconcileAt(1)!
    expect(next.getTime() - before).toBeGreaterThanOrEqual(5 * 60 * 1000 - 2000)
  })

  it('threshold matches the backoff length (attempt 5 escalates)', () => {
    expect(RECONCILE_ESCALATION_THRESHOLD).toBe(4)
  })
})

describe('claiming — concurrency + crash lease', () => {
  it('two workers cannot claim the same top-up', async () => {
    freshStore(makeTopUp())
    expect(await claimTopUpForReconciliation('topup-1', 'worker-a')).toBe(true)
    // Second worker: lock is live → no claim, attempts not double-incremented.
    expect(await claimTopUpForReconciliation('topup-1', 'worker-b')).toBe(false)
    const row = topUpStoreRef.current!.get('topup-1')
    expect(row.reconcileLockOwner).toBe('worker-a')
    expect(row.reconciliationAttempts).toBe(1)
  })

  it('an expired claim lease is reclaimed', async () => {
    freshStore(makeTopUp({
      reconcileLockedAt: new Date(Date.now() - (RECONCILE_LEASE_MS + 60_000)),
      reconcileLockOwner: 'crashed-worker',
      reconciliationAttempts: 1,
    }))
    expect(await claimTopUpForReconciliation('topup-1', 'worker-c')).toBe(true)
    const row = topUpStoreRef.current!.get('topup-1')
    expect(row.reconcileLockOwner).toBe('worker-c')
    expect(row.reconciliationAttempts).toBe(2)
  })
})

describe('reconciliation — provider mutation is NEVER re-dispatched', () => {
  it('PENDING_REVIEW reconciliation never calls adapter.topUpESIM', async () => {
    const adapter = makeAdapter()
    mockGetAdapter.mockResolvedValue(adapter as any)
    freshStore(makeTopUp())

    await reconcileTopUpById('topup-1', 'worker-1')

    expect(adapter.topUpESIM).not.toHaveBeenCalled()
    expect(adapter.getActivationStatus).toHaveBeenCalledTimes(1)
  })
})

describe('FOUND_SUCCESS', () => {
  it('captures up to the immutable quotedTotalAmount and marks COMPLETED', async () => {
    freshStore(makeTopUp())
    const result = await reconcileTopUpById('topup-1', 'worker-1')

    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(mockCapture).toHaveBeenCalledWith(expect.anything(), 'topup-1', 'biz-1', 100)
    const row = topUpStoreRef.current!.get('topup-1')
    expect(row.status).toBe('COMPLETED')
    expect(row.completedAt).not.toBeNull()
  })

  it('the provider response cannot alter the charge (quoted amount wins over amount field)', async () => {
    // topUp.amount = 80 but immutable quote = 100; provider reports something else.
    freshStore(makeTopUp({ amount: 80, quotedTotalAmount: 100 }))
    const result = await reconcileTopUpById('topup-1', 'worker-1')
    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(mockCapture).toHaveBeenCalledWith(expect.anything(), 'topup-1', 'biz-1', 100)
    expect(mockCapture).not.toHaveBeenCalledWith(expect.anything(), 'topup-1', 'biz-1', 80)
  })

  it('duplicate reconciliation is a no-op — capture happens exactly once', async () => {
    const store = freshStore(makeTopUp())
    await reconcileTopUpById('topup-1', 'worker-1')
    expect(store.get('topup-1').status).toBe('COMPLETED')

    // A second reconcile of the same row is skipped (claim guard).
    const second = await reconcileTopUpById('topup-1', 'worker-2')
    expect(second.skipped).toBe(true)
    expect(mockCapture).toHaveBeenCalledTimes(1)
  })

  it('creates an idempotent invoice + billing record', async () => {
    freshStore(makeTopUp())
    await reconcileTopUpById('topup-1', 'worker-1')
    const tx = topUpStoreRef.current!.tx
    expect(tx.invoice.create).toHaveBeenCalledTimes(1)
    expect(tx.billingRecord.create).toHaveBeenCalledTimes(1)
    expect(tx.billingRecord.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'TOPUP', amount: 100, invoiceId: 'inv-1' }) }))
  })
})

describe('FOUND_FAILURE', () => {
  it('releases the outstanding reserved amount once and marks FAILED', async () => {
    const adapter = makeAdapter({ getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'FAILED', rawStatus: 'failed' } }) })
    mockGetAdapter.mockResolvedValue(adapter as any)
    freshStore(makeTopUp())

    const result = await reconcileTopUpById('topup-1', 'worker-1')

    expect(result.outcome).toBe('FOUND_FAILURE')
    expect(mockRelease).toHaveBeenCalledTimes(1)
    expect(mockRelease).toHaveBeenCalledWith(expect.anything(), 'topup-1', 'biz-1', 100)
    const row = topUpStoreRef.current!.get('topup-1')
    expect(row.status).toBe('FAILED')
    expect(mockCapture).not.toHaveBeenCalled()
  })

  it('duplicate failure reconciliation is a no-op — release happens exactly once', async () => {
    const adapter = makeAdapter({ getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'CANCELLED' } }) })
    mockGetAdapter.mockResolvedValue(adapter as any)
    const store = freshStore(makeTopUp())

    await reconcileTopUpById('topup-1', 'worker-1')
    expect(store.get('topup-1').status).toBe('FAILED')
    const second = await reconcileTopUpById('topup-1', 'worker-2')
    expect(second.skipped).toBe(true)
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })
})

describe('STILL_UNKNOWN', () => {
  it('keeps the reservation held and schedules a later retry', async () => {
    const adapter = makeAdapter({ getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', rawStatus: 'active' } }), getUsage: vi.fn().mockResolvedValue({ success: true, data: { dataTotalMB: 1024, dataRemainingMB: 900 } }) })
    mockGetAdapter.mockResolvedValue(adapter as any)
    freshStore(makeTopUp())

    const result = await reconcileTopUpById('topup-1', 'worker-1')

    expect(result.outcome).toBe('STILL_UNKNOWN')
    expect(result.applied).toBe(false)
    expect(mockCapture).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
    const row = topUpStoreRef.current!.get('topup-1')
    expect(row.status).toBe('PENDING_REVIEW')
    expect(row.nextReconcileAt).not.toBeNull()
    expect(row.nextReconcileAt.getTime() - Date.now()).toBeGreaterThanOrEqual(4 * 60 * 1000)
    expect(row.reconciliationAttempts).toBe(1)
  })

  it('escalates to NEEDS_REVIEW after the retry threshold', async () => {
    const adapter = makeAdapter({ getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE' } }), getUsage: vi.fn().mockResolvedValue({ success: true, data: { dataTotalMB: 1024 } }) })
    mockGetAdapter.mockResolvedValue(adapter as any)
    freshStore(makeTopUp({ reconciliationAttempts: RECONCILE_ESCALATION_THRESHOLD }))

    const result = await reconcileTopUpById('topup-1', 'worker-1')

    expect(result.outcome).toBe('STILL_UNKNOWN')
    expect(result.escalated).toBe(true)
    const row = topUpStoreRef.current!.get('topup-1')
    expect(row.reconciliationEscalatedAt).not.toBeNull()
    expect(row.nextReconcileAt).toBeNull()
    expect(row.lastReconcileErrorCode).toBe('NO_CONFIRMATION')
  })

  it('a provider that cannot verify keeps funds reserved and escalates (never guesses)', async () => {
    mockGetAdapter.mockResolvedValue(makeAdapter() as any)
    // iBASIS — no read-only verification capability.
    mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-1', adapterStrategy: 'IBASIS', type: 'IBASIS', code: 'IBASIS', statusPath: null } as any)
    freshStore(makeTopUp({ reconciliationAttempts: RECONCILE_ESCALATION_THRESHOLD }))

    const result = await reconcileTopUpById('topup-1', 'worker-1')

    expect(result.outcome).toBe('STILL_UNKNOWN')
    expect(result.escalated).toBe(true)
    const row = topUpStoreRef.current!.get('topup-1')
    expect(row.status).toBe('PENDING_REVIEW')
    expect(row.reconciliationEscalatedAt).not.toBeNull()
    expect(mockCapture).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
  })
})

describe('background batch', () => {
  it('processes only due, non-escalated, non-locked top-ups', async () => {
    const adapter = makeAdapter()
    mockGetAdapter.mockResolvedValue(adapter as any)
    const store = makeTopUpStore([
      makeTopUp({ id: 't1', reconciliationAttempts: 0 }), // due + unclaimed → processed
      makeTopUp({ id: 't2', reconciliationAttempts: 2, nextReconcileAt: new Date(Date.now() + 3600_000) }), // not due yet
      makeTopUp({ id: 't3', reconciliationAttempts: 0, reconciliationEscalatedAt: new Date() }), // escalated → skipped
    ])
    topUpStoreRef.current = store

    const stats = await runTopUpReconciliationBatch(20, 'worker-batch')

    expect(stats.processed).toBe(1)
    expect(store.get('t1').status).toBe('COMPLETED')
    expect(store.get('t2').status).toBe('PENDING_REVIEW')
    expect(store.get('t3').status).toBe('PENDING_REVIEW')
    expect(adapter.topUpESIM).not.toHaveBeenCalled()
  })
})

describe('admin manual retry', () => {
  it('uses the same reconciliation path (read-only verify + capture) and clears escalation', async () => {
    const adapter = makeAdapter()
    mockGetAdapter.mockResolvedValue(adapter as any)
    freshStore(makeTopUp({ reconciliationAttempts: 5, reconciliationEscalatedAt: new Date() }))

    const result = await manualRetryTopUpReconciliation('topup-1')

    expect(result.outcome).toBe('FOUND_SUCCESS')
    expect(adapter.getActivationStatus).toHaveBeenCalledTimes(1)
    expect(adapter.topUpESIM).not.toHaveBeenCalled()
    expect(mockCapture).toHaveBeenCalledWith(expect.anything(), 'topup-1', 'biz-1', 100)
    const row = topUpStoreRef.current!.get('topup-1')
    expect(row.status).toBe('COMPLETED')
  })

  it('an unknown result from admin retry re-schedules without guessing', async () => {
    const adapter = makeAdapter({ getActivationStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE' } }), getUsage: vi.fn().mockResolvedValue({ success: true, data: { dataTotalMB: 1024 } }) })
    mockGetAdapter.mockResolvedValue(adapter as any)
    freshStore(makeTopUp())

    const result = await manualRetryTopUpReconciliation('topup-1')

    expect(result.outcome).toBe('STILL_UNKNOWN')
    expect(mockCapture).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
    const row = topUpStoreRef.current!.get('topup-1')
    expect(row.status).toBe('PENDING_REVIEW')
    expect(row.nextReconcileAt).not.toBeNull()
  })
})
