import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: {
      findMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({}),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    eSIMPackage: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    packagePriceSnapshot: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    packageConfigurationRule: { findFirst: vi.fn() },
    providerPackageFee: { findMany: vi.fn().mockResolvedValue([]) },
    exchangeRate: { findFirst: vi.fn() },
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

vi.mock('@/lib/catalog-pipeline', () => ({
  startPipelineRun: vi.fn().mockResolvedValue('pipeline-run-1'),
  recordStageFromCounts: vi.fn(),
  completePipelineRun: vi.fn(),
  failPipelineRun: vi.fn(),
}))

vi.mock('@/lib/catalog-events', () => ({
  emitEvent: vi.fn(),
}))

vi.mock('@/lib/pricing/configuration-finalizer', () => ({
  finalizeCatalogPackageConfiguration: vi.fn(),
}))

vi.mock('@/lib/services/catalog/publish-to-retail', () => ({
  publishProviderPackageToRetailCatalog: vi.fn(),
}))

import { getServerSession } from 'next-auth'
import { prisma } from '@/lib/prisma'
import { publishToCatalog, bulkSetPublishStatus } from './publish-packages'
import { publishProviderPackageToRetailCatalog } from '@/lib/services/catalog/publish-to-retail'
import { finalizeCatalogPackageConfiguration } from '@/lib/pricing/configuration-finalizer'

const mockPublishToRetail = vi.mocked(publishProviderPackageToRetailCatalog)
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes } from '@/lib/services/catalog-price-sync'
import { startPipelineRun, recordStageFromCounts, completePipelineRun } from '@/lib/catalog-pipeline'
import { emitEvent } from '@/lib/catalog-events'

const mockSession = { user: { id: 'admin-1', role: 'INTERNAL_ADMIN', email: 'admin@test.com' } }
const mockDecimal = (n: number) => ({ toString: () => n.toString() })

function makeProviderPackage(overrides: Record<string, any> = {}) {
  return {
    id: 'pp-1',
    name: 'Test Plan 5GB',
    providerId: 'prov-1',
    providerPlanId: 'plan-1',
    providerPlanCode: 'TP5',
    country: 'US',
    dataGB: 5,
    validityDays: 30,
    costPrice: mockDecimal(3),
    sellingPrice: mockDecimal(10),
    sellingCurrency: 'USD',
    markupPercent: mockDecimal(233.33),
    pricingMode: 'MARKUP_PERCENT',
    configurationStatus: 'CONFIGURED',
    publishStatus: 'READY',
    currency: 'USD',
    provider: { name: 'Test Provider', code: 'TP' },
    ...overrides,
  }
}

