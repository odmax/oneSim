import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prisma } from '@/lib/prisma'

const { mockPublishProviderPackageToRetailCatalog } = vi.hoisted(() => ({
  mockPublishProviderPackageToRetailCatalog: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
}))

vi.mock('@/lib/services/catalog/publish-to-retail', () => ({
  publishProviderPackageToRetailCatalog: mockPublishProviderPackageToRetailCatalog,
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

vi.mock('@/lib/catalog-pipeline', () => ({
  startPipelineRun: vi.fn().mockResolvedValue('pipeline-run-1'),
  recordStageFromCounts: vi.fn(),
  completePipelineRun: vi.fn(),
  failPipelineRun: vi.fn(),
}))

vi.mock('@/lib/services/catalog-price-sync', () => ({
  syncProviderPackageToPublishedProducts: vi.fn(),
  revalidateCatalogRoutes: vi.fn(),
  recordCatalogPriceSyncAudit: vi.fn(),
}))

import { getServerSession } from 'next-auth'
import { bulkConfigurePackages } from './bulk-configure'
import { startPipelineRun, recordStageFromCounts, completePipelineRun, failPipelineRun } from '@/lib/catalog-pipeline'
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
    sellingPrice: 5.0,
    sellingCurrency: 'USD',
    markupPercent: 150,
    providerPlanId: 'plan-1',
    providerId: 'prov-1',
    publishStatus: 'DRAFT',
    configurationStatus: 'CONFIGURED',
    ...overrides,
  }
}

describe('bulkConfigurePackages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue(makeSession() as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeBeforePackage()])
  })

  it('returns Unauthorized when no session', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null)
    const result = await bulkConfigurePackages({ packageIds: ['pkg-1'], sellingPrice: 10 })
    expect(result).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('returns Unauthorized when role is not INTERNAL_ADMIN', async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'user-1', role: 'USER' } } as any)
    const result = await bulkConfigurePackages({ packageIds: ['pkg-1'], sellingPrice: 10 })
    expect(result).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('returns error when packageIds is empty', async () => {
    const result = await bulkConfigurePackages({ packageIds: [] })
    expect(result).toEqual({ success: false, error: 'No packages selected' })
  })

  it('returns error when packageIds is undefined', async () => {
    const result = await bulkConfigurePackages({} as any)
    expect(result).toEqual({ success: false, error: 'No packages selected' })
  })

  it('returns error when publishStatus is READY but sellingPrice is missing', async () => {
    const result = await bulkConfigurePackages({ packageIds: ['pkg-1'], publishStatus: 'READY' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('sellingPrice must be > 0 when publishStatus is READY')
    expect(result.error).toContain('sellingCurrency is required when publishStatus is READY')
    expect(result.error).toContain('costPrice must be > 0 when publishStatus is READY')
  })

  it('defaults configurationStatus to CONFIGURED when publishStatus is READY and not provided', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 1 })

    const result = await bulkConfigurePackages({
      packageIds: ['pkg-1'],
      sellingPrice: 10,
      sellingCurrency: 'USD',
      costPrice: 3,
      publishStatus: 'READY',
    })

    expect(result.success).toBe(true)
    expect(vi.mocked(prisma.providerPackage.updateMany).mock.calls[0][0].data.configurationStatus).toBe('CONFIGURED')
    expect(vi.mocked(prisma.providerPackage.updateMany).mock.calls[0][0].data.lastConfiguredAt).toBeInstanceOf(Date)
  })

  it('successfully configures packages and syncs linked products', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeBeforePackage({ id: 'pkg-1' }), makeBeforePackage({ id: 'pkg-2' })])
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 2 })

    const result = await bulkConfigurePackages({
      packageIds: ['pkg-1', 'pkg-2'],
      sellingPrice: 10,
      sellingCurrency: 'USD',
      costPrice: 3,
      markupPercent: 233,
      pricingMode: 'MARKUP_PERCENT',
      publishStatus: 'READY',
      tags: ['premium'],
      notes: 'Bulk update',
    })

    expect(result).toEqual({ success: true, updated: 2 })
    expect(vi.mocked(prisma.providerPackage.updateMany)).toHaveBeenCalledWith({
      where: { id: { in: ['pkg-1', 'pkg-2'] } },
      data: expect.objectContaining({
        sellingPrice: 10,
        sellingCurrency: 'USD',
        costPrice: 3,
        markupPercent: 233,
        pricingMode: 'MARKUP_PERCENT',
        publishStatus: 'READY',
        tags: ['premium'],
        notes: 'Bulk update',
      }),
    })
    expect(vi.mocked(syncProviderPackageToPublishedProducts)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(revalidateCatalogRoutes)).toHaveBeenCalledTimes(1)
  })

  it('captures before-values and uses them for sync', async () => {
    const beforePkg = makeBeforePackage({ id: 'pkg-1', name: 'Plan A', sellingPrice: 5, sellingCurrency: 'USD', markupPercent: 150, publishStatus: 'DRAFT' })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([beforePkg])
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 1 })

    await bulkConfigurePackages({ packageIds: ['pkg-1'], sellingPrice: 12, sellingCurrency: 'EUR', markupPercent: 200 })

    expect(vi.mocked(syncProviderPackageToPublishedProducts)).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        id: 'pkg-1',
        name: 'Plan A',
        sellingPrice: 12,
        sellingCurrency: 'EUR',
        markupPercent: 200,
        publishStatus: 'DRAFT',
      }),
    )
  })

  it('returns structured error when transaction fails', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('Transaction failed'))
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeBeforePackage()])

    const result = await bulkConfigurePackages({ packageIds: ['pkg-1'], sellingPrice: 10 })

    expect(result).toEqual({ success: false, error: 'Transaction failed' })
  })

  it('calls revalidateCatalogRoutes once after success', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 1 })

    await bulkConfigurePackages({ packageIds: ['pkg-1'], sellingPrice: 10, sellingCurrency: 'USD', costPrice: 3 })

    expect(vi.mocked(revalidateCatalogRoutes)).toHaveBeenCalledTimes(1)
  })

  it('records pipeline stages correctly', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 1 })

    await bulkConfigurePackages({ packageIds: ['pkg-1'], sellingPrice: 10, sellingCurrency: 'USD', costPrice: 3 })

    expect(vi.mocked(startPipelineRun)).toHaveBeenCalledWith({ trigger: 'MANUAL', totalInput: 1 })
    expect(vi.mocked(recordStageFromCounts)).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'CONFIGURATION', total: 1, passed: 1, failed: 0, skipped: 0 }),
    )
    expect(vi.mocked(completePipelineRun)).toHaveBeenCalledWith('pipeline-run-1', 'SUCCESS', 1)
  })

  it('records READY_FOR_PUBLISH stage when publishStatus is READY', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 1 })

    await bulkConfigurePackages({
      packageIds: ['pkg-1'],
      sellingPrice: 10,
      sellingCurrency: 'USD',
      costPrice: 3,
      publishStatus: 'READY',
      configurationStatus: 'CONFIGURED',
    })

    expect(vi.mocked(recordStageFromCounts)).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'READY_FOR_PUBLISH', total: 1, passed: 1 }),
    )
  })

  it('records failed stage and fails pipeline on error', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('DB error'))
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeBeforePackage()])

    await bulkConfigurePackages({ packageIds: ['pkg-1'], sellingPrice: 10 })

    expect(vi.mocked(recordStageFromCounts)).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'CONFIGURATION', statusOverride: 'FAILED', metadata: { error: 'DB error' } }),
    )
    expect(vi.mocked(failPipelineRun)).toHaveBeenCalledWith('pipeline-run-1', 'DB error')
  })

  it('creates audit log after success', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 2 })

    await bulkConfigurePackages({ packageIds: ['pkg-1', 'pkg-2'], sellingPrice: 10, sellingCurrency: 'USD', costPrice: 3 })

    expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalledWith({
      data: {
        userId: 'admin-1',
        action: 'BULK_CONFIGURE_PACKAGES',
        entity: 'ProviderPackage',
        details: expect.stringContaining('Bulk configured 2 packages:'),
      },
    })
  })

  it('bulk Configure uses the same canonical calculation: cost + markup → selling', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeBeforePackage({ id: 'pkg-1', costPrice: 7, sellingPrice: null, markupPercent: null })])
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)

    const result = await bulkConfigurePackages({ packageIds: ['pkg-1'], costPrice: 7, markupPercent: 9.89 })

    expect(result.success).toBe(true)
    // 7 * (1 + 0.0989) = 7.6923 → roundMoney → 7.69 — selling is never left null.
    const perPkgUpdate = vi.mocked(prisma.providerPackage.update).mock.calls[0]?.[0] as any
    expect(perPkgUpdate).toBeDefined()
    expect(perPkgUpdate.data.sellingPrice).toBe(7.69)
  })

  it('bulk Configure derives markup from cost + selling (no markup supplied)', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeBeforePackage({ id: 'pkg-1', costPrice: 7, sellingPrice: null, markupPercent: null })])
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)

    const result = await bulkConfigurePackages({ packageIds: ['pkg-1'], costPrice: 7, sellingPrice: 8 })

    expect(result.success).toBe(true)
    const perPkgUpdate = vi.mocked(prisma.providerPackage.update).mock.calls[0]?.[0] as any
    expect(perPkgUpdate).toBeDefined()
    expect(perPkgUpdate.data.markupPercent).toBe(14.29) // ((8-7)/7)*100 → 14.29
  })

  it('PUBLISHED intent routes each package through the canonical gate, never writes PUBLISHED directly', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeBeforePackage({ id: 'pkg-1' }), makeBeforePackage({ id: 'pkg-2' })])
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 2 })
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, publishStatusSet: true, readinessReasons: [] })

    const result = await bulkConfigurePackages({ packageIds: ['pkg-1', 'pkg-2'], sellingPrice: 10, sellingCurrency: 'USD', costPrice: 3, publishStatus: 'PUBLISHED' })

    expect(result).toEqual({ success: true, updated: 2, published: 2, publishBlocked: 0, blockedDetails: undefined })
    // PUBLISHED never persisted by updateMany.
    expect(vi.mocked(prisma.providerPackage.updateMany).mock.calls[0][0].data.publishStatus).toBeUndefined()
    // Canonical gate invoked per package.
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledTimes(2)
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledWith('pkg-1', expect.objectContaining({ reason: 'BULK_CONFIGURE_PUBLISH' }))
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledWith('pkg-2', expect.objectContaining({ reason: 'BULK_CONFIGURE_PUBLISH' }))
  })

  it('PUBLISHED-only intent (no pricing edits) still routes through the canonical gate', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeBeforePackage({ id: 'pkg-1' })])
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, publishStatusSet: true, readinessReasons: [] })

    const result = await bulkConfigurePackages({ packageIds: ['pkg-1'], publishStatus: 'PUBLISHED' })

    expect(result.success).toBe(true)
    expect(result.published).toBe(1)
    expect(vi.mocked(prisma.providerPackage.updateMany)).not.toHaveBeenCalled()
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledTimes(1)
  })

  it('PUBLISHED blocked by readiness → PARTIAL, reports exact reasons, never forces PUBLISHED', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makeBeforePackage({ id: 'pkg-1' }), makeBeforePackage({ id: 'pkg-2' })])
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 2 })
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    mockPublishProviderPackageToRetailCatalog
      .mockResolvedValueOnce({ success: true, publishStatusSet: true, readinessReasons: [] })
      .mockResolvedValueOnce({ success: false, publishStatusSet: false, readinessReasons: ['Cost status is MISSING', 'No active price snapshot'], error: 'Finalization failed' })

    const result = await bulkConfigurePackages({ packageIds: ['pkg-1', 'pkg-2'], sellingPrice: 10, sellingCurrency: 'USD', costPrice: 3, publishStatus: 'PUBLISHED' })

    expect(result.success).toBe(true)
    expect(result.published).toBe(1)
    expect(result.publishBlocked).toBe(1)
    expect(result.blockedDetails).toEqual([{ packageId: 'pkg-2', name: 'Test Plan', reasons: ['Cost status is MISSING', 'No active price snapshot'] }])
    expect(vi.mocked(completePipelineRun)).toHaveBeenCalledWith('pipeline-run-1', 'PARTIAL', 1)
    // Blocked package still never receives PUBLISHED.
    expect(vi.mocked(prisma.providerPackage.updateMany).mock.calls[0][0].data.publishStatus).toBeUndefined()
  })

  it('bulk PUBLISHED: UNCONFIGURED packages are blocked by eligibility and never reach the canonical gate', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([
      makeBeforePackage({ id: 'pkg-1' }),
      makeBeforePackage({ id: 'pkg-2', configurationStatus: 'UNCONFIGURED' }),
    ])
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 2 })
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, publishStatusSet: true, readinessReasons: [] })

    const result = await bulkConfigurePackages({ packageIds: ['pkg-1', 'pkg-2'], sellingPrice: 10, sellingCurrency: 'USD', costPrice: 3, publishStatus: 'PUBLISHED' })

    expect(result.success).toBe(true)
    expect(result.published).toBe(1)
    expect(result.publishBlocked).toBe(1)
    expect(result.blockedDetails).toEqual([{ packageId: 'pkg-2', name: 'Test Plan', reasons: ['configurationStatus is UNCONFIGURED (never eligible to publish)'] }])
    // Only the eligible package reached the canonical gate.
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledTimes(1)
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledWith('pkg-1', expect.objectContaining({ reason: 'BULK_CONFIGURE_PUBLISH' }))
  })

  it('bulk PUBLISHED: HIDDEN and ARCHIVED packages are blocked even when CONFIGURED', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([
      makeBeforePackage({ id: 'pkg-1', publishStatus: 'HIDDEN', configurationStatus: 'CONFIGURED' }),
      makeBeforePackage({ id: 'pkg-2', publishStatus: 'ARCHIVED', configurationStatus: 'CONFIGURED' }),
    ])
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 2 })
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)

    const result = await bulkConfigurePackages({ packageIds: ['pkg-1', 'pkg-2'], sellingPrice: 10, sellingCurrency: 'USD', costPrice: 3, publishStatus: 'PUBLISHED' })

    expect(result.success).toBe(true)
    expect(result.published).toBe(0)
    expect(result.publishBlocked).toBe(2)
    expect(result.blockedDetails![0].reasons).toEqual(['publishStatus is HIDDEN (restore/unarchive before publishing)'])
    expect(result.blockedDetails![1].reasons).toEqual(['publishStatus is ARCHIVED (restore/unarchive before publishing)'])
    expect(mockPublishProviderPackageToRetailCatalog).not.toHaveBeenCalled()
  })

  it('bulk PUBLISHED: READY packages are eligible (source-state transition allowed)', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([
      makeBeforePackage({ id: 'pkg-1', publishStatus: 'READY', configurationStatus: 'CONFIGURED' }),
    ])
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, publishStatusSet: true, readinessReasons: [] })

    const result = await bulkConfigurePackages({ packageIds: ['pkg-1'], sellingPrice: 10, sellingCurrency: 'USD', costPrice: 3, publishStatus: 'PUBLISHED' })

    expect(result.success).toBe(true)
    expect(result.published).toBe(1)
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledTimes(1)
  })

  it('bulk PUBLISHED: eligibility is provider-neutral (CHOICE, AIRHUB, iBASIS identical)', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([
      makeBeforePackage({ id: 'pkg-1', providerId: 'prov-choice' }),
      makeBeforePackage({ id: 'pkg-2', providerId: 'prov-airhub' }),
      makeBeforePackage({ id: 'pkg-3', providerId: 'prov-ibasis' }),
      makeBeforePackage({ id: 'pkg-4', providerId: 'prov-choice', configurationStatus: 'UNCONFIGURED' }),
    ])
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      await fn(prisma)
      return undefined
    })
    vi.mocked(prisma.providerPackage.updateMany).mockResolvedValue({ count: 4 })
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, publishStatusSet: true, readinessReasons: [] })

    const result = await bulkConfigurePackages({ packageIds: ['pkg-1', 'pkg-2', 'pkg-3', 'pkg-4'], sellingPrice: 10, sellingCurrency: 'USD', costPrice: 3, publishStatus: 'PUBLISHED' })

    expect(result.success).toBe(true)
    expect(result.published).toBe(3)
    expect(result.publishBlocked).toBe(1)
    expect(result.blockedDetails).toEqual([{ packageId: 'pkg-4', name: 'Test Plan', reasons: ['configurationStatus is UNCONFIGURED (never eligible to publish)'] }])
    // All three providers passed the identical eligibility rule.
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledTimes(3)
  })
})
