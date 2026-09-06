import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    walletTransaction: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn().mockResolvedValue({}) },
    business: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    eSIMPurchase: { findUnique: vi.fn() },
    providerAttempt: { findFirst: vi.fn() },
  },
}))

vi.mock('@/lib/services/orders/order-state-machine', () => ({
  createTimelineEvent: vi.fn().mockResolvedValue(undefined),
}))

const { prisma } = await import('@/lib/prisma')
const {
  reserveWalletFunds,
  captureReservedFundsUpTo,
  releaseReservedFundsUpTo,
  refundCapturedFunds,
  reserveTopUpFunds,
  captureTopUpFundsUpTo,
  releaseTopUpFundsUpTo,
  refundTopUpFunds,
} = await import('./wallet-actions')

const mockPrisma = vi.mocked(prisma)

// Interactive-transaction mock: reserve/capture helpers run inside $transaction((tx) => ...).
// Delegate tx wallet reads/writes to the shared prisma mocks.
const txMock = {
  walletTransaction: {
    findFirst: (...a: any[]) => (mockPrisma.walletTransaction.findFirst as any)(...a),
    findMany: (...a: any[]) => (mockPrisma.walletTransaction.findMany as any)(...a),
    create: (...a: any[]) => (mockPrisma.walletTransaction.create as any)(...a),
  },
  business: {
    findUnique: (...a: any[]) => (mockPrisma.business.findUnique as any)(...a),
    updateMany: (...a: any[]) => (mockPrisma.business.updateMany as any)(...a),
    update: (...a: any[]) => (mockPrisma.business.update as any)(...a),
  },
}
;(mockPrisma as any).$transaction = vi.fn(async (arg: any) => {
  if (Array.isArray(arg)) return Promise.all(arg.map((op: any) => Promise.resolve(op)))
  return arg(txMock)
})

// New provider-owned release gate defaults: order not provider-owned, no live attempts.
mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-1', providerId: null, providerFulfillId: null, providerReservationId: null })
mockPrisma.providerAttempt.findFirst.mockResolvedValue(null)

function mockReserve(amount = -50) {
  mockPrisma.walletTransaction.findFirst.mockImplementation(({ where: { type } }: any) =>
    type === 'WALLET_RESERVE' ? Promise.resolve({ id: 'r1', amount }) : Promise.resolve(null)
  )
}

describe('captureReservedFundsUpTo', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('captures exactly the requested total, capped by the reservation', async () => {
    mockReserve(-50)
    mockPrisma.walletTransaction.findMany.mockResolvedValue([])

    const result = await captureReservedFundsUpTo('order-1', 'biz-1', 60)

    expect(result.success).toBe(true)
    // Requested 60 but only 50 reserved → capture is capped at 50.
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 50, type: 'WALLET_CAPTURE' }) })
  })

  it('is idempotent: same cumulative target never captures twice', async () => {
    mockReserve(-50)
    mockPrisma.walletTransaction.findMany.mockResolvedValue([{ amount: 30 }])

    const result = await captureReservedFundsUpTo('order-1', 'biz-1', 30)

    expect(result.success).toBe(true)
    expect(result.alreadyCaptured).toBe(true)
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled()
  })

  it('captures only the delta for a new cumulative total (incremental)', async () => {
    mockReserve(-50)
    mockPrisma.walletTransaction.findMany.mockResolvedValue([{ amount: 30 }])

    const result = await captureReservedFundsUpTo('order-1', 'biz-1', 50)

    expect(result.success).toBe(true)
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 20, type: 'WALLET_CAPTURE' }) })
  })

  it('never captures without a reservation', async () => {
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)

    const result = await captureReservedFundsUpTo('order-1', 'biz-1', 10)

    expect(result.success).toBe(false)
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled()
  })
})

