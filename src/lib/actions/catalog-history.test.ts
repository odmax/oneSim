import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogChangeSet: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    providerPackage: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
}))

vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
  default: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/services/catalog-price-sync', () => ({
  syncProviderPackageToPublishedProducts: vi.fn(),
  revalidateCatalogRoutes: vi.fn(),
}))

import { getServerSession } from 'next-auth'
import { prisma } from '@/lib/prisma'
import { rollbackChangeSet } from './catalog-history'
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes } from '@/lib/services/catalog-price-sync'

const mockSession = { user: { id: 'admin-1', role: 'INTERNAL_ADMIN', email: 'admin@test.com' } }
const mockDecimal = (n: number) => ({ toString: () => n.toString() })

function makeChangeSetItem(overrides: Record<string, any> = {}) {
  return {
    id: 'item-1',
    changeSetId: 'cs-1',
    providerPackageId: 'pp-1',
    before: {
      sellingPrice: 5,
      sellingCurrency: 'USD',
      markupPercent: 100,
      pricingMode: 'MARKUP_PERCENT',
      publishStatus: 'READY',
      configurationStatus: 'CONFIGURED',
      tags: null,
      notes: null,
      isPreferred: null,
      preferredReason: null,
      preferredAt: null,
      excludedFromAutoPick: null,
      autoPickReason: null,
    },
    after: {
      sellingPrice: 10,
      sellingCurrency: 'USD',
      markupPercent: 200,
      pricingMode: 'MARKUP_PERCENT',
      publishStatus: 'PUBLISHED',
      configurationStatus: 'AUTO_CONFIGURED',
      tags: null,
      notes: null,
      isPreferred: null,
      preferredReason: null,
      preferredAt: null,
      excludedFromAutoPick: null,
      autoPickReason: null,
    },
    createdAt: new Date(),
    ...overrides,
  }
}

function makeProviderPackageForRollback(overrides: Record<string, any> = {}) {
  return {
    id: 'pp-1',
    name: 'Test Plan',
    dataGB: 5,
    validityDays: 30,
    costPrice: mockDecimal(3),
    currency: 'USD',
    sellingPrice: mockDecimal(10),
    sellingCurrency: 'USD',
    markupPercent: mockDecimal(200),
    providerPlanId: 'plan-1',
    providerId: 'prov-1',
    publishStatus: 'PUBLISHED',
    ...overrides,
  }
}

