import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    eSIMPackage: { findUnique: vi.fn() },
    provider: { findUnique: vi.fn() },
    business: { findUnique: vi.fn() },
    eSIMTopUp: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    invoice: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  getAdapterForProvider: vi.fn(),
}))

vi.mock('@/lib/services/orders/wallet-actions', () => ({
  reserveTopUpFunds: vi.fn().mockResolvedValue({ success: true }),
  captureTopUpFundsUpToInTx: vi.fn().mockResolvedValue({ success: true }),
  releaseTopUpFundsUpTo: vi.fn().mockResolvedValue({ success: true, released: 0 }),
}))

vi.mock('@/lib/services/orders/order-state-machine', () => ({
  createTimelineEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/services/business-webhooks/dispatcher', () => ({
  enqueueBusinessWebhooks: vi.fn().mockResolvedValue(undefined),
}))

const { prisma } = await import('@/lib/prisma')
const { getAdapterForProvider } = await import('@/lib/providers/adapter-manager')
const { reserveTopUpFunds, captureTopUpFundsUpToInTx, releaseTopUpFundsUpTo } = await import('@/lib/services/orders/wallet-actions')
const { createTopUpOrder } = await import('./top-up-order')

const mockPrisma = vi.mocked(prisma)
const mockReserve = vi.mocked(reserveTopUpFunds)
const mockCaptureUpToInTx = vi.mocked(captureTopUpFundsUpToInTx)
const mockReleaseUpTo = vi.mocked(releaseTopUpFundsUpTo)

const txMock = {
  eSIMTopUp: { update: vi.fn().mockResolvedValue({}) },
  eSIM: { update: vi.fn().mockResolvedValue({}) },
  invoice: { create: vi.fn().mockResolvedValue({}) },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}

;(mockPrisma as any).$transaction = vi.fn(async (cb: any) => cb(txMock))

const esim = {
  id: 'esim-1',
  iccid: '89012345678901234567',
  imsi: null,
  status: 'ACTIVE',
  expiresAt: new Date(Date.now() + 30 * 86400000),
  purchase: {
    businessId: 'biz-1',
    package: { providerId: 'p1' },
    business: {},
  },
}

const topUpPkg = {
  id: 'pkg-1', isActive: true, productType: 'TOP_UP', providerId: 'p1',
  priceUSD: 10, currency: 'USD', displayName: '1GB', name: '1GB',
  dataGB: 1, validityDays: 30, providerPlanId: 'plan-1', sku: 'sku-1',
}

const provider = { id: 'p1', supportsTopUp: true }
const business = { id: 'biz-1', status: 'ACTIVE', walletBalance: 100 }

const adapter = { topUpESIM: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.eSIM.findUnique.mockResolvedValue(esim as any)
  mockPrisma.eSIMPackage.findUnique.mockResolvedValue(topUpPkg as any)
  mockPrisma.provider.findUnique.mockResolvedValue(provider as any)
  mockPrisma.business.findUnique.mockResolvedValue(business as any)
  mockPrisma.eSIMTopUp.create.mockResolvedValue({ id: 'topup-1', status: 'PENDING', amount: 10, currency: 'USD' } as any)
  mockPrisma.eSIMTopUp.findFirst.mockResolvedValue(null)
  ;(getAdapterForProvider as any).mockResolvedValue(adapter)
  adapter.topUpESIM.mockResolvedValue({
    success: true,
    data: { providerReference: 'ref-1', dataAddedMB: 1000, validityDaysAdded: 30, newDataTotalMB: 2048 },
  })
  mockReserve.mockResolvedValue({ success: true })
  mockCaptureUpToInTx.mockResolvedValue({ success: true })
  mockReleaseUpTo.mockResolvedValue({ success: true, released: 0 })
})

