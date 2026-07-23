import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetServerSession } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
}))

const { mockSyncProviderPackageToPublishedProducts, mockRevalidateCatalogRoutes, mockRecordCatalogPriceSyncAudit } = vi.hoisted(() => ({
  mockSyncProviderPackageToPublishedProducts: vi.fn(),
  mockRevalidateCatalogRoutes: vi.fn(),
  mockRecordCatalogPriceSyncAudit: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(),
    providerPackage: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  },
}))

vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))

vi.mock('next-auth', () => ({
  getServerSession: mockGetServerSession,
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/services/catalog-price-sync', () => ({
  syncProviderPackageToPublishedProducts: mockSyncProviderPackageToPublishedProducts,
  revalidateCatalogRoutes: mockRevalidateCatalogRoutes,
  recordCatalogPriceSyncAudit: mockRecordCatalogPriceSyncAudit,
}))

import { updateSinglePackage } from './package-edit'

const mockSession = { user: { id: 'user-1', role: 'INTERNAL_ADMIN' } }

const mockPackage = {
  id: 'pp-1',
  name: 'Test Package',
  dataGB: 7,
  validityDays: 30,
  costPrice: { toString: () => '5.00' },
  currency: 'USD',
  sellingPrice: { toString: () => '15.00' },
  sellingCurrency: 'USD',
  markupPercent: { toString: () => '20' },
  providerPlanId: 'plan-1',
  providerId: 'prov-1',
  publishStatus: 'PUBLISHED',
  configurationStatus: 'CONFIGURED',
  lastConfiguredAt: new Date(),
}

describe('updateSinglePackage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetServerSession.mockResolvedValue(mockSession)
    mockSyncProviderPackageToPublishedProducts.mockResolvedValue(undefined)
    mockRevalidateCatalogRoutes.mockResolvedValue(undefined)
    mockRecordCatalogPriceSyncAudit.mockResolvedValue(undefined)
  })

  it('returns unauthorized for non-INTERNAL_ADMIN role', async () => {
    mockGetServerSession.mockResolvedValueOnce({ user: { id: 'user-1', role: 'USER' } })

    const result = await updateSinglePackage('pp-1', { sellingPrice: 19.99 })
    expect(result).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('returns unauthorized for no session', async () => {
    mockGetServerSession.mockResolvedValueOnce(null)

    const result = await updateSinglePackage('pp-1', { sellingPrice: 19.99 })
    expect(result).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('updates ProviderPackage and syncs Product Catalog on markup change', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(mockPackage),
          update: vi.fn().mockResolvedValue({ ...mockPackage, markupPercent: { toString: () => '30' }, sellingPrice: { toString: () => '19.99' } }),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', { markupPercent: 30 })

    expect(result).toEqual({ success: true })
    expect(mockSyncProviderPackageToPublishedProducts).toHaveBeenCalled()
  })

  it('updates ProviderPackage and syncs Product Catalog on selling price change', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(mockPackage),
          update: vi.fn().mockResolvedValue({ ...mockPackage, sellingPrice: { toString: () => '19.99' } }),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', { sellingPrice: 19.99 })

    expect(result).toEqual({ success: true })
    expect(mockSyncProviderPackageToPublishedProducts).toHaveBeenCalled()
  })

  it('calls recordCatalogPriceSyncAudit and revalidation after successful commit', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(mockPackage),
          update: vi.fn().mockResolvedValue({ ...mockPackage, sellingPrice: { toString: () => '19.99' } }),
        },
      }
      return cb(tx)
    })

    await updateSinglePackage('pp-1', { sellingPrice: 19.99 })

    expect(mockRecordCatalogPriceSyncAudit).toHaveBeenCalled()
    expect(mockRevalidateCatalogRoutes).toHaveBeenCalled()
  })

  it('does not call audit or revalidation on transaction failure', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockRejectedValue(new Error('DB error'))

    const result = await updateSinglePackage('pp-1', { sellingPrice: 19.99 })

    expect(result).toEqual({ success: false, error: 'DB error' })
    expect(mockRecordCatalogPriceSyncAudit).not.toHaveBeenCalled()
    expect(mockRevalidateCatalogRoutes).not.toHaveBeenCalled()
  })

  it('does not call audit or revalidation when sync fails inside transaction', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    mockSyncProviderPackageToPublishedProducts.mockRejectedValue(new Error('Sync error'))

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(mockPackage),
          update: vi.fn().mockResolvedValue({ ...mockPackage }),
        },
      }
      try {
        await cb(tx)
      } catch {
        // transaction rolls back internally
      }
    })

    await updateSinglePackage('pp-1', { sellingPrice: 19.99 })

    expect(mockRecordCatalogPriceSyncAudit).not.toHaveBeenCalled()
    expect(mockRevalidateCatalogRoutes).not.toHaveBeenCalled()
  })

  it('returns error when package not found', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('nonexistent', { sellingPrice: 19.99 })
    expect(result).toEqual({ success: false, error: 'Package not found' })
  })

  it('returns error when no fields to update', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(mockPackage),
          update: vi.fn(),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', {})
    expect(result).toEqual({ success: false, error: 'No fields to update' })
  })

  it('returns structured success on completion', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(mockPackage),
          update: vi.fn().mockResolvedValue({ ...mockPackage, sellingPrice: { toString: () => '19.99' } }),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', { sellingPrice: 19.99 })
    expect(result).toEqual({ success: true })
  })
})