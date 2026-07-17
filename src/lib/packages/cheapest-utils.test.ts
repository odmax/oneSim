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
      create: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

const { recalculateCheapestPlans, computeEffectiveCost, buildComparableKey } = await import('./cheapest-utils')
const { prisma } = await import('@/lib/prisma')
const { getServerSession } = await import('next-auth')

function makeProviderPackage(overrides: Record<string, any> = {}): any {
  return {
    id: `pkg-${Math.random().toString(36).slice(2, 8)}`,
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
    effectiveCostPrice: null,
    costSource: null,
    comparableKey: null,
    normalizedCountry: null,
    normalizedDataLabel: null,
    normalizedValidityDays: null,
    normalizedCoverageType: null,
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
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    provider: { id: 'prov-1', status: 'ACTIVE', priority: 10, code: 'TEST' },
    publishedAs: null,
    ...overrides,
  }
}

describe('computeEffectiveCost', () => {
  it('uses admin override when available', () => {
    const result = computeEffectiveCost(1.00, 2.50)
    expect(result.effectiveCostPrice).toBe(2.50)
    expect(result.costSource).toBe('ADMIN_OVERRIDE')
  })

  it('uses provider cost when no admin override', () => {
    const result = computeEffectiveCost(1.50, null)
    expect(result.effectiveCostPrice).toBe(1.50)
    expect(result.costSource).toBe('PROVIDER')
  })

  it('returns missing when no cost available', () => {
    const result = computeEffectiveCost(0, null)
    expect(result.effectiveCostPrice).toBeNull()
    expect(result.costSource).toBe('MISSING')
  })
})

describe('buildComparableKey', () => {
  it('builds local key for country-based plan', () => {
    const key = buildComparableKey({ country: 'NG', region: null, planType: null, dataGB: 5, validityDays: 30 })
    expect(key).toBe('local:NG:5GB:30')
  })

  it('builds global key for global plan', () => {
    const key = buildComparableKey({ country: 'GLOBAL', region: null, planType: null, dataGB: 10, validityDays: 7 })
    expect(key).toBe('global:GLOBAL:10GB:7')
  })

  it('normalizes data to 5GB buckets', () => {
    const key = buildComparableKey({ country: 'NG', region: null, planType: null, dataGB: 12, validityDays: 30 })
    expect(key).toContain('10GB')
  })

  it('normalizes validity to 30 days', () => {
    const key = buildComparableKey({ country: 'NG', region: null, planType: null, dataGB: 5, validityDays: 45 })
    expect(key).toContain(':30')
  })
})

describe('recalculateCheapestPlans', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'admin-1', role: 'INTERNAL_ADMIN', email: 'admin@test.com' },
    } as any)
  })

  it('marks solo eligible plan as cheapestCandidate rank 1', async () => {
    const pkg = makeProviderPackage({
      id: 'solo-1',
      costPrice: 3.00,
      country: 'NG', dataGB: 5, validityDays: 30,
    })
    // First call returns the package, second call (for step 2 update) is fine
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pkg])

    // We need to make the update calls succeed
    vi.mocked(prisma.providerPackage.update).mockResolvedValue(pkg as any)

    const result = await recalculateCheapestPlans()
    expect(result.groupsProcessed).toBe(1)
    expect(result.winners).toBe(1)
    expect(result.soloWinners).toBe(1)

    // Verify the solo plan got rank 1 and isCheapestCandidate = true
    const updateCalls = vi.mocked(prisma.providerPackage.update).mock.calls
    const rankCall = updateCalls.find(c =>
      c[0].where?.id === 'solo-1' &&
      c[0].data?.cheapestRank === 1 &&
      c[0].data?.isCheapestCandidate === true
    )
    expect(rankCall).toBeTruthy()
  })

  it('picks cheaper plan when two equivalent plans exist', async () => {
    const cheap = makeProviderPackage({
      id: 'cheap-1',
      costPrice: 2.00,
      country: 'NG', dataGB: 5, validityDays: 30,
    })
    const expensive = makeProviderPackage({
      id: 'expensive-1',
      costPrice: 4.00,
      country: 'NG', dataGB: 5, validityDays: 30,
    })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([cheap, expensive])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue(cheap as any)

    const result = await recalculateCheapestPlans()
    expect(result.groupsProcessed).toBe(1)
    expect(result.winners).toBe(1)

    // The cheaper plan should be ranked 1
    const rank1Calls = vi.mocked(prisma.providerPackage.update).mock.calls.filter(c =>
      c[0].data?.cheapestRank === 1
    )
    expect(rank1Calls.length).toBeGreaterThanOrEqual(1)
    expect(rank1Calls[0][0].where?.id).toBe('cheap-1')
  })

  it('skips ineligible plan and shows reason', async () => {
    const excluded = makeProviderPackage({
      id: 'excluded-1',
      excludedFromCheapest: true,
      costPrice: 2.00,
      country: 'NG', dataGB: 5, validityDays: 30,
    })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([excluded])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue(excluded as any)

    const result = await recalculateCheapestPlans()
    expect(result.excluded).toBe(0) // excludedFromCheapest doesn't count towards "excluded" counter
    expect(result.groupsProcessed).toBe(0) // no eligible packages

    // Verify the exclusion reason was recorded
    const updateCalls = vi.mocked(prisma.providerPackage.update).mock.calls
    const exclusionCall = updateCalls.find(c =>
      c[0].where?.id === 'excluded-1' &&
      c[0].data?.cheapestReason === 'Excluded by admin'
    )
    expect(exclusionCall).toBeTruthy()
  })

  it('is idempotent when called twice', async () => {
    const pkg1 = makeProviderPackage({
      id: 'idem-1',
      costPrice: 2.50,
      country: 'NG', dataGB: 5, validityDays: 30,
    })
    const pkg2 = makeProviderPackage({
      id: 'idem-2',
      costPrice: 3.00,
      country: 'NG', dataGB: 5, validityDays: 30,
    })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pkg1, pkg2])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue(pkg1 as any)

    // First call
    await recalculateCheapestPlans()
    const firstUpdateCalls = vi.mocked(prisma.providerPackage.update).mock.calls.length

    // Second call (same data)
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'admin-1', role: 'INTERNAL_ADMIN' },
    } as any)
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([
      { ...pkg1, cheapestRank: 1, isCheapestCandidate: true } as any,
      { ...pkg2, cheapestRank: 2, isCheapestCandidate: false } as any,
    ])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue(pkg1 as any)

    await recalculateCheapestPlans()
    const secondUpdateCalls = vi.mocked(prisma.providerPackage.update).mock.calls
    const rank1Second = secondUpdateCalls.filter(c => c[0].data?.cheapestRank === 1)
    expect(rank1Second.length).toBeGreaterThanOrEqual(1)
    expect(rank1Second[0][0].where?.id).toBe('idem-1')
  })

  it('handles mixed eligible and ineligible in same group', async () => {
    const eligible = makeProviderPackage({
      id: 'eligible-1',
      costPrice: 3.00,
      country: 'NG', dataGB: 5, validityDays: 30,
    })
    const missingCost = makeProviderPackage({
      id: 'missing-cost-1',
      costPrice: 0,
      country: 'NG', dataGB: 5, validityDays: 30,
    })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([eligible, missingCost])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue(eligible as any)

    const result = await recalculateCheapestPlans()
    expect(result.groupsProcessed).toBe(1) // group has at least 1 eligible
    expect(result.winners).toBe(1)
    expect(result.missingCost).toBe(1)
  })
})