describe('F1 — top-ups are never free', () => {
  it('reserves wallet funds keyed by the TOP-UP id (not the purchase id)', async () => {
    const result = await createTopUpOrder({ businessId: 'biz-1', userId: 'u1', esimId: 'esim-1', topUpPackageId: 'pkg-1', quantity: 1 })

    expect(result.success).toBe(true)
    // Each top-up gets its own wallet billing identity — no short-circuit against the purchase ledger.
    expect(mockReserve).toHaveBeenCalledWith('topup-1', 'biz-1', 10)
    expect(mockCaptureUpToInTx).toHaveBeenCalledWith(expect.anything(), 'topup-1', 'biz-1', 10)
    expect(adapter.topUpESIM).toHaveBeenCalledTimes(1)
  })

  it('fails the top-up and skips provider dispatch when the wallet reserve fails', async () => {
    mockReserve.mockResolvedValue({ success: false, error: 'Insufficient wallet balance. Required: 10, Available: 5' })

    const result = await createTopUpOrder({ businessId: 'biz-1', userId: 'u1', esimId: 'esim-1', topUpPackageId: 'pkg-1', quantity: 1 })

    expect(result.success).toBe(false)
    expect(result.errorStatus).toBe(402)
    expect(mockPrisma.eSIMTopUp.update).toHaveBeenCalledWith({ where: { id: 'topup-1' }, data: expect.objectContaining({ status: 'FAILED' }) })
    expect(adapter.topUpESIM).not.toHaveBeenCalled()
  })

  it('charges the immutable quoted amount × quantity regardless of provider response', async () => {
    await createTopUpOrder({ businessId: 'biz-1', userId: 'u1', esimId: 'esim-1', topUpPackageId: 'pkg-1', quantity: 2 })

    // priceUSD=10 × quantity=2 → reserve and capture both use 20.
    expect(mockReserve).toHaveBeenCalledWith('topup-1', 'biz-1', 20)
    expect(mockCaptureUpToInTx).toHaveBeenCalledWith(expect.anything(), 'topup-1', 'biz-1', 20)
  })
})