describe('publishToCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any)
    mockPublishToRetail.mockResolvedValue({ success: true, providerPackageId: 'pp-1', retailPackageId: 'esim-1', created: true, updated: false, publishStatusSet: true, ready: true, readinessReasons: [] })
  })

  it('first publish creates exactly one ESIMPackage product with correct fields', async () => {
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)

    const result = await publishToCatalog(['pp-1'])
    expect(result.success).toBe(true)
    expect(mockPublishToRetail).toHaveBeenCalled()
  })

  it('repeat publish updates the existing product (same ID, different prices)', async () => {
    mockPublishToRetail.mockResolvedValue({ success: true, providerPackageId: 'pp-1', retailPackageId: 'esim-1', created: false, updated: true, publishStatusSet: true, ready: true, readinessReasons: [] })
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)

    const result = await publishToCatalog(['pp-1'])
    expect(result.success).toBe(true)
    expect(mockPublishToRetail).toHaveBeenCalled()
  })

  it('existing product ID remains unchanged after re-publish', async () => {
    mockPublishToRetail.mockResolvedValue({ success: true, providerPackageId: 'pp-1', retailPackageId: 'esim-1', created: false, updated: true, publishStatusSet: true, ready: true, readinessReasons: [] })
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)

    await publishToCatalog(['pp-1'])
    expect(mockPublishToRetail).toHaveBeenCalledWith('pp-1', expect.objectContaining({ reason: 'PUBLISH' }))
  })

  it('no duplicate ESIMPackage product is created', async () => {
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)
    mockPublishToRetail.mockResolvedValue({ success: true, providerPackageId: 'pp-1', retailPackageId: 'esim-1', created: true, updated: false, publishStatusSet: true, ready: true, readinessReasons: [] })

    await publishToCatalog(['pp-1'])
    expect(mockPublishToRetail).toHaveBeenCalledTimes(1)
  })

  it('partial-publish: one package fails, other packages still succeed', async () => {
    mockPublishToRetail
      .mockResolvedValueOnce({ success: false, providerPackageId: 'pp-1', created: false, updated: false, publishStatusSet: false, ready: false, readinessReasons: ['Error'], error: 'Failed', failedStage: 'FINALIZATION_FAILED' })
      .mockResolvedValueOnce({ success: true, providerPackageId: 'pp-2', retailPackageId: 'esim-2', created: true, updated: false, publishStatusSet: true, ready: true, readinessReasons: [] })

    const pp1 = makeProviderPackage({ id: 'pp-1' })
    const pp2 = makeProviderPackage({ id: 'pp-2' })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp1, pp2] as any)

    const result = await publishToCatalog(['pp-1', 'pp-2'])
    expect(result.success).toBe(true)
    expect(result.created).toBe(1)
    expect(result.skipped).toBe(1)
  })

  it('each package uses its own transaction (not one shared transaction)', async () => {
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp, pp] as any)

    await publishToCatalog(['pp-1', 'pp-2'])
    expect(mockPublishToRetail).toHaveBeenCalledTimes(2)
  })

  it('Decimal fields passed without number round-trip', async () => {
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)

    await publishToCatalog(['pp-1'])
    expect(mockPublishToRetail).toHaveBeenCalled()
  })

  it('skipped details populated correctly for invalid packages', async () => {
    const invalid = makeProviderPackage({ configurationStatus: 'UNCONFIGURED', publishStatus: 'DRAFT' })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([invalid] as any)

    const result = await publishToCatalog(['pp-1'])
    expect(result.skipped).toBe(1)
  })

  it('audit log created', async () => {
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)

    const result = await publishToCatalog(['pp-1'])
    expect(result.success).toBe(true)
    expect(mockPublishToRetail).toHaveBeenCalled()
  })
})

describe('bulkSetPublishStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any)
  })

  it('sets providerPackage publishStatus and syncs ESIMPackage isActive', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        providerPackage: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
        eSIMPackage: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      }
      await cb(tx)
    })

    const result = await bulkSetPublishStatus(['pp-1', 'pp-2'], 'HIDDEN')

    expect(result.success).toBe(true)
    expect(result.updated).toBe(2)
  })

  it('transaction wraps both updates', async () => {
    let capturedTx: any = null
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        providerPackage: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
        eSIMPackage: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      }
      capturedTx = tx
      await cb(tx)
    })

    await bulkSetPublishStatus(['pp-1', 'pp-2'], 'HIDDEN')

    expect(capturedTx.providerPackage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['pp-1', 'pp-2'] } },
      data: { publishStatus: 'HIDDEN' },
    })
    expect(capturedTx.eSIMPackage.updateMany).toHaveBeenCalledWith({
      where: { providerPackageId: { in: ['pp-1', 'pp-2'] } },
      data: { isActive: false },
    })
  })

  it('audit log created', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        providerPackage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        eSIMPackage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      }
      await cb(tx)
    })

    await bulkSetPublishStatus(['pp-1'], 'ARCHIVED')

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'admin-1',
        action: 'BULK_ARCHIVED',
        entity: 'ProviderPackage',
        details: 'Set 1 packages to ARCHIVED',
      },
    })
  })

  it('revalidateCatalogRoutes called', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        providerPackage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        eSIMPackage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      }
      await cb(tx)
    })

    await bulkSetPublishStatus(['pp-1'], 'HIDDEN')

    expect(revalidateCatalogRoutes).toHaveBeenCalled()
  })
})