describe('releaseReservedFundsUpTo', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('releases only the un-captured remainder on a partially captured order', async () => {
    mockReserve(-50)
    mockPrisma.walletTransaction.findMany.mockImplementation(({ where: { type } }: any) => {
      if (type === 'WALLET_CAPTURE') return Promise.resolve([{ amount: 30 }])
      if (type === 'WALLET_RELEASE') return Promise.resolve([])
      return Promise.resolve([]) // REFUND
    })

    const result = await releaseReservedFundsUpTo('order-1', 'biz-1', 50)

    expect(result.success).toBe(true)
    // reserved 50 − captured 30 = remainder 20 — never more.
    expect(result.released).toBe(20)
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 20, type: 'WALLET_RELEASE' }) })
    expect(mockPrisma.business.update).toHaveBeenCalledWith({ where: { id: 'biz-1' }, data: { walletBalance: { increment: 20 } } })
  })

  it('capture + release never exceeds the reservation', async () => {
    mockReserve(-50)
    mockPrisma.walletTransaction.findMany.mockImplementation(({ where: { type } }: any) => {
      if (type === 'WALLET_CAPTURE') return Promise.resolve([{ amount: 30 }])
      if (type === 'WALLET_RELEASE') return Promise.resolve([{ amount: 20 }])
      return Promise.resolve([])
    })

    // Already released 20 of the 20 remaining → nothing further can be released.
    const result = await releaseReservedFundsUpTo('order-1', 'biz-1', 50)

    expect(result.success).toBe(true)
    expect(result.released).toBe(0)
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled()
  })

  it('is idempotent per cumulative target', async () => {
    mockReserve(-50)
    mockPrisma.walletTransaction.findMany.mockImplementation(({ where: { type } }: any) => {
      if (type === 'WALLET_CAPTURE') return Promise.resolve([{ amount: 30 }])
      if (type === 'WALLET_RELEASE') return Promise.resolve([{ amount: 20 }])
      return Promise.resolve([])
    })

    const result = await releaseReservedFundsUpTo('order-1', 'biz-1', 30)

    expect(result.success).toBe(true)
    expect(result.released).toBe(0)
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled()
  })
})

describe('wallet arithmetic (business.walletBalance is the single spendable field)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  // Reserve decrements; capture is ledger-only (no balance change); release/refund increment.
  it('$100 reserve $20 → $80, capture $20 → $80, release → $100 (terminal equality)', async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ walletBalance: 100 })

    // Reserve step: no existing reservation yet → proceeds to the atomic decrement.
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)
    mockPrisma.walletTransaction.findMany.mockResolvedValue([])

    await reserveWalletFunds('order-1', 'biz-1', 20)
    expect(mockPrisma.business.updateMany).toHaveBeenCalledWith(
      { where: { id: 'biz-1', walletBalance: { gte: 20 } }, data: { walletBalance: { decrement: 20 } } })

    // Capture step: a RESERVE now exists, no captures yet → creates the CAPTURE (ledger-only).
    mockPrisma.walletTransaction.findFirst.mockImplementation(({ where: { type } }: any) =>
      type === 'WALLET_RESERVE' ? Promise.resolve({ id: 'r1', amount: -20 }) : Promise.resolve(null)
    )
    mockPrisma.walletTransaction.create.mockClear()
    mockPrisma.business.update.mockClear()
    mockPrisma.business.updateMany.mockClear()
    const capture = await captureReservedFundsUpTo('order-1', 'biz-1', 20)
    expect(capture.success).toBe(true)
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 20, type: 'WALLET_CAPTURE' }) })
    expect(mockPrisma.business.update).not.toHaveBeenCalled()
    expect(mockPrisma.business.updateMany).not.toHaveBeenCalled()

    // Release step: fully captured → nothing left to release (release ≤ reserved − captured).
    mockPrisma.walletTransaction.findMany.mockImplementation(({ where: { type } }: any) =>
      type === 'WALLET_CAPTURE' ? Promise.resolve([{ amount: 20 }]) : Promise.resolve([])
    )
    mockPrisma.walletTransaction.create.mockClear()
    const release = await releaseReservedFundsUpTo('order-1', 'biz-1', 20)
    expect(release.released).toBe(0)
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled()
  })

  it('reserve $20 then release $20 restores the full $100 (definite-failure path)', async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ walletBalance: 100 })
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)
    mockPrisma.walletTransaction.findMany.mockResolvedValue([])

    await reserveWalletFunds('order-1', 'biz-1', 20)
    expect(mockPrisma.business.updateMany).toHaveBeenCalledWith(
      { where: { id: 'biz-1', walletBalance: { gte: 20 } }, data: { walletBalance: { decrement: 20 } } })

    mockPrisma.walletTransaction.findFirst.mockImplementation(({ where: { type } }: any) =>
      type === 'WALLET_RESERVE' ? Promise.resolve({ id: 'r1', amount: -20 }) : Promise.resolve(null)
    )
    mockPrisma.walletTransaction.create.mockClear()
    const release = await releaseReservedFundsUpTo('order-1', 'biz-1', 20)

    expect(release.released).toBe(20)
    expect(mockPrisma.business.update).toHaveBeenCalledWith({ where: { id: 'biz-1' }, data: { walletBalance: { increment: 20 } } })
  })

  it('$100 reserve $50 → $50, capture $30 (ledger only), release $20 → $70', async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ walletBalance: 100 })

    // Reserve step: no existing reservation → decrement 50.
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)
    mockPrisma.walletTransaction.findMany.mockResolvedValue([])
    await reserveWalletFunds('order-1', 'biz-1', 50)
    expect(mockPrisma.business.updateMany).toHaveBeenCalledWith(
      { where: { id: 'biz-1', walletBalance: { gte: 50 } }, data: { walletBalance: { decrement: 50 } } })

    // Capture step: RESERVE exists, nothing captured → creates CAPTURE 30, no balance change.
    mockPrisma.walletTransaction.findFirst.mockImplementation(({ where: { type } }: any) =>
      type === 'WALLET_RESERVE' ? Promise.resolve({ id: 'r1', amount: -50 }) : Promise.resolve(null)
    )
    mockPrisma.walletTransaction.create.mockClear()
    mockPrisma.business.update.mockClear()
    const capture = await captureReservedFundsUpTo('order-1', 'biz-1', 30)
    expect(capture.success).toBe(true)
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 30, type: 'WALLET_CAPTURE' }) })
    expect(mockPrisma.business.update).not.toHaveBeenCalled()

    // Release step: 50 reserved − 30 captured = 20 remainder → exactly 20 is returned.
    mockPrisma.walletTransaction.findMany.mockImplementation(({ where: { type } }: any) =>
      type === 'WALLET_CAPTURE' ? Promise.resolve([{ amount: 30 }]) : Promise.resolve([])
    )
    mockPrisma.walletTransaction.create.mockClear()
    const release = await releaseReservedFundsUpTo('order-1', 'biz-1', 50)
    expect(release.released).toBe(20)
    expect(mockPrisma.business.update).toHaveBeenCalledWith({ where: { id: 'biz-1' }, data: { walletBalance: { increment: 20 } } })
  })

  it('partial 5×$10: cumulative capture 3→$30, then +1→ delta $10, duplicate → no-op', async () => {
    mockReserve(-50)
    mockPrisma.walletTransaction.findMany.mockResolvedValue([])

    await captureReservedFundsUpTo('order-1', 'biz-1', 30)
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 30, type: 'WALLET_CAPTURE' }) })

    mockPrisma.walletTransaction.create.mockClear()
    mockPrisma.walletTransaction.findMany.mockResolvedValue([{ amount: 30 }])
    await captureReservedFundsUpTo('order-1', 'biz-1', 40)
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 10, type: 'WALLET_CAPTURE' }) })

    mockPrisma.walletTransaction.create.mockClear()
    mockPrisma.walletTransaction.findMany.mockResolvedValue([{ amount: 30 }, { amount: 10 }])
    const dup = await captureReservedFundsUpTo('order-1', 'biz-1', 40)
    expect(dup.alreadyCaptured).toBe(true)
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled()
  })
})

