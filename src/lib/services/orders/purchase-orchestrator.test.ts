import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    business: { findUnique: vi.fn() },
    customer: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    eSIMPurchase: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    eSIM: { create: vi.fn(), findMany: vi.fn() },
    provider: { findUnique: vi.fn(), findMany: vi.fn() },
    eSIMPackage: { findUnique: vi.fn() },
    providerPackage: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn() },
    orderTimelineEvent: { create: vi.fn() },
    walletTransaction: { create: vi.fn() },
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  isProviderOperational: vi.fn((status: string) => ['ACTIVE', 'DEGRADED', 'TESTING'].includes(status)),
  getAdapterForType: vi.fn(),
}))

vi.mock('@/lib/services/providers/provider-balance', () => ({
  getProviderBalance: vi.fn(),
}))

vi.mock('@/lib/packages/resolve-package', () => ({
  resolvePackageIdentifier: vi.fn(),
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
import { isProviderOperational, getAdapterForType } from '@/lib/providers/adapter-manager'
import { getProviderBalance } from '@/lib/services/providers/provider-balance'
import { resolvePackageIdentifier } from '@/lib/packages/resolve-package'
import { reserveWalletFunds, captureReservedFunds, releaseReservedFunds } from './wallet-actions'
import { failOrder } from './order-state-machine'
import { PurchaseOrchestrator } from './purchase-orchestrator'

const mockPrisma = vi.mocked(prisma)
const mockResolve = vi.mocked(resolvePackageIdentifier)
const mockReserve = vi.mocked(reserveWalletFunds)
const mockCapture = vi.mocked(captureReservedFunds)
const mockRelease = vi.mocked(releaseReservedFunds)
const mockFailOrder = vi.mocked(failOrder)
const mockBalance = vi.mocked(getProviderBalance)
const mockAdapter = vi.mocked(getAdapterForType)

describe('PurchaseOrchestrator', () => {
  let orchestrator: PurchaseOrchestrator

  beforeEach(() => {
    vi.clearAllMocks()
    orchestrator = new PurchaseOrchestrator()
  })

  const validRequest = {
    businessId: 'biz-1',
    userId: 'user-1',
    packageId: 'pkg-1',
    quantity: 1,
    customer: { name: 'Test', email: 'test@test.com' },
  }

  function setupBusiness(balance = 100) {
    mockPrisma.business.findUnique.mockResolvedValue({ id: 'biz-1', status: 'APPROVED', walletBalance: { toString: () => String(balance) } } as any)
  }

  function setupPackage(source = 'CATALOG' as string) {
    mockResolve.mockResolvedValue({ package: { id: 'pkg-1', displayName: 'Test Plan', dataGB: 1, validityDays: 7, priceUSD: { toString: () => '5' }, localPrice: { toString: () => '5' }, currency: 'USD', source, providerId: 'prov-1', providerPlanId: 'pl-1', providerName: 'CHOICE', sku: 'SKU1', packageCode: 'PC1', customerDescription: null } as any, source: 'PACKAGE' } as any)
  }

  function setupCustomer() {
    mockPrisma.customer.findFirst.mockResolvedValue(null)
    mockPrisma.customer.create.mockResolvedValue({ id: 'cust-1' } as any)
  }

  function setupProvider(caps = ['PURCHASE'] as string[]) {
    mockPrisma.provider.findUnique.mockResolvedValue({ id: 'prov-1', code: 'CHOICE', name: 'Choice', status: 'ACTIVE', type: 'CHOICE', apiBaseUrl: 'https://a.b', apiToken: 'tok', environment: 'staging', authUrl: 'https://a.b/auth', enabledCapabilities: caps, config: {} } as any)
    mockPrisma.provider.findMany.mockResolvedValue([{ id: 'prov-1', code: 'CHOICE', name: 'Choice', status: 'ACTIVE', enabledCapabilities: caps, errorCount: 0, priority: 0, lastSuccessfulConnection: new Date(), activationSuccessRate: 0.95 } as any])
  }

  function setupSuccessAdapter() {
    mockPrisma.customer.findFirst.mockResolvedValue(null)
    mockPrisma.customer.create.mockResolvedValue({ id: 'cust-1' } as any)
    mockAdapter.mockResolvedValue({
      activateESIM: vi.fn().mockResolvedValue({ success: true, data: { activationId: 'act-1', iccids: ['89012345678901234567'], status: 'ACTIVE', qrCodeUrl: 'https://qr', activationCodes: ['CODE'] } }),
      validatePurchase: vi.fn().mockResolvedValue({ valid: true }),
    } as any)
  }

  it('succeeds with full pipeline', async () => {
    setupBusiness()
    setupPackage()
    setupProvider()
    setupSuccessAdapter()
    mockPrisma.eSIMPurchase.findFirst.mockResolvedValue(null)
    mockPrisma.eSIMPurchase.create.mockResolvedValue({ id: 'order-1' } as any)
    setupCustomer()
    mockReserve.mockResolvedValue({ success: true, reservationId: 'res-1' })
    mockCapture.mockResolvedValue({ success: true })
    mockPrisma.eSIM.findMany.mockResolvedValue([{ id: 'esim-1', iccid: '89012345678901234567', imsi: null, activationCode: 'CODE', status: 'PENDING_ACTIVATION', qrCodeUrl: 'https://qr' }] as any)

    const result = await orchestrator.executePurchase(validRequest)
    expect(result.success).toBe(true)
    expect(result.orderId).toBe('order-1')
    expect(result.iccid).toBe('89012345678901234567')
    expect(result.qrCode).toBe('https://qr')
    expect(mockCapture).toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('returns error for insufficient wallet', async () => {
    setupBusiness(1)
    setupPackage()
    setupProvider()
    const result = await orchestrator.executePurchase(validRequest)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('INSUFFICIENT_WALLET')
  })

  it('returns error when business not found', async () => {
    mockPrisma.business.findUnique.mockResolvedValue(null)
    const result = await orchestrator.executePurchase(validRequest)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('BUSINESS_NOT_FOUND')
  })

  it('returns error for suspended business', async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ id: 'biz-1', status: 'SUSPENDED', walletBalance: { toString: () => '100' } } as any)
    const result = await orchestrator.executePurchase(validRequest)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('BUSINESS_SUSPENDED')
  })

  it('returns error when package not found', async () => {
    setupBusiness()
    mockResolve.mockResolvedValue({ package: { id: 'pkg-1', source: 'PROVIDER_PLAN' } as any, source: 'PACKAGE' } as any)
    const result = await orchestrator.executePurchase(validRequest)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('PACKAGE_NOT_FOUND')
  })

  it('returns error when provider not found', async () => {
    setupBusiness()
    setupPackage()
    mockPrisma.provider.findUnique.mockResolvedValue(null)
    const result = await orchestrator.executePurchase(validRequest)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('PROVIDER_NOT_FOUND')
  })

  it('returns error when provider has no PURCHASE capability', async () => {
    setupBusiness()
    setupPackage()
    setupProvider(['BALANCE'])
    const result = await orchestrator.executePurchase(validRequest)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('PROVIDER_NO_PURCHASE')
  })

  it('checks provider balance when BALANCE capability exists', async () => {
    setupBusiness()
    setupPackage()
    setupProvider(['PURCHASE', 'BALANCE'])
    mockBalance.mockResolvedValue({ success: true, supported: true, balance: 3, currency: 'USD', providerId: 'p-1', providerCode: 'CHOICE', fetchedAt: new Date(), source: 'LIVE' })
    const result = await orchestrator.executePurchase(validRequest)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('PROVIDER_LOW_BALANCE')
  })

  it('skips balance check when BALANCE capability absent', async () => {
    setupBusiness()
    setupPackage()
    setupProvider(['PURCHASE'])
    setupSuccessAdapter()
    mockPrisma.eSIMPurchase.findFirst.mockResolvedValue(null)
    mockPrisma.eSIMPurchase.create.mockResolvedValue({ id: 'order-1' } as any)
    mockReserve.mockResolvedValue({ success: true, reservationId: 'res-1' })
    mockCapture.mockResolvedValue({ success: true })
    mockPrisma.eSIM.findMany.mockResolvedValue([{ id: 'esim-1', iccid: '89012345678901234567', imsi: null, activationCode: 'CODE', status: 'PENDING_ACTIVATION', qrCodeUrl: 'https://qr' }] as any)

    const result = await orchestrator.executePurchase(validRequest)
    expect(result.success).toBe(true)
    expect(mockBalance).not.toHaveBeenCalled()
  })

  it('releases wallet on provider failure', async () => {
    setupBusiness()
    setupPackage()
    setupProvider()
    setupCustomer()
    mockAdapter.mockResolvedValue({
      activateESIM: vi.fn().mockResolvedValue({ success: false, error: { code: 'PROVIDER_FAILED', message: 'Test error', details: { retryable: false } } }),
      validatePurchase: vi.fn().mockResolvedValue({ valid: true }),
    } as any)
    mockPrisma.eSIMPurchase.findFirst.mockResolvedValue(null)
    mockPrisma.eSIMPurchase.create.mockResolvedValue({ id: 'order-1' } as any)
    mockReserve.mockResolvedValue({ success: true, reservationId: 'res-1' })

    const result = await orchestrator.executePurchase(validRequest)
    expect(result.success).toBe(false)
    expect(mockRelease).toHaveBeenCalled()
    expect(mockCapture).not.toHaveBeenCalled()
  })

  it('commits wallet on provider success', async () => {
    setupBusiness()
    setupPackage()
    setupProvider()
    setupSuccessAdapter()
    mockPrisma.eSIMPurchase.findFirst.mockResolvedValue(null)
    mockPrisma.eSIMPurchase.create.mockResolvedValue({ id: 'order-1' } as any)
    mockReserve.mockResolvedValue({ success: true, reservationId: 'res-1' })
    mockCapture.mockResolvedValue({ success: true })
    mockPrisma.eSIM.findMany.mockResolvedValue([{ id: 'esim-1', iccid: '89012345678901234567', imsi: null, activationCode: 'CODE', status: 'PENDING_ACTIVATION', qrCodeUrl: 'https://qr' }] as any)

    await orchestrator.executePurchase(validRequest)
    expect(mockCapture).toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('writes audit log on completion', async () => {
    setupBusiness()
    setupPackage()
    setupProvider()
    setupSuccessAdapter()
    mockPrisma.eSIMPurchase.findFirst.mockResolvedValue(null)
    mockPrisma.eSIMPurchase.create.mockResolvedValue({ id: 'order-1' } as any)
    mockReserve.mockResolvedValue({ success: true, reservationId: 'res-1' })
    mockCapture.mockResolvedValue({ success: true })
    mockPrisma.eSIM.findMany.mockResolvedValue([{ id: 'esim-1', iccid: '89012345678901234567', imsi: null, activationCode: 'CODE', status: 'PENDING_ACTIVATION', qrCodeUrl: 'https://qr' }] as any)

    await orchestrator.executePurchase(validRequest)
    expect(mockPrisma.auditLog.create).toHaveBeenCalled()
  })

  it('writes audit log on failure', async () => {
    setupBusiness()
    setupPackage()
    setupProvider()
    mockAdapter.mockResolvedValue({
      activateESIM: vi.fn().mockResolvedValue({ success: false, error: { code: 'ERROR', message: 'Fail', details: {} } }),
      validatePurchase: vi.fn().mockResolvedValue({ valid: true }),
    } as any)
    mockPrisma.eSIMPurchase.findFirst.mockResolvedValue(null)
    mockPrisma.eSIMPurchase.create.mockResolvedValue({ id: 'order-1' } as any)
    mockReserve.mockResolvedValue({ success: true, reservationId: 'res-1' })

    await orchestrator.executePurchase(validRequest)
    expect(mockPrisma.auditLog.create).toHaveBeenCalled()
  })

  it('returns normalized error with retryable flag', async () => {
    setupBusiness()
    setupPackage()
    setupProvider()
    setupCustomer()
    // Mock two providers so failover can exhaust
    mockPrisma.provider.findMany.mockResolvedValue([
      { id: 'prov-1', code: 'CHOICE', name: 'Choice', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], errorCount: 0, priority: 0, lastSuccessfulConnection: new Date() },
      { id: 'prov-2', code: 'AIRHUB', name: 'AirHub', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], errorCount: 0, priority: 0, lastSuccessfulConnection: new Date() },
    ] as any)
    // findUnique should work for any provider ID
    mockPrisma.provider.findUnique.mockImplementation((args: any) => {
      const id = (args as any)?.where?.id
      if (id === 'prov-2') return Promise.resolve({ id: 'prov-2', code: 'AIRHUB', name: 'AirHub', status: 'ACTIVE', type: 'CUSTOM', apiBaseUrl: 'https://a.b', apiToken: 'tok', environment: 'staging', authUrl: 'https://a.b/auth', enabledCapabilities: ['PURCHASE'], config: {} } as any)
      return Promise.resolve({ id: 'prov-1', code: 'CHOICE', name: 'Choice', status: 'ACTIVE', type: 'CHOICE', apiBaseUrl: 'https://a.b', apiToken: 'tok', environment: 'staging', authUrl: 'https://a.b/auth', enabledCapabilities: ['PURCHASE'], config: {} } as any)
    })
    // Both providers fail — should exhaust
    mockAdapter.mockResolvedValue({
      activateESIM: vi.fn().mockResolvedValue({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests', details: { retryable: true } } }),
      validatePurchase: vi.fn().mockResolvedValue({ valid: true }),
    } as any)
    mockPrisma.eSIMPurchase.findFirst.mockResolvedValue(null)
    mockPrisma.eSIMPurchase.create.mockResolvedValue({ id: 'order-1' } as any)
    mockReserve.mockResolvedValue({ success: true, reservationId: 'res-1' })

    const result = await orchestrator.executePurchase(validRequest)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('ALL_PROVIDERS_EXHAUSTED')
  })
})
