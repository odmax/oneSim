import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Phase 3.8 — wallet reserve atomicity + error-contract audit.
 *
 * Proves that reserveCore's debit decision is made exclusively by the atomic
 * conditional business.updateMany (WHERE id + walletBalance >= amount), that the
 * success path performs NO business pre-read, and that the failure-only lookup
 * preserves the exact externally-visible messages ('Business not found' vs
 * 'Insufficient wallet balance. Required: X, Available: Y').
 */

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
import { reserveWalletFunds } from './wallet-actions'

const mock = vi.mocked(prisma)

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.walletTransaction.findFirst.mockResolvedValue(null)
  mockDb.walletTransaction.findMany.mockResolvedValue([])
  mockDb.walletTransaction.create.mockResolvedValue({})
  mockDb.business.updateMany.mockResolvedValue({ count: 1 })
})

describe('reserveCore atomicity + error contract (Phase 3.8)', () => {
  it('A: balance 100 reserve 10 → success, ledger RESERVE -10 (atomic debit, no pre-read)', async () => {
    mockDb.business.updateMany.mockResolvedValue({ count: 1 })
    const result = await reserveWalletFunds('order-A', 'biz-1', 10)

    expect(result.success).toBe(true)
    expect(mockDb.business.updateMany).toHaveBeenCalledWith({ where: { id: 'biz-1', walletBalance: { gte: 10 } }, data: { walletBalance: { decrement: 10 } } })
    // Success path: NO business.findUnique pre-read.
    expect(mockDb.business.findUnique).not.toHaveBeenCalled()
    expect(mockDb.walletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'WALLET_RESERVE', amount: -10 }) }))
  })

  it('B: balance 10 reserve 10 → success (exact-fit), balance 0', async () => {
    mockDb.business.updateMany.mockResolvedValue({ count: 1 })
    const result = await reserveWalletFunds('order-B', 'biz-1', 10)
    expect(result.success).toBe(true)
    expect(mockDb.business.updateMany).toHaveBeenCalled()
    expect(mockDb.business.findUnique).not.toHaveBeenCalled()
  })

  it('C: balance 9.99 reserve 10 → atomic update rejects, no reserve ledger, message preserved via failure-only lookup', async () => {
    mockDb.business.updateMany.mockResolvedValue({ count: 0 })
    mockDb.business.findUnique.mockResolvedValue({ id: 'biz-1', walletBalance: 9.99 })
    const result = await reserveWalletFunds('order-C', 'biz-1', 10)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Insufficient wallet balance. Required: 10, Available: 9.99')
    // Ledger never mutated on rejection.
    expect(mockDb.walletTransaction.create).not.toHaveBeenCalled()
    // Failure path DOES run the conditional lookup (message-only).
    expect(mockDb.business.findUnique).toHaveBeenCalledTimes(1)
  })

  it('D1: 100 concurrent reserves, only N can fit → exactly N succeed, never negative', async () => {
    // Stateful emulation of the atomic conditional debit exactly like Postgres.
    let balance = 100
    let succeeded = 0
    mockDb.business.updateMany.mockImplementation(async ({ where, data }) => {
      if (balance >= (where.walletBalance as any).gte) {
        balance -= (data.walletBalance as any).decrement
        return { count: 1 }
      }
      return { count: 0 }
    })
    mockDb.business.findUnique.mockImplementation(async () => ({ id: 'biz-1', walletBalance: balance }))
    mockDb.walletTransaction.create.mockImplementation(async () => { succeeded += 1; return {} })

    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => reserveWalletFunds(`order-D${i}`, 'biz-1', 10)))
    const ok = results.filter((r) => r.success).length

    expect(ok).toBe(10) // 10 × 10 fits in 100
    expect(succeeded).toBe(10)
    expect(balance).toBe(0) // no negative wallet
  })

  it('D2: 100 concurrent reserves, non-divisible → only full reserves succeed, remainder untouched', async () => {
    let balance = 100
    let succeeded = 0
    mockDb.business.updateMany.mockImplementation(async ({ where, data }) => {
      if (balance >= (where.walletBalance as any).gte) {
        balance -= (data.walletBalance as any).decrement
        return { count: 1 }
      }
      return { count: 0 }
    })
    mockDb.business.findUnique.mockImplementation(async () => ({ id: 'biz-1', walletBalance: balance }))
    mockDb.walletTransaction.create.mockImplementation(async () => { succeeded += 1; return {} })

    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => reserveWalletFunds(`order-E${i}`, 'biz-1', 30)))
    const ok = results.filter((r) => r.success).length

    expect(ok).toBe(3) // 3 × 30 = 90 fits; 4th would need 120
    expect(balance).toBe(10) // exact remainder, never negative
    expect(succeeded).toBe(3)
  })

  it('E: duplicate reserve for the same order → one ledger mutation only', async () => {
    mockDb.walletTransaction.findFirst.mockResolvedValue({ id: 'r1', amount: -10, type: 'WALLET_RESERVE' })
    const result = await reserveWalletFunds('order-F', 'biz-1', 10)
    expect(result.success).toBe(true)
    expect(mockDb.business.updateMany).not.toHaveBeenCalled()
    expect(mockDb.walletTransaction.create).not.toHaveBeenCalled()
  })

  it('F: business deleted before the atomic update → safe failure with Business not found', async () => {
    mockDb.business.updateMany.mockResolvedValue({ count: 0 })
    mockDb.business.findUnique.mockResolvedValue(null)
    const result = await reserveWalletFunds('order-G', 'biz-1', 10)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Business not found')
    expect(mockDb.walletTransaction.create).not.toHaveBeenCalled()
  })

  it('G: wallet changed after any earlier read → atomic update is authoritative', async () => {
    // Even if a route/orchestrator read saw 100, the reserve-time row holds only 5,
    // so the conditional update rejects (count 0).
    mockDb.business.updateMany.mockResolvedValue({ count: 0 })
    mockDb.business.findUnique.mockResolvedValue({ id: 'biz-1', walletBalance: 5 })
    const result = await reserveWalletFunds('order-H', 'biz-1', 10)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Insufficient wallet balance')
    expect(mockDb.walletTransaction.create).not.toHaveBeenCalled()
  })
})