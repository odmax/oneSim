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

  it('recalculates selling price from cost + markup when only markup is edited (bug: cost+markup with NULL selling)', async () => {
    const { prisma } = await import('@/lib/prisma') as any
    // Before: cost 5, markup 20, selling NULL (the reported inconsistent state).
    const beforeState = { ...mockPackage, publishStatus: 'DRAFT', costPrice: { toString: () => '5.00' }, sellingPrice: null, markupPercent: { toString: () => '20' } }
    let updateData: any = null
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(beforeState),
          update: vi.fn().mockImplementation(async (arg: any) => { updateData = arg.data; return { ...beforeState, ...arg.data } }),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', { markupPercent: 30 })
    expect(result.success).toBe(true)
    // 5 * (1 + 30/100) = 6.50 — selling is never left null when determinable.
    expect(updateData.sellingPrice).toBe(6.5)
    expect(updateData.markupPercent).toBe(30)
  })

  it('recalculates markup from cost + selling when only selling is edited', async () => {
    const { prisma } = await import('@/lib/prisma') as any
    const beforeState = { ...mockPackage, publishStatus: 'DRAFT', costPrice: { toString: () => '7.00' }, sellingPrice: null, markupPercent: null }
    let updateData: any = null
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(beforeState),
          update: vi.fn().mockImplementation(async (arg: any) => { updateData = arg.data; return { ...beforeState, ...arg.data } }),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', { sellingPrice: 8 })
    expect(result.success).toBe(true)
    expect(updateData.markupPercent).toBe(14.29) // ((8-7)/7)*100 → 14.29
    expect(updateData.sellingPrice).toBe(8)
  })

  it('recalculates the dependent value on a cost edit (markup-known branch)', async () => {
    const { prisma } = await import('@/lib/prisma') as any
    const beforeState = { ...mockPackage, publishStatus: 'DRAFT', costPrice: { toString: () => '7.00' }, sellingPrice: null, markupPercent: { toString: () => '9.89' } }
    let updateData: any = null
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(beforeState),
          update: vi.fn().mockImplementation(async (arg: any) => { updateData = arg.data; return { ...beforeState, ...arg.data } }),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', { costPrice: 7 })
    expect(result.success).toBe(true)
    expect(updateData.sellingPrice).toBe(7.69) // 7 * 1.0989 = 7.6923 → 7.69
  })

  it('CONFIGURED cannot retain a deterministically missing selling price', async () => {
    const { prisma } = await import('@/lib/prisma') as any
    const beforeState = { ...mockPackage, publishStatus: 'DRAFT', costPrice: { toString: () => '7.00' }, sellingPrice: null, markupPercent: null }
    let updateData: any = null
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(beforeState),
          update: vi.fn().mockImplementation(async (arg: any) => { updateData = arg.data; return { ...beforeState, ...arg.data } }),
        },
      }
      return cb(tx)
    })

    // Setting CONFIGURED with cost+markup (and NO selling) must compute selling.
    const result = await updateSinglePackage('pp-1', { configurationStatus: 'CONFIGURED', costPrice: 7, markupPercent: 9.89 })
    expect(result.success).toBe(true)
    expect(updateData.configurationStatus).toBe('CONFIGURED')
    expect(updateData.sellingPrice).toBe(7.69) // 7 * 1.0989 → 7.69 — never left null
    expect(updateData.markupPercent).toBe(9.89)
  })
})