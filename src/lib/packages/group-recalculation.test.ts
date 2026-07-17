import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma before any imports
vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    eSIMPackage: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    catalogPipelineRun: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
    catalogPipelineStage: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
  default: vi.fn(),
}))

vi.mock('@/lib/auth/config', () => ({
  authOptions: {},
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/catalog-pipeline', () => ({
  startPipelineRun: vi.fn().mockResolvedValue('pipeline-group-1'),
  recordStageFromCounts: vi.fn(),
  completePipelineRun: vi.fn(),
  failPipelineRun: vi.fn(),
  recordPipelineStage: vi.fn(),
}))

import { getServerSession } from 'next-auth'
import { prisma } from '@/lib/prisma'
import { recalculateComparableGroup, reconcileComparableGroup, recalculateCheapestPlans } from './cheapest-utils'

function makePP(overrides: Record<string, any> = {}): any {
  return {
    id: `pp-${Math.random().toString(36).slice(2, 8)}`,
    providerId: 'prov-1',
    providerPlanId: 'plan-1',
    name: 'Test Plan',
    dataGB: 5,
    validityDays: 30,
    costPrice: 2.00,
    currency: 'USD',
    country: 'NG',
    region: null,
    planType: null,
    isAvailable: true,
    adminCostPrice: null,
    effectiveCostPrice: 2.00,
    costSource: 'PROVIDER',
    comparableKey: 'local:NG:5GB:30',
    normalizedCountry: 'NG',
    normalizedDataLabel: '5GB',
    normalizedValidityDays: 30,
    normalizedCoverageType: 'local',
    cheapestRank: null,
    isCheapestCandidate: false,
    cheapestReason: null,
    excludedFromCheapest: false,
    exclusionReason: null,
    publishStatus: 'READY',
    configurationStatus: 'CONFIGURED',
    sellingPrice: 5.00,
    sellingCurrency: 'USD',
    markupPercent: null,
    readyToPublish: false,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    provider: { id: 'prov-1', status: 'ACTIVE', priority: 10, code: 'TEST' },
    publishedAs: null,
    ...overrides,
  }
}

describe('recalculateComparableGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'admin-1', role: 'INTERNAL_ADMIN', email: 'admin@test.com' },
    } as any)
    vi.mocked(prisma.catalogPipelineRun.create).mockResolvedValue({ id: 'pipeline-group-1' } as any)
    vi.mocked(prisma.catalogPipelineRun.findUnique).mockResolvedValue({ id: 'pipeline-group-1', startedAt: new Date() } as any)
    vi.mocked(prisma.catalogPipelineRun.update).mockResolvedValue({} as any)
    vi.mocked(prisma.catalogPipelineStage.create).mockResolvedValue({} as any)
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
  })

  it('recalculates a single comparable group', async () => {
    const pkg = makePP({ id: 'single-pkg', costPrice: 3.00, effectiveCostPrice: 3.00 })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pkg])

    const result = await recalculateComparableGroup('local:NG:5GB:30')

    expect(result.groupsProcessed).toBe(1)
    expect(result.winners).toBe(1)
    expect(result.alternatives).toBe(0)
    expect(result.soloWinners).toBe(1)
    // Should have called findMany with the correct comparableKey
    expect(prisma.providerPackage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ comparableKey: 'local:NG:5GB:30' }),
      }),
    )
  })

  it('does not affect unrelated groups', async () => {
    // Group A: 2 packages (1 eligible → winner, 1 cheap)
    const pkgA1 = makePP({ id: 'a-1', costPrice: 3.00, effectiveCostPrice: 3.00, comparableKey: 'local:NG:5GB:30' })
    const pkgA2 = makePP({ id: 'a-2', costPrice: 2.50, effectiveCostPrice: 2.50, comparableKey: 'local:NG:5GB:30' })

    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pkgA1, pkgA2])
    const resultA = await recalculateComparableGroup('local:NG:5GB:30')

    expect(resultA.groupsProcessed).toBe(1)
    expect(resultA.winners).toBe(1) // a-2 is cheapest at 2.50
    expect(resultA.alternatives).toBe(1) // a-1 is alternative

    // Group B should not have been queried
    vi.mocked(prisma.providerPackage.findMany).mockClear()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makePP({ id: 'b-1', comparableKey: 'local:MW:2GB:7' })])
    const resultB = await recalculateComparableGroup('local:MW:2GB:7')

    expect(resultB.groupsProcessed).toBe(1)
    // Verify A's packages were not touched by checking that findMany was only called for group B
    const findManyCalls = vi.mocked(prisma.providerPackage.findMany).mock.calls
    expect(findManyCalls.length).toBe(1)
    expect(findManyCalls[0]?.[0]?.where?.comparableKey).toBe('local:MW:2GB:7')
  })

  it('handles empty group gracefully', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([])

    const result = await recalculateComparableGroup('local:XX:0GB:0')

    expect(result.groupsProcessed).toBe(0)
    expect(result.winners).toBe(0)
    expect(result.alternatives).toBe(0)
  })

  it('rejects unauthorized user', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null)

    await expect(recalculateComparableGroup('local:NG:5GB:30')).rejects.toThrow('Unauthorized')
  })
})

describe('reconcileComparableGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'admin-1', role: 'INTERNAL_ADMIN', email: 'admin@test.com' },
    } as any)
    vi.mocked(prisma.catalogPipelineRun.create).mockResolvedValue({ id: 'pipeline-reconcile-1' } as any)
    vi.mocked(prisma.catalogPipelineRun.findUnique).mockResolvedValue({ id: 'pipeline-reconcile-1', startedAt: new Date() } as any)
    vi.mocked(prisma.catalogPipelineRun.update).mockResolvedValue({} as any)
    vi.mocked(prisma.catalogPipelineStage.create).mockResolvedValue({} as any)
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
  })

  it('reconciles from fresh DB read', async () => {
    const pkg = makePP({ id: 'reconcile-pkg', costPrice: 3.50, effectiveCostPrice: 3.50 })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pkg])

    const result = await reconcileComparableGroup('local:NG:5GB:30')

    expect(result.groupsProcessed).toBe(1)
    expect(result.winners).toBe(1)
    expect(prisma.providerPackage.findMany).toHaveBeenCalled()
  })
})

describe('full recalculation still works', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'admin-1', role: 'INTERNAL_ADMIN', email: 'admin@test.com' },
    } as any)
    vi.mocked(prisma.catalogPipelineRun.create).mockResolvedValue({ id: 'pipeline-full-1' } as any)
    vi.mocked(prisma.catalogPipelineRun.findUnique).mockResolvedValue({ id: 'pipeline-full-1', startedAt: new Date() } as any)
    vi.mocked(prisma.catalogPipelineRun.update).mockResolvedValue({} as any)
    vi.mocked(prisma.catalogPipelineStage.create).mockResolvedValue({} as any)
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
  })

  it('recalculateCheapestPlans processes all groups', async () => {
    const pkg1 = makePP({ id: 'full-1', costPrice: 3.00, effectiveCostPrice: 3.00, country: 'NG', dataGB: 5, validityDays: 30 })
    const pkg2 = makePP({ id: 'full-2', costPrice: 4.00, effectiveCostPrice: 4.00, country: 'KE', dataGB: 10, validityDays: 7 })

    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pkg1, pkg2])

    const result = await recalculateCheapestPlans()

    expect(result.groupsProcessed).toBe(2)
    expect(result.winners).toBe(2)
    expect(result.soloWinners).toBe(2)
  })
})
