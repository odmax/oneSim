import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    business: { findUnique: vi.fn() },
    customer: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    eSIMPurchase: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    eSIM: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn() },
    provider: { findUnique: vi.fn(), findMany: vi.fn() },
    providerAttempt: { create: vi.fn(), count: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    eSIMPackage: { findUnique: vi.fn() },
    providerPackage: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    orderTimelineEvent: { create: vi.fn() },
    walletTransaction: { create: vi.fn() },
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  isProviderOperational: vi.fn((status: string) => ['ACTIVE', 'DEGRADED', 'TESTING'].includes(status)),
  getAdapterForType: vi.fn(),
}))

vi.mock('@/lib/services/providers/provider-balance', () => ({ getProviderBalance: vi.fn() }))
vi.mock('@/lib/packages/resolve-package', () => ({ resolvePackageIdentifier: vi.fn() }))
vi.mock('./wallet-actions', () => ({
  reserveWalletFunds: vi.fn(), captureReservedFunds: vi.fn(), releaseReservedFunds: vi.fn(),
}))
vi.mock('./order-state-machine', () => ({
  createTimelineEvent: vi.fn(), transitionOrder: vi.fn(), failOrder: vi.fn(),
}))
vi.mock('./fulfillment', () => ({
  completeProviderFinalization: vi.fn(), persistProviderFulfillment: vi.fn(), resumeProviderFinalization: vi.fn(),
}))
vi.mock('@/lib/services/custom-package/custom-package', () => ({
  resolveCustomPackageBackings: vi.fn(),
}))

// Mock the provider-attempt service so the custom-backing branch is tested in
// isolation (no adapter/provider-attempt DB chain).
const { mockExecuteProviderAttempt, mockTryFailoverAfterAttempt } = vi.hoisted(() => ({
  mockExecuteProviderAttempt: vi.fn(),
  mockTryFailoverAfterAttempt: vi.fn(),
}))
vi.mock('./provider-attempt-service', () => ({
  executeProviderAttempt: mockExecuteProviderAttempt,
  tryFailoverAfterAttempt: mockTryFailoverAfterAttempt,
}))

import { prisma } from '@/lib/prisma'
import { resolvePackageIdentifier } from '@/lib/packages/resolve-package'
import { reserveWalletFunds } from './wallet-actions'
import { failOrder } from './order-state-machine'
import { resolveCustomPackageBackings } from '@/lib/services/custom-package/custom-package'
import { PurchaseOrchestrator } from './purchase-orchestrator'

const mockPrisma = vi.mocked(prisma)
const mockResolve = vi.mocked(resolvePackageIdentifier)
const mockReserve = vi.mocked(reserveWalletFunds)
const mockFailOrder = vi.mocked(failOrder)
const mockBackings = vi.mocked(resolveCustomPackageBackings)

const validRequest = {
  businessId: 'biz-1', userId: 'user-1', packageId: 'pkg-custom-1', quantity: 1,
  customer: { name: 'Test', email: 't@t.com' },
}

