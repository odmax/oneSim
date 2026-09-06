import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    providerAttempt: { count: vi.fn().mockResolvedValue(0), aggregate: vi.fn().mockResolvedValue({ _max: { attemptNumber: null } }) },
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
import { executeProviderAttempt, tryFailoverAfterAttempt } from './provider-attempt-service'
import { releaseReservedFunds } from './wallet-actions'
import { failOrder, transitionOrder } from './order-state-machine'
import { PurchaseOrchestrator, type PurchaseDispatchContext } from './purchase-orchestrator'

const mockPrisma = vi.mocked(prisma) as any
const mockExecute = vi.mocked(executeProviderAttempt)
const mockTryFailover = vi.mocked(tryFailoverAfterAttempt)
const mockRelease = vi.mocked(releaseReservedFunds)
const mockFailOrder = vi.mocked(failOrder)
const mockTransition = vi.mocked(transitionOrder)

function dispatchCtx(overrides: Partial<PurchaseDispatchContext> = {}): PurchaseDispatchContext {
  return {
    orderId: 'order-1',
    businessId: 'biz-1',
    userId: 'user-1',
    providerId: 'prov-choice',
    providerName: 'Choice',
    planId: 'plan-ext-1',
    quantity: 1,
    subscriber: { email: 'c@test.com', first_name: 'C' },
    totalAmount: 5,
    displayName: 'Test Plan',
    packageId: 'pkg-1',
    currency: 'USD',
    rankedProviders: [],
    providerPackageByProviderId: { 'prov-choice': 'pp-1' },
    unitPrice: 5,
    ...overrides,
  }
}

const AMBIGUOUS_CASES = [
  { name: 'Choice', providerId: 'prov-choice', providerName: 'Choice', errorMessage: 'Request timed out' },
  { name: 'iBASIS', providerId: 'prov-ibasis', providerName: 'iBASIS', errorMessage: 'iBASIS request timed out after 15000ms' },
  { name: 'USMatrix', providerId: 'prov-usmatrix', providerName: 'USMatrix', errorMessage: 'Request timed out' },
]

describe('runDispatch: per-provider ambiguous outcome → reconciliation, wallet reserved, exactly-once, no failover', () => {
  let orchestrator: PurchaseOrchestrator

  beforeEach(() => {
    vi.clearAllMocks()
    orchestrator = new PurchaseOrchestrator()
    mockPrisma.eSIMPurchase.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-1', status: 'PENDING_PROVIDER', esims: [] } as any)
    mockPrisma.providerAttempt.count.mockResolvedValue(0)
    mockExecute.mockResolvedValue({ success: false, status: 'AMBIGUOUS', errorCode: 'AMBIGUOUS_PROVIDER_OUTCOME', errorMessage: 'timeout' })
  })

  it.each(AMBIGUOUS_CASES)(
    '$name ambiguous outcome → PROVIDER_RECONCILIATION, wallet stays reserved, no failover, no blind retry, exactly one dispatch',
    async (c) => {
      const result = await orchestrator.runDispatch(dispatchCtx({ providerId: c.providerId, providerName: c.providerName }))

      expect(result.status).toBe('PROVIDER_RECONCILIATION')
      expect(result.errorCode).toBe('AMBIGUOUS_PROVIDER_OUTCOME')
      expect(result.retryable).toBe(false)
      expect(mockTransition).toHaveBeenCalledWith('order-1', 'PROVIDER_RECONCILIATION', expect.objectContaining({ reason: expect.any(String) }))
      expect(mockRelease).not.toHaveBeenCalled()
      expect(mockFailOrder).not.toHaveBeenCalled()
      expect(mockTryFailover).not.toHaveBeenCalled()
      expect(mockExecute).toHaveBeenCalledTimes(1)
    },
  )
})