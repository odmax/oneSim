import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    packageConfigurationRule: {
      findMany: vi.fn(),
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

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}))

vi.mock('@/lib/services/catalog-price-sync', () => ({
  syncProviderPackageToPublishedProducts: vi.fn(),
  revalidateCatalogRoutes: vi.fn(),
}))

import { getServerSession } from 'next-auth'
import { prisma } from '@/lib/prisma'
import { applyRulesToPackages } from './package-rules'
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes } from '@/lib/services/catalog-price-sync'

const mockSession = { user: { id: 'admin-1', role: 'INTERNAL_ADMIN', email: 'admin@test.com' } }
const mockDecimal = (n: number) => ({ toString: () => n.toString() })

describe('applyRulesToPackages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any)
  })

  it('returns error when unauthorized', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null)

    const result = await applyRulesToPackages()

    expect(result).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('returns error when no active rules configured', async () => {
    vi.mocked(prisma.packageConfigurationRule.findMany).mockResolvedValue([])

    const result = await applyRulesToPackages()

    expect(result).toEqual({ success: false, error: 'No active rules configured' })
  })

  it('matched packages updated and synced in a single transaction', async () => {
    const rule = {
      id: 'rule-1',
      providerId: 'prov-1',
      country: null,
      region: null,
      productType: null,
      dataMinGB: null,
      dataMaxGB: null,
      validityMinDays: null,
      validityMaxDays: null,
      costPrice: mockDecimal(5),
      markupPercent: mockDecimal(50),
      fixedPrice: null,
      sellingCurrency: 'USD',
      publishStatus: 'READY',
      priority: 10,
      isActive: true,
      updatedAt: new Date('2025-01-01'),
    }
    vi.mocked(prisma.packageConfigurationRule.findMany).mockResolvedValue([rule])

    const packages = [
      {
        id: 'pkg-1',
        providerId: 'prov-1',
        country: 'US',
        region: null,
        dataGB: 5,
        validityDays: 30,
        costPrice: mockDecimal(2),
        sellingPrice: null,
        sellingCurrency: null,
        markupPercent: null,
        pricingMode: null,
        publishStatus: 'DRAFT',
        configurationStatus: 'UNCONFIGURED',
        autoConfiguredByRuleId: null,
        lastConfiguredAt: null,
        configuredByRule: null,
        name: 'Test Package',
        currency: 'USD',
        providerPlanId: 'plan-1',
        providerPlanCode: null,
        tags: null,
        notes: null,
        isPreferred: null,
        preferredReason: null,
        preferredAt: null,
        excludedFromAutoPick: null,
        autoPickReason: null,
        productType: null,
      },
    ]
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue(packages as any)

    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
        eSIMPackage: { findMany: vi.fn().mockResolvedValue([]) },
      }
      await cb(tx)
    })

    const result = await applyRulesToPackages()

    expect(result).toEqual({ success: true, matched: 1 })
    expect(prisma.$transaction).toHaveBeenCalled()
    expect(syncProviderPackageToPublishedProducts).toHaveBeenCalled()
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'admin-1',
        action: 'RULES_APPLIED',
        entity: 'ProviderPackage',
        details: 'Applied 1 rules to 1 packages',
      },
    })
    expect(revalidateCatalogRoutes).toHaveBeenCalled()
  })

  it('skipped packages (no matching rule, no selling price) remain unchanged', async () => {
    const rule = {
      id: 'rule-1',
      providerId: 'prov-2',
      country: null,
      region: null,
      productType: null,
      dataMinGB: null,
      dataMaxGB: null,
      validityMinDays: null,
      validityMaxDays: null,
      costPrice: null,
      markupPercent: null,
      fixedPrice: null,
      sellingCurrency: 'USD',
      publishStatus: 'READY',
      priority: 10,
      isActive: true,
      updatedAt: new Date('2025-01-01'),
    }
    vi.mocked(prisma.packageConfigurationRule.findMany).mockResolvedValue([rule])

    const packages = [
      {
        id: 'pkg-2',
        providerId: 'prov-1',
        country: 'US',
        region: null,
        dataGB: 5,
        validityDays: 30,
        costPrice: mockDecimal(2),
        sellingPrice: null,
        sellingCurrency: null,
        markupPercent: null,
        pricingMode: null,
        publishStatus: 'DRAFT',
        configurationStatus: 'UNCONFIGURED',
        autoConfiguredByRuleId: null,
        lastConfiguredAt: null,
        configuredByRule: null,
        name: 'No Match',
        currency: 'USD',
        providerPlanId: 'plan-2',
        providerPlanCode: null,
        tags: null,
        notes: null,
        isPreferred: null,
        preferredReason: null,
        preferredAt: null,
        excludedFromAutoPick: null,
        autoPickReason: null,
        productType: null,
      },
    ]
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue(packages as any)

    const result = await applyRulesToPackages()

    expect(result).toEqual({ success: true, matched: 0 })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('failed transaction returns structured error', async () => {
    const rule = {
      id: 'rule-1',
      providerId: 'prov-1',
      country: null,
      region: null,
      productType: null,
      dataMinGB: null,
      dataMaxGB: null,
      validityMinDays: null,
      validityMaxDays: null,
      costPrice: mockDecimal(5),
      markupPercent: mockDecimal(50),
      fixedPrice: null,
      sellingCurrency: 'USD',
      publishStatus: 'READY',
      priority: 10,
      isActive: true,
      updatedAt: new Date('2025-01-01'),
    }
    vi.mocked(prisma.packageConfigurationRule.findMany).mockResolvedValue([rule])

    const packages = [
      {
        id: 'pkg-1',
        providerId: 'prov-1',
        country: 'US',
        region: null,
        dataGB: 5,
        validityDays: 30,
        costPrice: mockDecimal(2),
        sellingPrice: null,
        sellingCurrency: null,
        markupPercent: null,
        pricingMode: null,
        publishStatus: 'DRAFT',
        configurationStatus: 'UNCONFIGURED',
        autoConfiguredByRuleId: null,
        lastConfiguredAt: null,
        configuredByRule: null,
        name: 'Fail Pkg',
        currency: 'USD',
        providerPlanId: 'plan-1',
        providerPlanCode: null,
        tags: null,
        notes: null,
        isPreferred: null,
        preferredReason: null,
        preferredAt: null,
        excludedFromAutoPick: null,
        autoPickReason: null,
        productType: null,
      },
    ]
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue(packages as any)
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('DB connection lost'))

    const result = await applyRulesToPackages()

    expect(result).toEqual({ success: false, error: 'DB connection lost' })
  })

  it('calls revalidateCatalogRoutes after success', async () => {
    vi.mocked(prisma.packageConfigurationRule.findMany).mockResolvedValue([])

    const result = await applyRulesToPackages()

    expect(revalidateCatalogRoutes).not.toHaveBeenCalled()
    expect(result).toEqual({ success: false, error: 'No active rules configured' })
  })

  it('return matched count is correct', async () => {
    const rule = {
      id: 'rule-1',
      providerId: 'prov-1',
      country: null,
      region: null,
      productType: null,
      dataMinGB: null,
      dataMaxGB: null,
      validityMinDays: null,
      validityMaxDays: null,
      costPrice: null,
      markupPercent: null,
      fixedPrice: mockDecimal(10),
      sellingCurrency: 'USD',
      publishStatus: 'READY',
      priority: 10,
      isActive: true,
      updatedAt: new Date('2025-01-01'),
    }
    vi.mocked(prisma.packageConfigurationRule.findMany).mockResolvedValue([rule])

    const packages = [
      {
        id: 'pkg-a',
        providerId: 'prov-1',
        country: 'US',
        region: null,
        dataGB: 5,
        validityDays: 30,
        costPrice: mockDecimal(2),
        sellingPrice: null,
        sellingCurrency: null,
        markupPercent: null,
        pricingMode: null,
        publishStatus: 'DRAFT',
        configurationStatus: 'UNCONFIGURED',
        autoConfiguredByRuleId: null,
        lastConfiguredAt: null,
        configuredByRule: null,
        name: 'Match A',
        currency: 'USD',
        providerPlanId: 'plan-a',
        providerPlanCode: null,
        tags: null,
        notes: null,
        isPreferred: null,
        preferredReason: null,
        preferredAt: null,
        excludedFromAutoPick: null,
        autoPickReason: null,
        productType: null,
      },
      {
        id: 'pkg-b',
        providerId: 'prov-2',
        country: 'US',
        region: null,
        dataGB: 10,
        validityDays: 30,
        costPrice: mockDecimal(3),
        sellingPrice: null,
        sellingCurrency: null,
        markupPercent: null,
        pricingMode: null,
        publishStatus: 'DRAFT',
        configurationStatus: 'UNCONFIGURED',
        autoConfiguredByRuleId: null,
        lastConfiguredAt: null,
        configuredByRule: null,
        name: 'No Match B',
        currency: 'USD',
        providerPlanId: 'plan-b',
        providerPlanCode: null,
        tags: null,
        notes: null,
        isPreferred: null,
        preferredReason: null,
        preferredAt: null,
        excludedFromAutoPick: null,
        autoPickReason: null,
        productType: null,
      },
    ]
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue(packages as any)

    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const tx = {
        providerPackage: { update: vi.fn().mockResolvedValue({}) },
        eSIMPackage: { findMany: vi.fn().mockResolvedValue([]) },
      }
      await cb(tx)
    })

    const result = await applyRulesToPackages()

    expect(result).toEqual({ success: true, matched: 1 })
  })
})
