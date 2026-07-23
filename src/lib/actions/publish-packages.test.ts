import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    eSIMPackage: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
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

vi.mock('@/lib/catalog-pipeline', () => ({
  startPipelineRun: vi.fn().mockResolvedValue('pipeline-run-1'),
  recordStageFromCounts: vi.fn(),
  completePipelineRun: vi.fn(),
  failPipelineRun: vi.fn(),
}))

vi.mock('@/lib/catalog-events', () => ({
  emitEvent: vi.fn(),
}))

import { getServerSession } from 'next-auth'
import { prisma } from '@/lib/prisma'
import { publishToCatalog, bulkSetPublishStatus } from './publish-packages'
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
  })

  it('first publish creates exactly one ESIMPackage product with correct fields', async () => {
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)
    vi.mocked(prisma.eSIMPackage.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.eSIMPackage.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        eSIMPackage: {
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'esim-1' }),
        },
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      await cb(tx)
    })

    const result = await publishToCatalog(['pp-1'])

    expect(result.success).toBe(true)
    expect(result.created).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.skipped).toBe(0)
    expect(prisma.$transaction).toHaveBeenCalled()
    expect(syncProviderPackageToPublishedProducts).not.toHaveBeenCalled()
  })

  it('repeat publish updates the existing product (same ID, different prices)', async () => {
    const pp = makeProviderPackage({ sellingPrice: mockDecimal(15) })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)
    vi.mocked(prisma.eSIMPackage.findFirst).mockResolvedValue({ id: 'esim-1', providerPackageId: 'pp-1' })
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        eSIMPackage: {
          findFirst: vi.fn().mockResolvedValue({ id: 'esim-1', providerPackageId: 'pp-1' }),
        },
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      await cb(tx)
    })

    const result = await publishToCatalog(['pp-1'])

    expect(result.success).toBe(true)
    expect(result.updated).toBe(1)
    expect(result.created).toBe(0)
    expect(syncProviderPackageToPublishedProducts).toHaveBeenCalled()
  })

  it('existing product ID remains unchanged after re-publish', async () => {
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)
    vi.mocked(prisma.eSIMPackage.findFirst).mockResolvedValue({ id: 'esim-1', providerPackageId: 'pp-1' })
    let capturedTx: any = null
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        eSIMPackage: {
          findFirst: vi.fn().mockResolvedValue({ id: 'esim-1', providerPackageId: 'pp-1' }),
        },
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      capturedTx = tx
      await cb(tx)
    })

    await publishToCatalog(['pp-1'])

    expect(capturedTx.eSIMPackage.create).toBeUndefined()
    expect(syncProviderPackageToPublishedProducts).toHaveBeenCalled()
  })

  it('no duplicate ESIMPackage product is created', async () => {
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)
    vi.mocked(prisma.eSIMPackage.findFirst).mockResolvedValue({ id: 'esim-1', providerPackageId: 'pp-1' })
    const createSpy = vi.fn()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        eSIMPackage: {
          findFirst: vi.fn().mockResolvedValue({ id: 'esim-1', providerPackageId: 'pp-1' }),
          create: createSpy,
        },
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      await cb(tx)
    })

    await publishToCatalog(['pp-1'])

    expect(createSpy).not.toHaveBeenCalled()
  })

  it('partial-publish: one package fails, other packages still succeed', async () => {
    const ppGood = makeProviderPackage({ id: 'pp-good', name: 'Good Plan', providerPlanCode: 'GP' })
    const ppBad = makeProviderPackage({ id: 'pp-bad', name: 'Bad Plan', costPrice: mockDecimal(0) })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([ppGood, ppBad] as any)

    vi.mocked(prisma.eSIMPackage.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.eSIMPackage.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        eSIMPackage: {
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'esim-new' }),
        },
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      await cb(tx)
    })

    const result = await publishToCatalog(['pp-good', 'pp-bad'])

    expect(result.success).toBe(true)
    expect(result.created).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.skippedDetails).toHaveLength(1)
    expect(result.skippedDetails![0].packageId).toBe('pp-bad')
    expect(result.skippedDetails![0].reason).toContain('costPrice')
  })

  it('each package uses its own transaction (not one shared transaction)', async () => {
    const pp1 = makeProviderPackage({ id: 'pp-1', name: 'Plan A' })
    const pp2 = makeProviderPackage({ id: 'pp-2', name: 'Plan B' })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp1, pp2] as any)
    vi.mocked(prisma.eSIMPackage.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.eSIMPackage.findUnique).mockResolvedValue(null)

    const transactionCalls: any[] = []
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        eSIMPackage: {
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: `esim-${transactionCalls.length}` }),
        },
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      transactionCalls.push(tx)
      await cb(tx)
    })

    await publishToCatalog(['pp-1', 'pp-2'])

    expect(transactionCalls).toHaveLength(2)
  })

  it('Decimal fields passed without number round-trip', async () => {
    const pp = makeProviderPackage({ sellingPrice: mockDecimal(9.99), costPrice: mockDecimal(2.5) })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)
    vi.mocked(prisma.eSIMPackage.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.eSIMPackage.findUnique).mockResolvedValue(null)

    let capturedData: any = null
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        eSIMPackage: {
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => {
            capturedData = args.data
            return { id: 'esim-1' }
          }),
        },
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      await cb(tx)
    })

    await publishToCatalog(['pp-1'])

    expect(capturedData.priceUSD).toEqual(pp.sellingPrice)
    expect(capturedData.localPrice).toEqual(pp.sellingPrice)
    expect(capturedData.costPriceUSD).toEqual(pp.costPrice)
    expect(typeof capturedData.priceUSD).not.toBe('number')
  })

  it('skipped details populated correctly for invalid packages', async () => {
    const ppNoCost = makeProviderPackage({ id: 'pp-nocost', costPrice: mockDecimal(0) })
    const ppNoSell = makeProviderPackage({ id: 'pp-nosell', sellingPrice: mockDecimal(0) })
    const ppNoCurrency = makeProviderPackage({ id: 'pp-nocurr', sellingCurrency: null })
    const ppNotConfigured = makeProviderPackage({ id: 'pp-noconf', configurationStatus: 'UNCONFIGURED' })
    const ppGood = makeProviderPackage({ id: 'pp-good' })

    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([
      ppNoCost, ppNoSell, ppNoCurrency, ppNotConfigured, ppGood,
    ] as any)
    vi.mocked(prisma.eSIMPackage.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.eSIMPackage.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        eSIMPackage: {
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'esim-good' }),
        },
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      await cb(tx)
    })

    const result = await publishToCatalog(['pp-nocost', 'pp-nosell', 'pp-nocurr', 'pp-noconf', 'pp-good'])

    expect(result.created).toBe(1)
    expect(result.skipped).toBe(4)
    expect(result.skippedDetails).toHaveLength(4)
    expect(result.skippedDetails!.find(s => s.packageId === 'pp-nocost')!.reason).toContain('costPrice')
    expect(result.skippedDetails!.find(s => s.packageId === 'pp-nosell')!.reason).toContain('sellingPrice')
    expect(result.skippedDetails!.find(s => s.packageId === 'pp-nocurr')!.reason).toContain('sellingCurrency')
    expect(result.skippedDetails!.find(s => s.packageId === 'pp-noconf')!.reason).toContain('not configured')
  })

  it('audit log created', async () => {
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)
    vi.mocked(prisma.eSIMPackage.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.eSIMPackage.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        eSIMPackage: {
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'esim-1' }),
        },
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      await cb(tx)
    })

    await publishToCatalog(['pp-1'])

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'admin-1',
        action: 'BULK_PUBLISH_TO_CATALOG',
        entity: 'ProviderPackage',
        details: 'Published 1 new, 0 updated, 0 skipped out of 1 selected',
      },
    })
  })

  it('revalidateCatalogRoutes called after operation', async () => {
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)
    vi.mocked(prisma.eSIMPackage.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.eSIMPackage.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        eSIMPackage: {
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'esim-1' }),
        },
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      await cb(tx)
    })

    await publishToCatalog(['pp-1'])

    expect(revalidateCatalogRoutes).toHaveBeenCalled()
  })

  it('pipeline stages recorded', async () => {
    const pp = makeProviderPackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pp] as any)
    vi.mocked(prisma.eSIMPackage.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.eSIMPackage.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        eSIMPackage: {
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'esim-1' }),
        },
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
      }
      await cb(tx)
    })

    await publishToCatalog(['pp-1'])

    expect(startPipelineRun).toHaveBeenCalledWith({ trigger: 'MANUAL', totalInput: 1 })
    expect(recordStageFromCounts).toHaveBeenCalled()
    expect(completePipelineRun).toHaveBeenCalled()
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'CATALOG_PUBLISHED' }))
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