describe('billing identity (orderId vs topUpId — exactly one populated)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  mockPrisma.business.findUnique.mockResolvedValue({ walletBalance: 100 })

  it('purchase reserve keys the RESERVE by orderId and never topUpId', async () => {
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)

    await reserveWalletFunds('order-1', 'biz-1', 20)

    const data = mockPrisma.walletTransaction.create.mock.calls[0][0].data
    expect(data.orderId).toBe('order-1')
    expect(data.topUpId).toBeUndefined()
    expect(data.type).toBe('WALLET_RESERVE')
    expect(data.amount).toBe(-20)
  })

  it('top-up reserve keys the RESERVE by topUpId and never orderId', async () => {
    mockPrisma.walletTransaction.findFirst.mockResolvedValue(null)

    await reserveTopUpFunds('topup-1', 'biz-1', 20)

    const data = mockPrisma.walletTransaction.create.mock.calls[0][0].data
    expect(data.topUpId).toBe('topup-1')
    expect(data.orderId).toBeUndefined()
    expect(data.type).toBe('WALLET_RESERVE')
    expect(data.amount).toBe(-20)
  })

  it('a top-up reservation cannot be satisfied by a purchase reservation', async () => {
    // A purchase RESERVE exists for order-1; a top-up reserve for topup-1 must NOT
    // find it (reserveCore queries by topUpId, so it performs its own reservation).
    mockPrisma.walletTransaction.findFirst.mockImplementation(({ where }: any) =>
      where.orderId === 'order-1' && where.type === 'WALLET_RESERVE' ? Promise.resolve({ id: 'r1', amount: -20 }) : Promise.resolve(null)
    )

    await reserveTopUpFunds('topup-1', 'biz-1', 20)

    expect(mockPrisma.business.updateMany).toHaveBeenCalled() // new reservation created, not short-circuited
    const data = mockPrisma.walletTransaction.create.mock.calls[0][0].data
    expect(data.topUpId).toBe('topup-1')
  })
})

