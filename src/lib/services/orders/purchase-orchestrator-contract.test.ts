import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

vi.mock('@/lib/prisma', () => {
  const m = {
    business: { findUnique: vi.fn() },
    customer: { findFirst: vi.fn(), create: vi.fn() },
    eSIMPurchase: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    eSIM: { create: vi.fn(), findMany: vi.fn() },
    provider: { findUnique: vi.fn() },
    providerPackage: { findUnique: vi.fn() },
    providerAttempt: { count: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn(), aggregate: vi.fn().mockResolvedValue({ _max: { attemptNumber: null } }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    orderTimelineEvent: { create: vi.fn() },
    walletTransaction: { create: vi.fn() },
  }
  return { prisma: m }
})

vi.mock('@/lib/packages/resolve-package', () => ({
  resolvePackageIdentifier: vi.fn(),
}))

vi.mock('./package-backing-resolver', () => ({
  resolvePackageBacking: vi.fn(),
}))

vi.mock('@/lib/packages/purchase-readiness', () => ({
  getPackagePurchaseReadiness: vi.fn(() => ({ ready: true, reasons: [] })),
}))

vi.mock('@/lib/pricing/purchase-price-guard', () => ({
  enforcePurchasePriceGuard: vi.fn().mockResolvedValue({ passed: true }),
}))

vi.mock('@/lib/services/providers/provider-balance', () => ({
  getProviderBalance: vi.fn(),
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  isProviderOperational: vi.fn((status: string) => ['ACTIVE', 'DEGRADED', 'TESTING'].includes(status)),
  getAdapterForType: vi.fn(),
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

vi.mock('@/lib/services/jobs/queue', () => ({
  enqueueJob: vi.fn(),
}))

vi.mock('./provider-attempt-service', () => ({
  executeProviderAttempt: vi.fn(),
  tryFailoverAfterAttempt: vi.fn(),
}))

vi.mock('@/lib/pricing/purchase-quote-service', () => ({
  consumeQuoteAndCreateOrder: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { resolvePackageIdentifier } from '@/lib/packages/resolve-package'
import { resolvePackageBacking } from './package-backing-resolver'
import { reserveWalletFunds, releaseReservedFunds } from './wallet-actions'
import { failOrder, transitionOrder } from './order-state-machine'
import { enqueueJob } from '@/lib/services/jobs/queue'
import { executeProviderAttempt } from './provider-attempt-service'
import { consumeQuoteAndCreateOrder } from '@/lib/pricing/purchase-quote-service'
import { PurchaseOrchestrator } from './purchase-orchestrator'

const mockPrisma = vi.mocked(prisma)
const mockResolve = vi.mocked(resolvePackageIdentifier)
const mockBacking = vi.mocked(resolvePackageBacking)
const mockReserve = vi.mocked(reserveWalletFunds)
const mockRelease = vi.mocked(releaseReservedFunds)
const mockFailOrder = vi.mocked(failOrder)
const mockTransition = vi.mocked(transitionOrder)
const mockEnqueue = vi.mocked(enqueueJob)
const mockAttempt = vi.mocked(executeProviderAttempt)
const mockConsumeQuote = vi.mocked(consumeQuoteAndCreateOrder)

const PROVIDERS = [
  { code: 'AIRHUB', planId: 'airhub-plan' },
  { code: 'CHOICE', planId: 'choice-sku' },
  { code: 'IBASIS', planId: 'ibasis-plan' },
  { code: 'TELNA', planId: 'telna-plan' },
  { code: 'USMATRIX', planId: 'usm-plan' },
] as const

function setupBase(providerCode: string, planId: string) {
  mockResolve.mockResolvedValue({
    package: { id: 'pkg-1', displayName: 'Test', name: 'Test', dataGB: 1, validityDays: 7, priceUSD: { toString: () => '5' }, localPrice: { toString: () => '5' }, currency: 'USD', source: 'CATALOG_PRODUCT', providerId: null, providerPlanId: null, providerName: null, providerPackageId: 'pp-1', sku: 'SKU1', packageCode: null, customerDescription: null } as any,
  } as any)
  mockBacking.mockResolvedValue({ kind: 'BOUND', backing: { providerPackageId: 'pp-1', providerId: 'prov-1', providerPlanId: planId } })
  mockPrisma.business.findUnique.mockResolvedValue({ id: 'biz-1', status: 'APPROVED', walletBalance: { toString: () => '100' } } as any)
  mockPrisma.providerPackage.findUnique.mockResolvedValue({ activationPolicy: 'IMMEDIATE', travelDateRequirement: 'NOT_REQUIRED', travelDateLeadDays: 0, travelDateSource: null, provider: { code: providerCode, config: {}, adapterStrategy: providerCode } } as any)
  mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-1', code: providerCode, name: providerCode, status: 'ACTIVE', type: 'CUSTOM', apiBaseUrl: 'https://x', apiToken: 't', environment: 'staging', authUrl: 'https://x/a', enabledCapabilities: ['PURCHASE'], config: {} } as any)
  mockPrisma.customer.findFirst.mockResolvedValue(null)
  mockPrisma.customer.create.mockResolvedValue({ id: 'cust-1' } as any)
  mockPrisma.eSIMPurchase.findFirst.mockResolvedValue(null)
  mockPrisma.eSIMPurchase.create.mockResolvedValue({ id: 'order-1' } as any)
  mockPrisma.eSIMPurchase.findUnique.mockResolvedValue(null)
  mockPrisma.eSIM.findMany.mockResolvedValue([])
}

function setupProviderAttemptScenarios() {
  mockAttempt.mockReset()
  mockAttempt.mockResolvedValue({ success: false, status: 'FAILED', errorCode: 'PROVIDER_FAILED', errorMessage: 'rejected' })
}

describe('PurchaseOrchestrator — provider-neutral multi-provider contract', () => {
  let orchestrator: PurchaseOrchestrator

  beforeEach(() => {
    vi.clearAllMocks()
    orchestrator = new PurchaseOrchestrator()
    mockReserve.mockResolvedValue({ success: true })
    mockRelease.mockResolvedValue({ success: true })
    mockTransition.mockResolvedValue({ success: true })
    mockEnqueue.mockResolvedValue({ id: 'job-1' } as any)
    mockConsumeQuote.mockResolvedValue({
      success: true,
      orderId: 'order-quote',
      order: { id: 'order-quote', quotedUnitPrice: 5, quotedTotalAmount: 5, totalAmount: 5, packageUnitPrice: 5 },
      alreadyConsumed: false,
    } as any)
  })

  for (const { code, planId } of PROVIDERS) {
    it(`BOUND package for ${code} dispatches only to its backing provider with its own planId`, async () => {
      setupBase(code, planId)
      // Keep the attempt pending so we can inspect the wiring without finalizing.
      mockAttempt.mockResolvedValueOnce({ success: true, status: 'PROCESSING', providerReference: 'ref-1' })

      const result = await orchestrator.executePurchase({ businessId: 'biz-1', userId: 'user-1', packageId: 'pkg-1', quantity: 1 })

      expect(result.success).toBe(true)
      expect(result.status).toBe('PROCESSING')
      expect(mockAttempt).toHaveBeenCalledTimes(1)
      expect(mockAttempt).toHaveBeenCalledWith(expect.objectContaining({
        orderId: 'order-1',
        businessId: 'biz-1',
        providerId: 'prov-1',
        planId,
        providerPackageId: 'pp-1',
      }))
      // Reserve happened before dispatch (invocation order).
      expect(mockReserve.mock.invocationCallOrder[0]).toBeLessThan(mockAttempt.mock.invocationCallOrder[0])
    })
  }

  for (const { code } of PROVIDERS) {
    it(`ambiguous outcome for ${code} → PROVIDER_RECONCILIATION and wallet stays reserved`, async () => {
      setupBase(code, 'plan-1')
      mockAttempt.mockResolvedValueOnce({ success: false, status: 'AMBIGUOUS', errorCode: 'AMBIGUOUS_PROVIDER_OUTCOME', errorMessage: 'may have completed' })

      const result = await orchestrator.executePurchase({ businessId: 'biz-1', userId: 'user-1', packageId: 'pkg-1', quantity: 1 })

      expect(result.success).toBe(false)
      expect(result.status).toBe('PROVIDER_RECONCILIATION')
      expect(mockTransition).toHaveBeenCalledWith('order-1', 'PROVIDER_RECONCILIATION', expect.anything())
      expect(mockRelease).not.toHaveBeenCalled()
      expect(mockFailOrder).not.toHaveBeenCalled()
    })
  }

  for (const { code } of PROVIDERS) {
    it(`definitive rejection for ${code} → wallet released and order failed`, async () => {
      setupBase(code, 'plan-1')
      mockAttempt.mockResolvedValueOnce({ success: false, status: 'FAILED', errorCode: 'PROVIDER_FAILED', errorMessage: 'rejected' })

      const result = await orchestrator.executePurchase({ businessId: 'biz-1', userId: 'user-1', packageId: 'pkg-1', quantity: 1 })

      expect(result.success).toBe(false)
      expect(mockRelease).toHaveBeenCalledWith('order-1', 'biz-1', 5)
      expect(mockFailOrder).toHaveBeenCalled()
    })
  }

  for (const { code } of PROVIDERS) {
    it(`synchronous success for ${code} creates eSIMs and returns FULFILLED`, async () => {
      setupBase(code, 'plan-1')
      mockAttempt.mockResolvedValueOnce({ success: true, status: 'SUCCEEDED', providerReference: 'ref-1', iccids: ['89012345678901234567'] })
      mockPrisma.eSIM.findMany.mockResolvedValue([{ id: 'esim-1', iccid: '89012345678901234567', imsi: null, activationCode: null, status: 'PENDING_ACTIVATION', qrCodeUrl: null }] as any)

      const result = await orchestrator.executePurchase({ businessId: 'biz-1', userId: 'user-1', packageId: 'pkg-1', quantity: 1 })

      expect(result.success).toBe(true)
      expect(result.status).toBe('FULFILLED')
      expect(mockRelease).not.toHaveBeenCalled()
    })
  }

  it('same business + same idempotency key resolves to the existing order (no second dispatch)', async () => {
    setupBase('CHOICE', 'plan-1')
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-existing', status: 'FULFILLED', businessId: 'biz-1', userId: 'user-1', packageId: 'pkg-1', totalAmount: { toString: () => '5' }, esims: [{ id: 'esim-1', iccid: '8901', imsi: null, activationCode: null, status: 'ACTIVE', qrCodeUrl: null }] } as any)

    const result = await orchestrator.executePurchase({ businessId: 'biz-1', userId: 'user-1', packageId: 'pkg-1', quantity: 1, idempotencyKey: 'key-1' })

    expect(result.success).toBe(true)
    expect(result.orderId).toBe('order-existing')
    expect(mockAttempt).not.toHaveBeenCalled()
    expect(mockReserve).not.toHaveBeenCalled()
  })

  it('quote path: valid quote is consumed transactionally with business+quantity+package', async () => {
    setupBase('CHOICE', 'plan-1')
    mockAttempt.mockResolvedValueOnce({ success: true, status: 'SUCCEEDED', providerReference: 'ref-1', iccids: ['89012345678901234567'] })
    mockPrisma.eSIM.findMany.mockResolvedValue([{ id: 'esim-1', iccid: '89012345678901234567', imsi: null, activationCode: null, status: 'PENDING_ACTIVATION', qrCodeUrl: null }] as any)

    const result = await orchestrator.executePurchase({ businessId: 'biz-1', userId: 'user-1', packageId: 'pkg-1', quantity: 1, quoteReference: 'QT-1', idempotencyKey: 'key-1' })

    expect(result.success).toBe(true)
    expect(mockConsumeQuote).toHaveBeenCalledWith(expect.objectContaining({
      quoteReference: 'QT-1',
      businessId: 'biz-1',
      userId: 'user-1',
      packageId: 'pkg-1',
      quantity: 1,
      idempotencyKey: 'key-1',
    }))
    expect(mockReserve).toHaveBeenCalledWith('order-quote', 'biz-1', 5)
    expect(mockAttempt).toHaveBeenCalledTimes(1)
  })

  it('quote path: expired/consumed/invalid quote fails closed (no reserve, no dispatch)', async () => {
    setupBase('CHOICE', 'plan-1')
    mockConsumeQuote.mockResolvedValueOnce({ success: false, errorCode: 'QUOTE_EXPIRED', error: 'Quote has expired' } as any)

    const result = await orchestrator.executePurchase({ businessId: 'biz-1', userId: 'user-1', packageId: 'pkg-1', quantity: 1, quoteReference: 'QT-expired' })

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('QUOTE_EXPIRED')
    expect(mockReserve).not.toHaveBeenCalled()
    expect(mockAttempt).not.toHaveBeenCalled()
  })

  it('async path enqueues PROVIDER_OPERATION instead of dispatching inline', async () => {
    setupBase('CHOICE', 'plan-1')

    const result = await orchestrator.executePurchaseAsync({ businessId: 'biz-1', userId: 'user-1', packageId: 'pkg-1', quantity: 1, quoteReference: 'QT-1' })

    expect(result.success).toBe(true)
    expect(result.status).toBe('PROCESSING')
    expect(mockEnqueue).toHaveBeenCalledWith('PROVIDER_OPERATION', expect.objectContaining({ orderId: 'order-quote', operation: 'purchase' }), expect.any(Date), 5)
    expect(mockAttempt).not.toHaveBeenCalled()
  })
})

describe('PurchaseOrchestrator — no provider-specific purchase branches', () => {
  it('source contains no provider-code literals/comparisons in the purchase lifecycle (provider-neutral)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'purchase-orchestrator.ts'), 'utf8')
    expect(src).not.toMatch(/===\s*['"]AIRHUB['"]/)
    expect(src).not.toMatch(/===\s*['"]CHOICE['"]/)
    expect(src).not.toMatch(/===\s*['"]IBASIS['"]/)
    expect(src).not.toMatch(/===\s*['"]TELNA['"]/)
    expect(src).not.toMatch(/===\s*['"]USMATRIX['"]/)
    expect(src).not.toMatch(/===\s*['"]MOCK['"]/)
  })
})