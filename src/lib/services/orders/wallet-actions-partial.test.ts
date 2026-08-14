import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    walletTransaction: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn().mockResolvedValue({}) },
    business: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
}))

vi.mock('@/lib/services/orders/order-state-machine', () => ({
  createTimelineEvent: vi.fn().mockResolvedValue(undefined),
}))

const { prisma } = await import('@/lib/prisma')
const { captureReservedFundsUpTo, releaseReservedFundsUpTo } = await import('./wallet-actions')

const mockPrisma = vi.mocked(prisma)

// Interactive-transaction mock: capture helpers run inside $transaction((tx) => ...).
// Delegate tx wallet reads/writes to the shared prisma mocks.
const txMock = {
  walletTransaction: {
    findFirst: (...a: any[]) => (mockPrisma.walletTransaction.findFirst as any)(...a),
    findMany: (...a: any[]) => (mockPrisma.walletTransaction.findMany as any)(...a),
    create: (...a: any[]) => (mockPrisma.walletTransaction.create as any)(...a),
  },
}
;(mockPrisma as any).$transaction = vi.fn(async (arg: any) => {
  if (Array.isArray(arg)) return Promise.all(arg.map((op: any) => Promise.resolve(op)))
  return arg(txMock)
})

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