describe('captureTopUpFundsUpTo / releaseTopUpFundsUpTo', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('captures up to a cumulative total keyed by topUpId', async () => {
    mockPrisma.walletTransaction.findFirst.mockImplementation(({ where: { type } }: any) =>
      type === 'WALLET_RESERVE' ? Promise.resolve({ id: 'r1', amount: -50 }) : Promise.resolve(null)
    )
    mockPrisma.walletTransaction.findMany.mockResolvedValue([])

    const result = await captureTopUpFundsUpTo('topup-1', 'biz-1', 50)

    expect(result.success).toBe(true)
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ topUpId: 'topup-1', amount: 50, type: 'WALLET_CAPTURE' }) })
    const data = mockPrisma.walletTransaction.create.mock.calls[0][0].data
    expect(data.orderId).toBeUndefined()
  })

  it('releases only the un-captured remainder back to the wallet (keyed by topUpId)', async () => {
    mockPrisma.walletTransaction.findFirst.mockImplementation(({ where: { type } }: any) =>
      type === 'WALLET_RESERVE' ? Promise.resolve({ id: 'r1', amount: -50 }) : Promise.resolve(null)
    )
    mockPrisma.walletTransaction.findMany.mockImplementation(({ where: { type } }: any) => {
      if (type === 'WALLET_CAPTURE') return Promise.resolve([{ amount: 30 }])
      return Promise.resolve([])
    })

    const result = await releaseTopUpFundsUpTo('topup-1', 'biz-1', 50)

    expect(result.released).toBe(20)
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ topUpId: 'topup-1', amount: 20, type: 'WALLET_RELEASE' }) })
    expect(mockPrisma.business.update).toHaveBeenCalledWith({ where: { id: 'biz-1' }, data: { walletBalance: { increment: 20 } } })
  })

  it('refuses to capture top-up funds when only a purchase reservation exists', async () => {
    // RESERVE exists for order-1 (a purchase), none for topup-1 → top-up capture fails.
    mockPrisma.walletTransaction.findFirst.mockImplementation(({ where: { type } }: any) =>
      type === 'WALLET_RESERVE' && where.orderId === 'order-1' ? Promise.resolve({ id: 'r1', amount: -50 }) : Promise.resolve(null)
    )
    mockPrisma.walletTransaction.findMany.mockResolvedValue([])

    const result = await captureTopUpFundsUpTo('topup-1', 'biz-1', 50)

    expect(result.success).toBe(false)
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled()
  })
})

describe('refund distinction (purchase vs top-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.walletTransaction.findFirst.mockImplementation(({ where: { type } }: any) =>
      type === 'WALLET_CAPTURE' ? Promise.resolve({ id: 'c1', amount: 30 }) : Promise.resolve(null)
    )
  })

  it('refundCapturedFunds keys the WALLET_REFUND by orderId only', async () => {
    const result = await refundCapturedFunds('order-1', 'biz-1', 30)

    expect(result.success).toBe(true)
    expect(mockPrisma.business.update).toHaveBeenCalledWith({ where: { id: 'biz-1' }, data: { walletBalance: { increment: 30 } } })
    const data = mockPrisma.walletTransaction.create.mock.calls[0][0].data
    expect(data.orderId).toBe('order-1')
    expect(data.topUpId).toBeUndefined()
    expect(data.type).toBe('WALLET_REFUND')
  })

  it('refundTopUpFunds keys the WALLET_REFUND by topUpId only', async () => {
    const result = await refundTopUpFunds('topup-1', 'biz-1', 30)

    expect(result.success).toBe(true)
    expect(mockPrisma.business.update).toHaveBeenCalledWith({ where: { id: 'biz-1' }, data: { walletBalance: { increment: 30 } } })
    const data = mockPrisma.walletTransaction.create.mock.calls[0][0].data
    expect(data.topUpId).toBe('topup-1')
    expect(data.orderId).toBeUndefined()
    expect(data.type).toBe('WALLET_REFUND')
  })
})
