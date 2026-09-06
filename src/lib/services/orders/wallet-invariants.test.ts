import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDb = vi.hoisted(() => ({
  walletTransaction: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
  },
  business: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  eSIMPurchase: { findUnique: vi.fn() },
  providerAttempt: { findFirst: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    ...mockDb,
    $transaction: vi.fn((fn: any) => fn(mockDb)),
  },
}))

vi.mock('./order-state-machine', () => ({
  createTimelineEvent: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { reserveWalletFunds, captureReservedFunds, releaseReservedFunds, refundCapturedFunds } from './wallet-actions'

const mockPrisma = vi.mocked(prisma)

function txOfType(type: string) {
  return { orderId: 'order-1', type, amount: 5 }
}

const {
  walletTransaction,
  business,
  eSIMPurchase,
} = mockDb

beforeEach(() => {
  vi.clearAllMocks()
  business.findUnique.mockResolvedValue({ id: 'biz-1', walletBalance: { toString: () => '100' } })
  business.updateMany.mockResolvedValue({ count: 1 })
  business.update.mockResolvedValue({})
  walletTransaction.create.mockResolvedValue({})
  walletTransaction.findMany.mockResolvedValue([])
  eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-1', providerId: null, providerFulfillId: null, providerReservationId: null })
  prisma.providerAttempt.findFirst.mockResolvedValue(null)
})

describe('wallet invariants', () => {
  it('reserve is a single atomic debit (never double reserve)', async () => {
    walletTransaction.findFirst.mockResolvedValueOnce(null) // first call: no existing reserve

    const first = await reserveWalletFunds('order-1', 'biz-1', 5)
    expect(first.success).toBe(true)
    expect(business.updateMany).toHaveBeenCalledTimes(1)
    expect(walletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'WALLET_RESERVE', amount: -5 }) }))

    // Second reserve sees the existing RESERVE entry → no-op
    walletTransaction.findFirst.mockResolvedValueOnce(txOfType('WALLET_RESERVE'))
    const second = await reserveWalletFunds('order-1', 'biz-1', 5)
    expect(second.success).toBe(true)
    expect(business.updateMany).toHaveBeenCalledTimes(1) // unchanged
    expect(walletTransaction.create).toHaveBeenCalledTimes(1) // unchanged
  })

  it('capture is blocked when there is no reservation', async () => {
    walletTransaction.findFirst.mockResolvedValue(null)
    const result = await captureReservedFunds('order-1', 'biz-1', 5)
    expect(result.success).toBe(false)
    expect(result.error).toContain('No reservation')
  })

  it('never CAPTURE after RELEASE', async () => {
    walletTransaction.findFirst.mockImplementation(async ({ where }) => {
      if (where?.type === 'WALLET_RESERVE') return txOfType('WALLET_RESERVE')
      if (where?.type === 'WALLET_RELEASE') return txOfType('WALLET_RELEASE')
      return null
    })
    const result = await captureReservedFunds('order-1', 'biz-1', 5)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/released|manual reconciliation/)
    expect(walletTransaction.create).not.toHaveBeenCalled()
  })

  it('never RELEASE after CAPTURE', async () => {
    walletTransaction.findFirst.mockImplementation(async ({ where }) => {
      if (where?.type === 'WALLET_CAPTURE') return txOfType('WALLET_CAPTURE')
      return null
    })
    const result = await releaseReservedFunds('order-1', 'biz-1', 5)
    expect(result.success).toBe(false)
    expect(result.blocked).toBe(true)
    expect(business.update).not.toHaveBeenCalled()
  })

  it('release is blocked when provider fulfillment evidence exists', async () => {
    eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-1', providerFulfillId: 'AH-1', providerReservationId: null })
    walletTransaction.findFirst.mockImplementation(async ({ where }) => {
      if (where?.type === 'WALLET_RESERVE') return txOfType('WALLET_RESERVE')
      return null
    })
    const result = await releaseReservedFunds('order-1', 'biz-1', 5)
    expect(result.success).toBe(false)
    expect(result.blocked).toBe(true)
  })

  it('release is idempotent (never double release)', async () => {
    walletTransaction.findFirst.mockImplementation(async ({ where }) => {
      if (where?.type === 'WALLET_RELEASE') return txOfType('WALLET_RELEASE')
      return null
    })
    const result = await releaseReservedFunds('order-1', 'biz-1', 5)
    expect(result.success).toBe(true)
    expect(business.update).not.toHaveBeenCalled()
    expect(walletTransaction.create).not.toHaveBeenCalled()
  })

  it('refund requires a prior capture', async () => {
    walletTransaction.findFirst.mockResolvedValue(null)
    const result = await refundCapturedFunds('order-1', 'biz-1', 5)
    expect(result.success).toBe(false)
    expect(result.error).toContain('No captured funds')
  })
})