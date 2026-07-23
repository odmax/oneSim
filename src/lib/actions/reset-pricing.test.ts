import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prisma } from '@/lib/prisma'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}))

vi.mock('@/lib/auth/config', () => ({
  authOptions: {},
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/services/catalog-price-sync', () => ({
  syncProviderPackageToPublishedProducts: vi.fn(),
  revalidateCatalogRoutes: vi.fn(),
  recordCatalogPriceSyncAudit: vi.fn(),
}))

import { getServerSession } from 'next-auth'
import { resetPricing } from './reset-pricing'
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes } from '@/lib/services/catalog-price-sync'

function makeSession(overrides: Record<string, any> = {}) {
  return { user: { id: 'admin-1', role: 'INTERNAL_ADMIN', email: 'admin@test.com', ...overrides } }
}

function makeBeforePackage(overrides: Record<string, any> = {}) {
  return {
    id: 'pkg-1',
    name: 'Test Plan',
    dataGB: 5,
    validityDays: 30,
    costPrice: 2.0,
    currency: 'USD',
    sellingPrice: 8.0,
    sellingCurrency: 'EUR',
    markupPercent: 300,
    providerPlanId: 'plan-1',
    providerId: 'prov-1',
    publishStatus: 'PUBLISHED',
    ...overrides,
  }
}

describe('resetPricing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue(makeSession() as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeBeforePackage()])
  })

  it('returns Unauthorized when no session', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null)
    const result = await resetPricing(['pkg-1'])
    expect(result).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('returns Unauthorized when role is not INTERNAL_ADMIN', async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'user-1', role: 'USER' } } as any)
    const result = await resetPricing(['pkg-1'])
    expect(result).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('returns error when packageIds is empty', async () => {
    const result = await resetPricing([])
    expect(result).toEqual({ success: false, error: 'No packages selected' })
  })

  it('returns error when packageIds is undefined', async () => {
    const result = await resetPricing(undefined as any)
    expect(result).toEqual({ success: false, error: 'No packages selected' })
  })

  it('resets values propagate to ProviderPackage', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 2 })

    const result = await resetPricing(['pkg-1', 'pkg-2'])

    expect(result).toEqual({ success: true, updated: 2 })
    expect(vi.mocked(prisma.providerPackage.updateMany)).toHaveBeenCalledWith({
      where: { id: { in: ['pkg-1', 'pkg-2'] } },
      data: {
        sellingPrice: null,
        sellingCurrency: 'USD',
        markupPercent: null,
        pricingMode: 'MARKUP_PERCENT',
        publishStatus: 'DRAFT',
        configurationStatus: 'UNCONFIGURED',
        autoConfiguredByRuleId: null,
        lastConfiguredAt: null,
        tags: expect.anything(),
        notes: null,
        isPreferred: false,
        preferredReason: null,
        preferredAt: null,
        excludedFromAutoPick: false,
        autoPickReason: null,
      },
    })
  })

  it('reset values propagate to Product Catalog via sync', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 1 })

    await resetPricing(['pkg-1'])

    expect(vi.mocked(syncProviderPackageToPublishedProducts)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(syncProviderPackageToPublishedProducts)).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        id: 'pkg-1',
        sellingPrice: null,
        sellingCurrency: 'USD',
        markupPercent: null,
        publishStatus: 'DRAFT',
      }),
    )
  })

  it('hidden/archived products remain hidden (sync does not touch visibility)', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 1 })

    await resetPricing(['pkg-1'])

    const syncCalls = vi.mocked(syncProviderPackageToPublishedProducts).mock.calls
    for (const [, merged] of syncCalls) {
      expect(merged).not.toHaveProperty('publishStatus', 'HIDDEN')
      expect(merged).not.toHaveProperty('publishStatus', 'ARCHIVED')
    }
  })

  it('returns structured error when transaction fails', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('Transaction failed'))
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeBeforePackage()])

    const result = await resetPricing(['pkg-1'])

    expect(result).toEqual({ success: false, error: 'Transaction failed' })
  })

  it('calls revalidateCatalogRoutes only after success', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 1 })

    await resetPricing(['pkg-1'])

    expect(vi.mocked(revalidateCatalogRoutes)).toHaveBeenCalledTimes(1)
  })

  it('does not call revalidateCatalogRoutes on failure', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('fail'))

    await resetPricing(['pkg-1'])

    expect(vi.mocked(revalidateCatalogRoutes)).not.toHaveBeenCalled()
  })

  it('creates audit log after success', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 2 })

    await resetPricing(['pkg-1', 'pkg-2'])

    expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalledWith({
      data: {
        userId: 'admin-1',
        action: 'RESET_TO_FACTORY',
        entity: 'ProviderPackage',
        details: 'Reset 2 packages to factory defaults',
      },
    })
  })
})