describe('F2 — no double provider charge / double debit on retry', () => {
  it('idempotencyKey dedups: a retried request is never re-executed', async () => {
    mockPrisma.eSIMTopUp.findFirst.mockResolvedValue({ id: 'topup-1', status: 'COMPLETED', amount: 10, currency: 'USD', dataAddedMB: 1000, validityDaysAdded: 30 } as any)

    const result = await createTopUpOrder({ businessId: 'biz-1', userId: 'u1', esimId: 'esim-1', topUpPackageId: 'pkg-1', quantity: 1, idempotencyKey: 'key-123456789' })

    expect(result.success).toBe(true)
    expect(result.alreadyCompleted).toBe(true)
    expect(result.topUpId).toBe('topup-1')
    expect(mockPrisma.eSIMTopUp.create).not.toHaveBeenCalled()
    expect(adapter.topUpESIM).not.toHaveBeenCalled()
  })

  it('PENDING_REVIEW retry is never re-dispatched — it returns 409 with funds kept reserved', async () => {
    mockPrisma.eSIMTopUp.findFirst.mockResolvedValue({ id: 'topup-1', status: 'PENDING_REVIEW', amount: 10, currency: 'USD', dataAddedMB: null, validityDaysAdded: null } as any)

    const result = await createTopUpOrder({ businessId: 'biz-1', userId: 'u1', esimId: 'esim-1', topUpPackageId: 'pkg-1', quantity: 1, idempotencyKey: 'key-123456789' })

    expect(result.success).toBe(false)
    expect(result.errorStatus).toBe(409)
    expect(result.error).toContain('pending review')
    expect(mockPrisma.eSIMTopUp.create).not.toHaveBeenCalled()
    expect(adapter.topUpESIM).not.toHaveBeenCalled()
    expect(mockReleaseUpTo).not.toHaveBeenCalled()
  })

  it('idempotencyKey is scoped per business — the dedup lookup queries businessId + key', async () => {
    mockPrisma.eSIM.findUnique
      .mockResolvedValueOnce(esim as any)
      .mockResolvedValueOnce({ ...esim, purchase: { ...esim.purchase, businessId: 'biz-2' } } as any)

    await createTopUpOrder({ businessId: 'biz-1', userId: 'u1', esimId: 'esim-1', topUpPackageId: 'pkg-1', quantity: 1, idempotencyKey: 'key-123456789' })
    expect(mockPrisma.eSIMTopUp.findFirst).toHaveBeenCalledWith({ where: { businessId: 'biz-1', idempotencyKey: 'key-123456789' } })

    // A different business reusing the same key finds no match → its own top-up is created.
    await createTopUpOrder({ businessId: 'biz-2', userId: 'u1', esimId: 'esim-1', topUpPackageId: 'pkg-1', quantity: 1, idempotencyKey: 'key-123456789' })
    expect(mockPrisma.eSIMTopUp.findFirst).toHaveBeenCalledWith({ where: { businessId: 'biz-2', idempotencyKey: 'key-123456789' } })
    expect(mockPrisma.eSIMTopUp.create).toHaveBeenCalledTimes(2)
  })

  it('the same business reusing the same key is deduplicated even after a create race (P2002)', async () => {
    // Pre-check finds nothing, create races with a concurrent request, P2002 fires,
    // the recovery lookup then finds the winner and returns it without re-dispatching.
    mockPrisma.eSIMTopUp.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'topup-9', status: 'COMPLETED', amount: 10, currency: 'USD', dataAddedMB: 1000, validityDaysAdded: 30 } as any)
    mockPrisma.eSIMTopUp.create.mockRejectedValueOnce({ code: 'P2002' })

    const result = await createTopUpOrder({ businessId: 'biz-1', userId: 'u1', esimId: 'esim-1', topUpPackageId: 'pkg-1', quantity: 1, idempotencyKey: 'key-123456789' })

    expect(result.success).toBe(true)
    expect(result.topUpId).toBe('topup-9')
    expect(result.alreadyCompleted).toBe(true)
    expect(adapter.topUpESIM).not.toHaveBeenCalled()
  })

  it('UNCERTAIN (timeout) outcome keeps funds reserved — no release, no blind retry', async () => {
    adapter.topUpESIM.mockResolvedValue({ success: false, error: { code: 'TIMEOUT', message: 'Request timed out' } })

    const result = await createTopUpOrder({ businessId: 'biz-1', userId: 'u1', esimId: 'esim-1', topUpPackageId: 'pkg-1', quantity: 1 })

    expect(result.success).toBe(false)
    expect(mockPrisma.eSIMTopUp.update).toHaveBeenCalledWith({ where: { id: 'topup-1' }, data: expect.objectContaining({ status: 'PENDING_REVIEW' }) })
    expect(mockReleaseUpTo).not.toHaveBeenCalled()
  })

  it('DEFINITE failure releases the reservation exactly once and marks FAILED', async () => {
    adapter.topUpESIM.mockResolvedValue({ success: false, error: { code: 'REJECTED', message: 'Order rejected by provider' } })

    const result = await createTopUpOrder({ businessId: 'biz-1', userId: 'u1', esimId: 'esim-1', topUpPackageId: 'pkg-1', quantity: 1 })

    expect(result.success).toBe(false)
    expect(result.errorStatus).toBe(502)
    expect(mockReleaseUpTo).toHaveBeenCalledWith('topup-1', 'biz-1', 10)
    expect(mockPrisma.eSIMTopUp.update).toHaveBeenCalledWith({ where: { id: 'topup-1' }, data: expect.objectContaining({ status: 'FAILED' }) })
  })

  it('does not double-charge when a completion transaction partially fails', async () => {
    // Provider succeeded, wallet capture inside the completion tx fails.
    mockCaptureUpToInTx.mockResolvedValue({ success: false, error: 'Wallet capture failed' })

    const result = await createTopUpOrder({ businessId: 'biz-1', userId: 'u1', esimId: 'esim-1', topUpPackageId: 'pkg-1', quantity: 1 })

    // Completion is aborted; funds stay reserved (no release, no second capture).
    expect(result.success).toBe(false)
    expect(mockReleaseUpTo).not.toHaveBeenCalled()
    expect(mockCaptureUpToInTx).toHaveBeenCalledTimes(1)
  })
})