function setupCustomPackage() {
  mockResolve.mockResolvedValue({
    package: {
      id: 'pkg-custom-1', displayName: 'Custom 10GB', name: 'Custom 10GB', dataGB: 10, validityDays: 30,
      priceUSD: { toString: () => '29.99' }, localPrice: { toString: () => '29.99' }, currency: 'USD',
      source: 'CATALOG_PRODUCT', providerId: null, providerPlanId: null, providerName: null,
      providerPackageId: null, sku: 'CUSTOM1', packageCode: null, customerDescription: null,
      isActive: true, hiddenFromCatalog: false, archivedAt: null,
    } as any,
    source: 'PACKAGE' as any,
  } as any)
  mockPrisma.business.findUnique.mockResolvedValue({ id: 'biz-1', status: 'APPROVED', walletBalance: { toString: () => '100' } } as any)
  mockPrisma.customer.findFirst.mockResolvedValue(null)
  mockPrisma.customer.create.mockResolvedValue({ id: 'cust-1' } as any)
  mockPrisma.eSIMPurchase.findFirst.mockResolvedValue(null)
  mockPrisma.eSIMPurchase.create.mockResolvedValue({ id: 'order-1' } as any)
  mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-1', businessId: 'biz-1', userId: 'user-1', status: 'CREATED', totalAmount: { toString: () => '29.99' }, esims: [], providerId: 'prov-a', packageId: 'pkg-custom-1', packageSnapshot: {}, packageName: 'Custom 10GB', packageDataGB: 10, packageValidityDays: 30 } as any)
  mockPrisma.eSIM.findMany.mockResolvedValue([])
  mockReserve.mockResolvedValue({ success: true, reservationId: 'res-1' })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PurchaseOrchestrator — custom package backings (provider-neutral)', () => {
  it('routes a custom package through the TOP backing provider with its providerPackageId', async () => {
    setupCustomPackage()
    mockBackings.mockResolvedValue([
      { providerPackageId: 'pp-a', providerId: 'prov-a', providerName: 'Provider A', priority: 1 },
      { providerPackageId: 'pp-b', providerId: 'prov-b', providerName: 'Provider B', priority: 2 },
    ])
    mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-a', code: 'P', name: 'Provider A', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } as any)
    mockExecuteProviderAttempt.mockResolvedValue({ success: true, status: 'SUCCEEDED', providerReference: 'ref-a' })

    const o = new PurchaseOrchestrator()
    const result = await o.executePurchase(validRequest)

    // Top backing provider drives the attempt, with its own ProviderPackage id
    // (ownership guard passes) — no provider-side custom creation.
    expect(mockExecuteProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'prov-a',
      providerPackageId: 'pp-a',
    }))
    expect(result.success).toBe(true)
  })

  it('failover: first backing RETRYABLE → second backing provider attempted', async () => {
    setupCustomPackage()
    mockBackings.mockResolvedValue([
      { providerPackageId: 'pp-a', providerId: 'prov-a', providerName: 'Provider A', priority: 1 },
      { providerPackageId: 'pp-b', providerId: 'prov-b', providerName: 'Provider B', priority: 2 },
    ])
    mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-a', code: 'P', name: 'Provider A', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } as any)
    mockExecuteProviderAttempt
      .mockResolvedValueOnce({ success: false, status: 'RETRYABLE', errorCode: 'TIMEOUT' })
      .mockResolvedValueOnce({ success: true, status: 'SUCCEEDED', providerReference: 'ref-b' })
    mockTryFailoverAfterAttempt.mockResolvedValue({ shouldContinue: true, providerId: 'prov-b', providerName: 'Provider B' })

    const o = new PurchaseOrchestrator()
    const result = await o.executePurchase(validRequest)

    const attempts = mockExecuteProviderAttempt.mock.calls.map(c => c[0])
    expect(attempts[0].providerPackageId).toBe('pp-a')
    expect(attempts[1].providerPackageId).toBe('pp-b')
    expect(attempts[1].providerId).toBe('prov-b')
    expect(result.success).toBe(true)
  })

  it('no purchase-ready backings → BACKING_NOT_CONFIGURED before any provider attempt', async () => {
    setupCustomPackage()
    mockBackings.mockResolvedValue([])
    mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-a', code: 'P', name: 'Provider A', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } as any)

    const o = new PurchaseOrchestrator()
    const result = await o.executePurchase(validRequest)

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('BACKING_NOT_CONFIGURED')
    // No provider was called (and no provider-side creation).
    expect(mockExecuteProviderAttempt).not.toHaveBeenCalled()
  })

  it('does not special-case a single-bound (non-custom) package', async () => {
    // Legacy single-ProviderPackage retail package: backings are NOT resolved.
    mockResolve.mockResolvedValue({
      package: {
        id: 'pkg-legacy', displayName: 'Legacy', name: 'Legacy', dataGB: 1, validityDays: 7,
        priceUSD: { toString: () => '5' }, localPrice: { toString: () => '5' }, currency: 'USD',
        source: 'CATALOG_PRODUCT', providerId: 'prov-a', providerPlanId: 'pl-1', providerName: 'P',
        providerPackageId: 'pp-1', sku: 'L1', packageCode: null, customerDescription: null,
        isActive: true, hiddenFromCatalog: false, archivedAt: null,
      } as any,
      source: 'PACKAGE' as any,
    } as any)
    mockPrisma.business.findUnique.mockResolvedValue({ id: 'biz-1', status: 'APPROVED', walletBalance: { toString: () => '100' } } as any)
    mockPrisma.customer.findFirst.mockResolvedValue(null)
    mockPrisma.customer.create.mockResolvedValue({ id: 'cust-1' } as any)
    mockPrisma.eSIMPurchase.findFirst.mockResolvedValue(null)
    mockPrisma.eSIMPurchase.create.mockResolvedValue({ id: 'order-1' } as any)
    mockPrisma.eSIMPurchase.findUnique.mockResolvedValue({ id: 'order-1', businessId: 'biz-1', userId: 'user-1', status: 'CREATED', totalAmount: { toString: () => '5' }, esims: [], providerId: 'prov-a', packageId: 'pkg-legacy', packageSnapshot: {}, packageName: 'Legacy', packageDataGB: 1, packageValidityDays: 7 } as any)
    mockPrisma.eSIM.findMany.mockResolvedValue([])
    mockReserve.mockResolvedValue({ success: true, reservationId: 'res-1' })
    mockPrisma.providerPackage.findUnique.mockResolvedValue({ id: 'pp-1', providerId: 'prov-a', providerPlanId: 'pl-1', publishStatus: 'PUBLISHED', configurationStatus: 'CONFIGURED', costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-1', sellingPrice: '5', costPrice: '2' } as any)
    mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-a', code: 'P', name: 'Provider A', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } as any)
    mockPrisma.provider.findMany.mockResolvedValue([{ id: 'prov-a', code: 'P', name: 'Provider A', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], errorCount: 0, priority: 0, lastSuccessfulConnection: new Date(), activationSuccessRate: 0.95 }] as any)
    mockExecuteProviderAttempt.mockResolvedValue({ success: true, status: 'SUCCEEDED', providerReference: 'ref' })

    const o = new PurchaseOrchestrator()
    const result = await o.executePurchase({ ...validRequest, packageId: 'pkg-legacy' })

    expect(mockBackings).not.toHaveBeenCalled()
    expect(mockExecuteProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({ providerPackageId: 'pp-1' }))
    expect(result.success).toBe(true)
  })
})
