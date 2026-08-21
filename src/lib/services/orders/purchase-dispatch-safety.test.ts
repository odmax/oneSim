import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    providerAttempt: { count: vi.fn().mockResolvedValue(0) },
    eSIM: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}))

vi.mock('./provider-attempt-service', () => ({
  executeProviderAttempt: vi.fn(),
  tryFailoverAfterAttempt: vi.fn(),
}))

vi.mock('./wallet-actions', () => ({
  reserveWalletFunds: vi.fn(),
  captureReservedFunds: vi.fn(),
  releaseReservedFunds: vi.fn(),
}))

vi.mock('./order-state-machine', () => ({
  createTimelineEvent: vi.fn(),
  transitionOrder: vi.fn(),
  failOrder: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { executeProviderAttempt } from './provider-attempt-service'
import { releaseReservedFunds } from './wallet-actions'
import { failOrder, transitionOrder } from './order-state-machine'
import { PurchaseOrchestrator, type PurchaseDispatchContext } from './purchase-orchestrator'

const mockPrisma = vi.mocked(prisma)
const mockExecuteAttempt = vi.mocked(executeProviderAttempt)
const mockRelease = vi.mocked(releaseReservedFunds)
const mockFailOrder = vi.mocked(failOrder)
const mockTransition = vi.mocked(transitionOrder)

function dispatchCtx(overrides: Partial<PurchaseDispatchContext> = {}): PurchaseDispatchContext {
  return {
    orderId: 'order-1',
    businessId: 'biz-1',
    userId: 'user-1',
    providerId: 'prov-1',
    providerName: 'Choice',
    planId: 'plan-ext-1',
    quantity: 1,
    subscriber: { email: 'c@test.com', first_name: 'C' },
    totalAmount: 5,
    displayName: 'Test Plan',
    packageId: 'pkg-1',
    currency: 'USD',
    rankedProviders: [],
    providerPackageByProviderId: { 'prov-1': 'pp-1' },
    unitPrice: 5,
    ...overrides,
  }
}

describe('runDispatch transaction safety (exactly-once provider dispatch)', () => {
  let orchestrator: PurchaseOrchestrator

  beforeEach(() => {
    vi.clearAllMocks()
    orchestrator = new PurchaseOrchestrator()
    mockPrisma.eSIMPurchase.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-1', status: 'PENDING_PROVIDER', esims: [] } as any)
    mockExecuteAttempt.mockResolvedValue({ success: true, status: 'SUCCEEDED' })
  })

  it('claims the order atomically and dispatches exactly once when the claim wins', async () => {
    const result = await orchestrator.runDispatch(dispatchCtx())

    expect(mockPrisma.eSIMPurchase.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'PAYMENT_RESERVED' },
      data: { status: 'PENDING_PROVIDER' },
    })
    expect(mockExecuteAttempt).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.status).toBe('FULFILLED')
  })

  it('duplicate executor is blocked by the claim and never re-dispatches (in-flight order)', async () => {
    // Another worker already claimed the order and recorded an attempt.
    mockPrisma.eSIMPurchase.updateMany.mockResolvedValue({ count: 0 })
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-1', status: 'PENDING_PROVIDER', esims: [] } as any)
    mockPrisma.providerAttempt.count.mockResolvedValue(1)

    const result = await orchestrator.runDispatch(dispatchCtx())

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('ALREADY_DISPATCHING')
    expect(result.retryable).toBe(false)
    expect(mockExecuteAttempt).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
    expect(mockFailOrder).not.toHaveBeenCalled()
  })

  it('crash between claim and first attempt resumes dispatch exactly once', async () => {
    // Previous worker claimed (PAYMENT_RESERVED → PENDING_PROVIDER) then crashed
    // before recording any attempt — provably no provider HTTP was sent.
    mockPrisma.eSIMPurchase.updateMany.mockResolvedValue({ count: 0 })
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-1', status: 'PENDING_PROVIDER', esims: [] } as any)
    mockPrisma.providerAttempt.count.mockResolvedValue(0)

    const result = await orchestrator.runDispatch(dispatchCtx())

    expect(mockExecuteAttempt).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
  })

  it('already-fulfilled order short-circuits successfully without any provider call', async () => {
    mockPrisma.eSIMPurchase.updateMany.mockResolvedValue({ count: 0 })
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-1', status: 'FULFILLED', esims: [{ id: 'esim-1' }] } as any)

    const result = await orchestrator.runDispatch(dispatchCtx())

    expect(result.success).toBe(true)
    expect(result.status).toBe('FULFILLED')
    expect(mockExecuteAttempt).not.toHaveBeenCalled()
  })

  it('ambiguous provider outcome moves to PROVIDER_RECONCILIATION without releasing funds or failing the order', async () => {
    mockExecuteAttempt.mockResolvedValue({ success: false, status: 'AMBIGUOUS', errorCode: 'AMBIGUOUS_PROVIDER_OUTCOME', errorMessage: 'timeout' })

    const result = await orchestrator.runDispatch(dispatchCtx())

    expect(result.status).toBe('PROVIDER_RECONCILIATION')
    expect(result.errorCode).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
    expect(mockTransition).toHaveBeenCalledWith('order-1', 'PROVIDER_RECONCILIATION', expect.anything())
    expect(mockRelease).not.toHaveBeenCalled()
    expect(mockFailOrder).not.toHaveBeenCalled()
    // Exactly one attempt — no blind retry of an ambiguous mutation.
    expect(mockExecuteAttempt).toHaveBeenCalledTimes(1)
  })

  it('definitive provider failure releases reserved funds and fails the order once', async () => {
    mockExecuteAttempt.mockResolvedValue({ success: false, status: 'FAILED', errorCode: 'PLAN_NOT_FOUND', errorMessage: 'plan not found' })

    const result = await orchestrator.runDispatch(dispatchCtx())

    expect(result.success).toBe(false)
    expect(mockRelease).toHaveBeenCalledWith('order-1', 'biz-1', 5)
    expect(mockFailOrder).toHaveBeenCalled()
    expect(mockExecuteAttempt).toHaveBeenCalledTimes(1)
  })
})
