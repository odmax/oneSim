import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  auditCreate: vi.fn(),
  executeProviderAttempt: vi.fn(),
  tryFailoverAfterAttempt: vi.fn(),
  transitionOrder: vi.fn(),
  failOrder: vi.fn(),
  createTimelineEvent: vi.fn(),
  reserveWalletFunds: vi.fn(),
  captureReservedFunds: vi.fn(),
  releaseReservedFunds: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPurchase: { updateMany: mocks.updateMany, findUnique: mocks.findUnique },
    eSIM: { findMany: mocks.findMany },
    auditLog: { create: mocks.auditCreate },
  },
}))

vi.mock('@/lib/services/orders/provider-attempt-service', () => ({
  executeProviderAttempt: mocks.executeProviderAttempt,
  tryFailoverAfterAttempt: mocks.tryFailoverAfterAttempt,
}))

vi.mock('@/lib/services/orders/order-state-machine', () => ({
  transitionOrder: mocks.transitionOrder,
  failOrder: mocks.failOrder,
  createTimelineEvent: mocks.createTimelineEvent,
}))

vi.mock('@/lib/services/orders/wallet-actions', () => ({
  reserveWalletFunds: mocks.reserveWalletFunds,
  captureReservedFunds: mocks.captureReservedFunds,
  releaseReservedFunds: mocks.releaseReservedFunds,
}))

vi.mock('@/lib/services/jobs/queue', () => ({ enqueueJob: vi.fn() }))
vi.mock('@/lib/providers/adapter-manager', () => ({ isProviderOperational: vi.fn(() => true) }))
vi.mock('@/lib/services/providers/provider-balance', () => ({ getProviderBalance: vi.fn(async () => ({ success: false })) }))
vi.mock('@/lib/pricing/purchase-price-guard', () => ({ enforcePurchasePriceGuard: vi.fn(async () => ({ passed: true })) }))

import { PurchaseOrchestrator, type PurchaseDispatchContext } from './purchase-orchestrator'

function ctx(): PurchaseDispatchContext {
  return {
    orderId: 'order-1', businessId: 'biz-1', userId: 'user-1', providerId: 'prov-airhub', providerName: 'AirHub',
    planId: 'plan-1', quantity: 1, subscriber: { email: 'c@example.com' }, totalAmount: 10,
    displayName: '5GB', packageId: 'pkg-1', currency: 'USD', rankedProviders: [],
    providerPackageByProviderId: { 'prov-airhub': 'pp-1' }, unitPrice: 10, correlationId: 'trace-1',
  }
}

const orchestrator = new PurchaseOrchestrator()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateMany.mockResolvedValue({ count: 1 })
  mocks.findMany.mockResolvedValue([{ id: 'esim-1', iccid: '1', imsi: null, activationCode: null, status: 'PENDING_ACTIVATION', qrCodeUrl: null }])
})

describe('purchase dispatch performance — immediate finalize vs safe async', () => {
  it('14: immediate delivery data finalizes with FULFILLED and no extra provider call', async () => {
    mocks.executeProviderAttempt.mockResolvedValue({ success: true, status: 'SUCCEEDED', providerReference: 'REF', iccids: ['1'], qrCode: 'QR' })
    const r = await orchestrator.runDispatch(ctx())
    expect(r.success).toBe(true)
    expect(r.status).toBe('FULFILLED')
    expect(mocks.executeProviderAttempt).toHaveBeenCalledTimes(1)
    expect(mocks.tryFailoverAfterAttempt).not.toHaveBeenCalled()
    expect(mocks.releaseReservedFunds).not.toHaveBeenCalled()
  })

  it('15: incomplete/awaiting delivery keeps the safe async path (PROCESSING, no failover)', async () => {
    mocks.executeProviderAttempt.mockResolvedValue({ success: true, status: 'PROCESSING', providerReference: 'REF' })
    const r = await orchestrator.runDispatch(ctx())
    expect(r.status).toBe('PROCESSING')
    expect(r.success).toBe(true)
    expect(mocks.tryFailoverAfterAttempt).not.toHaveBeenCalled()
    expect(mocks.releaseReservedFunds).not.toHaveBeenCalled()
  })

  it('17: an already-completed order is a replay — zero new provider dispatch', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 })
    mocks.findUnique.mockResolvedValue({ status: 'FULFILLED', esims: [{ id: 'esim-1' }] })
    const r = await orchestrator.runDispatch(ctx())
    expect(r.success).toBe(true)
    expect(r.status).toBe('FULFILLED')
    expect(mocks.executeProviderAttempt).not.toHaveBeenCalled()
  })

  it('16: wallet release + fail happens exactly once on exhausted attempts (no unsafe retry)', async () => {
    mocks.executeProviderAttempt.mockResolvedValue({ success: false, status: 'RETRYABLE', errorCode: 'PROVIDER_ERROR', errorMessage: 'down' })
    mocks.tryFailoverAfterAttempt.mockResolvedValue({ shouldContinue: false })
    const r = await orchestrator.runDispatch(ctx())
    expect(r.success).toBe(false)
    expect(mocks.releaseReservedFunds).toHaveBeenCalledTimes(1)
    expect(mocks.failOrder).toHaveBeenCalledTimes(1)
    expect(mocks.executeProviderAttempt).toHaveBeenCalledTimes(1)
  })
})