import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    walletTransaction: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
    },
    business: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    orderTimelineEvent: { create: vi.fn().mockResolvedValue({}) },
    providerPackage: { findFirst: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))

import { prisma } from '@/lib/prisma'
import { ORDER_TRANSITIONS } from './order-state-machine'
import { captureReservedFundsUpTo, reserveWalletFunds } from './wallet-actions'
import { classifyOrderRecovery } from './recovery'

const mockPrisma = vi.mocked(prisma)

beforeEach(() => {
  vi.clearAllMocks()
  // Default interactive-transaction passthrough: run the callback against the
  // same mocked client (individual tests may override).
  ;(mockPrisma.$transaction as any).mockImplementation(async (fn: any) => fn(mockPrisma))
})

describe('AUDIT R1: async orders can legally reach FULFILLED from PENDING_PROVIDER', () => {
  it('allows PENDING_PROVIDER → FULFILLED (direct async finalization)', () => {
    expect(ORDER_TRANSITIONS.PENDING_PROVIDER).toContain('FULFILLED')
  })

  it('allows PENDING_PROVIDER → PARTIALLY_FULFILLED (partial batches)', () => {
    expect(ORDER_TRANSITIONS.PENDING_PROVIDER).toContain('PARTIALLY_FULFILLED')
  })

  it('keeps REFUNDED terminal', () => {
    expect(ORDER_TRANSITIONS.REFUNDED).toEqual([])
  })
})

describe('AUDIT R2: capture is blocked once funds were released/refunded (no free purchase)', () => {
  it('captureReservedFundsUpTo refuses when a WALLET_RELEASE exists and nothing captured yet', async () => {
    mockPrisma.walletTransaction.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.type === 'WALLET_RESERVE') return { id: 'r1', amount: -10 }
      if (where.type === 'WALLET_RELEASE') return { id: 'rel1', amount: 10 }
      return null
    })
    mockPrisma.walletTransaction.findMany.mockImplementation(async ({ where }: any) => {
      if (where.type === 'WALLET_CAPTURE') return []
      if (where.type === 'WALLET_RELEASE') return [{ amount: 10 }]
      return []
    })

    const result = await captureReservedFundsUpTo('order-1', 'biz-1', 10)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/released\/refunded/i)
    // No CAPTURE ledger row was written
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled()
  })

  it('captureReservedFundsUpTo stays idempotent when fully captured before release attempt', async () => {
    mockPrisma.walletTransaction.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.type === 'WALLET_RESERVE') return { id: 'r1', amount: -10 }
      return null
    })
    mockPrisma.walletTransaction.findMany.mockImplementation(async ({ where }: any) => {
      if (where.type === 'WALLET_CAPTURE') return [{ amount: 10 }]
      return []
    })

    const result = await captureReservedFundsUpTo('order-1', 'biz-1', 10)
    expect(result.success).toBe(true)
    expect(result.alreadyCaptured).toBe(true)
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled()
  })
})

describe('AUDIT R3: DB-level reserve idempotency backstop (P2002 tolerated)', () => {
  it('reserveWalletFunds returns success when a concurrent reserve wins the unique-index race', async () => {
    const txCreate = vi.fn().mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))
    const tx = {
      walletTransaction: { findFirst: vi.fn().mockResolvedValue(null), create: txCreate },
      business: { findUnique: vi.fn().mockResolvedValue({ walletBalance: 100 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    ;(mockPrisma.$transaction as any).mockImplementation(async (fn: any) => fn(tx))

    const result = await reserveWalletFunds('order-1', 'biz-1', 10)

    expect(result.success).toBe(true)
    expect(tx.business.updateMany).toHaveBeenCalled()
  })

  it('reserveWalletFunds still fails on non-P2002 errors', async () => {
    const tx = {
      walletTransaction: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockRejectedValue(new Error('db down')) },
      business: { findUnique: vi.fn().mockResolvedValue({ walletBalance: 100 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    ;(mockPrisma.$transaction as any).mockImplementation(async (fn: any) => fn(tx))

    const result = await reserveWalletFunds('order-1', 'biz-1', 10)
    expect(result.success).toBe(false)
  })
})

describe('AUDIT R5: recovery never redispatches an order whose funds were released', () => {
  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      order: {
        id: 'o1', status: 'FAILED',
        providerFulfillId: null, providerReservationId: null,
        retryCount: 0, maxRetries: 5,
        providerId: 'prov-1', businessId: 'biz-1', totalAmount: 10,
      },
      esims: [] as Array<{ id: string; iccid: string }>,
      walletReserved: true,
      walletCaptured: false,
      providerAttempts: [
        { id: 'a1', status: 'FAILED', source: 'PURCHASE', retryClassification: 'RETRYABLE', errorCode: 'HTTP_500' as string | null, providerReference: null },
      ],
      providerPollingSupported: true,
      ...overrides,
    } as Parameters<typeof classifyOrderRecovery>[0]
  }

  it('routes released-funds retryable failures to RECONCILIATION_REQUIRED instead of REDISPATCH_PROVIDER', () => {
    const c = classifyOrderRecovery(baseInput({ walletReleased: true }))
    expect(c.action).toBe('RECONCILIATION_REQUIRED')
    expect(c.reason).toMatch(/released\/refunded/i)
  })

  it('still allows REDISPATCH_PROVIDER while funds are held', () => {
    const c = classifyOrderRecovery(baseInput())
    expect(c.action).toBe('REDISPATCH_PROVIDER')
  })

  it('uncertain outcomes still route to reconciliation regardless of wallet state', () => {
    const input = baseInput({
      walletReleased: false,
      providerAttempts: [
        { id: 'a1', status: 'AMBIGUOUS', source: 'PURCHASE', retryClassification: 'NON_RETRYABLE', errorCode: 'TIMEOUT', providerReference: null },
      ],
    })
    const c = classifyOrderRecovery(input)
    expect(c.action).toBe('RECONCILIATION_REQUIRED')
  })
})