describe('rollbackChangeSet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any)
  })

  it('returns error when unauthorized', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null)

    const result = await rollbackChangeSet('cs-1')

    expect(result).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('returns error when change set not found', async () => {
    vi.mocked(prisma.catalogChangeSet.findUnique).mockResolvedValue(null)

    const result = await rollbackChangeSet('cs-1')

    expect(result).toEqual({ success: false, error: 'Change set not found' })
  })

  it('cannot rollback a ROLLBACK action type', async () => {
    vi.mocked(prisma.catalogChangeSet.findUnique).mockResolvedValue({
      id: 'cs-1',
      actionType: 'ROLLBACK',
      items: [],
    } as any)

    const result = await rollbackChangeSet('cs-1')

    expect(result).toEqual({ success: false, error: 'Cannot rollback a rollback' })
  })

  it('successful rollback restores tracked ProviderPackage fields', async () => {
    const item = makeChangeSetItem()
    vi.mocked(prisma.catalogChangeSet.findUnique).mockResolvedValue({
      id: 'cs-1',
      actionType: 'BULK_PUBLISH',
      items: [item],
    } as any)

    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeProviderPackageForRollback()] as any)

    let capturedUpdate: any = null
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        providerPackage: {
          update: vi.fn().mockImplementation((args: any) => {
            capturedUpdate = args
            return {}
          }),
        },
      }
      await cb(tx)
    })

    const result = await rollbackChangeSet('cs-1')

    expect(result.success).toBe(true)
    expect(result.rolledBack).toBe(1)
    expect(capturedUpdate.where).toEqual({ id: 'pp-1' })
    expect(capturedUpdate.data.sellingPrice).toBe(5)
    expect(capturedUpdate.data.sellingCurrency).toBe('USD')
    expect(capturedUpdate.data.markupPercent).toBe(100)
    expect(capturedUpdate.data.pricingMode).toBe('MARKUP_PERCENT')
    expect(capturedUpdate.data.publishStatus).toBe('READY')
    expect(capturedUpdate.data.configurationStatus).toBe('CONFIGURED')
  })

  it('linked Product Catalog values synchronize to restored pricing via sync', async () => {
    const item = makeChangeSetItem()
    vi.mocked(prisma.catalogChangeSet.findUnique).mockResolvedValue({
      id: 'cs-1',
      actionType: 'BULK_PUBLISH',
      items: [item],
    } as any)

    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeProviderPackageForRollback()] as any)

    let capturedSyncArgs: any = null
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        providerPackage: {
          update: vi.fn().mockResolvedValue({}),
        },
      }
      vi.mocked(syncProviderPackageToPublishedProducts).mockImplementation((_tx: any, pp: any) => {
        capturedSyncArgs = pp
        return {} as any
      })
      await cb(tx)
    })

    await rollbackChangeSet('cs-1')

    expect(syncProviderPackageToPublishedProducts).toHaveBeenCalled()
    expect(capturedSyncArgs.sellingPrice).toBe(5)
    expect(capturedSyncArgs.markupPercent).toBe(100)
  })

  it('creates new Rollback change set and audit log', async () => {
    const item = makeChangeSetItem()
    vi.mocked(prisma.catalogChangeSet.findUnique).mockResolvedValue({
      id: 'cs-1',
      actionType: 'BULK_PUBLISH',
      description: 'Bulk publish',
      items: [item],
    } as any)

    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeProviderPackageForRollback()] as any)

    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      await cb(tx)
    })

    vi.mocked(prisma.catalogChangeSet.create).mockResolvedValue({ id: 'cs-rollback-1' } as any)

    await rollbackChangeSet('cs-1')

    expect(prisma.catalogChangeSet.create).toHaveBeenCalledWith({
      data: {
        actionType: 'ROLLBACK',
        description: 'Rollback of BULK_PUBLISH',
        createdById: 'admin-1',
        totalChanged: 1,
        metadata: { originalChangeSetId: 'cs-1' },
      },
    })

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'admin-1',
        action: 'CATALOG_ROLLBACK',
        entity: 'CatalogChangeSet',
        entityId: 'cs-1',
        details: 'Rolled back 1 packages',
      },
    })
  })

  it('revalidateCatalogRoutes called after successful rollback', async () => {
    const item = makeChangeSetItem()
    vi.mocked(prisma.catalogChangeSet.findUnique).mockResolvedValue({
      id: 'cs-1',
      actionType: 'BULK_PUBLISH',
      items: [item],
    } as any)

    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeProviderPackageForRollback()] as any)

    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      await cb(tx)
    })

    await rollbackChangeSet('cs-1')

    expect(revalidateCatalogRoutes).toHaveBeenCalled()
  })

  it('failed transaction returns structured error', async () => {
    const item = makeChangeSetItem()
    vi.mocked(prisma.catalogChangeSet.findUnique).mockResolvedValue({
      id: 'cs-1',
      actionType: 'BULK_PUBLISH',
      items: [item],
    } as any)

    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeProviderPackageForRollback()] as any)

    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('Transaction timeout'))

    const result = await rollbackChangeSet('cs-1')

    expect(result).toEqual({ success: false, error: 'Transaction timeout' })
  })

  it('non-tracked fields remain at current values (TRACKED_FIELDS design preserved)', async () => {
    const item = makeChangeSetItem({
      before: {
        sellingPrice: 5,
        sellingCurrency: 'USD',
        markupPercent: 100,
        pricingMode: 'MARKUP_PERCENT',
        publishStatus: 'READY',
        configurationStatus: 'CONFIGURED',
        tags: null,
        notes: null,
        isPreferred: null,
        preferredReason: null,
        preferredAt: null,
        excludedFromAutoPick: null,
        autoPickReason: null,
        costPrice: 1,
        name: 'Old Name',
      },
    })
    vi.mocked(prisma.catalogChangeSet.findUnique).mockResolvedValue({
      id: 'cs-1',
      actionType: 'BULK_PUBLISH',
      items: [item],
    } as any)

    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeProviderPackageForRollback()] as any)

    let capturedUpdateData: any = null
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        providerPackage: {
          update: vi.fn().mockImplementation((args: any) => {
            capturedUpdateData = args.data
            return {}
          }),
        },
      }
      await cb(tx)
    })

    await rollbackChangeSet('cs-1')

    expect(capturedUpdateData.costPrice).toBe(1)    // costPrice IS a tracked field (Phase 5C)
    expect(capturedUpdateData.name).toBeUndefined()  // name is NOT tracked
    expect(capturedUpdateData.sellingPrice).toBe(5)
  })

  it('skip count is correct when before data is empty', async () => {
    const itemWithEmptyBefore = makeChangeSetItem({
      before: {},
    })
    vi.mocked(prisma.catalogChangeSet.findUnique).mockResolvedValue({
      id: 'cs-1',
      actionType: 'BULK_PUBLISH',
      description: 'Bulk publish',
      items: [itemWithEmptyBefore],
    } as any)

    const result = await rollbackChangeSet('cs-1')

    expect(result.success).toBe(true)
    expect(result.rolledBack).toBe(0)
    expect(result.skipped).toBe(1)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})
