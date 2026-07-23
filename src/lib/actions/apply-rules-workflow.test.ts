import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prisma } from '@/lib/prisma'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    packageConfigurationRule: {
      findUnique: vi.fn(),
    },
    ruleExecution: {
      create: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    catalogChangeSet: { create: vi.fn().mockResolvedValue({}) },
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
import { executeApplyRule } from './apply-rules-workflow'
import { revalidatePath } from 'next/cache'
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes } from '@/lib/services/catalog-price-sync'

function makeSession(overrides: Record<string, any> = {}) {
  return { user: { id: 'admin-1', role: 'INTERNAL_ADMIN', email: 'admin@test.com', ...overrides } }
}

function makeRule(overrides: Record<string, any> = {}) {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    isActive: true,
    providerId: null,
    country: null,
    region: null,
    dataMinGB: null,
    dataMaxGB: null,
    validityMinDays: null,
    validityMaxDays: null,
    costPrice: null,
    markupPercent: 50,
    fixedPrice: null,
    sellingCurrency: 'USD',
    publishStatus: 'READY',
    priority: 0,
    ...overrides,
  }
}

function makePackage(overrides: Record<string, any> = {}) {
  return {
    id: 'pkg-1',
    name: 'Test Plan',
    costPrice: 2.0,
    sellingPrice: null,
    sellingCurrency: null,
    markupPercent: null,
    pricingMode: null,
    publishStatus: 'DRAFT',
    configurationStatus: 'UNCONFIGURED',
    dataGB: 5,
    validityDays: 30,
    providerId: 'prov-1',
    country: 'NG',
    region: null,
    autoConfiguredByRuleId: null,
    lastConfiguredAt: null,
    ...overrides,
  }
}

describe('executeApplyRule', () => {
  const executionId = 'exec-1'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue(makeSession() as any)
    vi.mocked(prisma.packageConfigurationRule.findUnique).mockResolvedValue(makeRule())
    vi.mocked(prisma.ruleExecution.create).mockResolvedValue({ id: executionId } as any)
    vi.mocked(prisma.ruleExecution.update).mockResolvedValue({} as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))
  })

  it('returns Unauthorized when no session', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null)
    const result = await executeApplyRule('rule-1', 'draft', {})
    expect(result).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('returns Unauthorized when role is not INTERNAL_ADMIN', async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'user-1', role: 'USER' } } as any)
    const result = await executeApplyRule('rule-1', 'draft', {})
    expect(result).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('returns error when rule not found', async () => {
    vi.mocked(prisma.packageConfigurationRule.findUnique).mockResolvedValue(null)
    const result = await executeApplyRule('rule-missing', 'draft', {})
    expect(result).toEqual({ success: false, error: 'Rule not found' })
  })

  it('returns error when rule is inactive', async () => {
    vi.mocked(prisma.packageConfigurationRule.findUnique).mockResolvedValue(makeRule({ isActive: false }))
    const result = await executeApplyRule('rule-1', 'draft', {})
    expect(result).toEqual({ success: false, error: 'Rule is inactive — activate it first' })
  })

  it('matched packages are updated and synced in a transaction', async () => {
    const pkg = makePackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pkg])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))

    const result = await executeApplyRule('rule-1', 'draft', {})

    expect(result.success).toBe(true)
    expect(vi.mocked(prisma.providerPackage.update)).toHaveBeenCalledWith({
      where: { id: 'pkg-1' },
      data: expect.objectContaining({
        sellingPrice: 3.0,
        sellingCurrency: 'USD',
        markupPercent: 50,
        pricingMode: 'MARKUP_PERCENT',
        publishStatus: 'READY',
        configurationStatus: 'AUTO_CONFIGURED',
        autoConfiguredByRuleId: 'rule-1',
      }),
    })
    expect(vi.mocked(syncProviderPackageToPublishedProducts)).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ id: 'pkg-1', sellingPrice: 3.0, sellingCurrency: 'USD' }),
    )
  })

  it('skipped packages (not matching rule criteria) remain unchanged', async () => {
    vi.mocked(prisma.packageConfigurationRule.findUnique).mockResolvedValue(makeRule({ providerId: 'prov-1' }))
    const mismatched = makePackage({ id: 'pkg-1', providerId: 'prov-other' })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([mismatched])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)

    const result = await executeApplyRule('rule-1', 'draft', {})

    expect(result.success).toBe(true)
    expect(result.matched).toBe(0)
    expect(result.skipped).toBe(1)
    expect(vi.mocked(prisma.providerPackage.update)).not.toHaveBeenCalled()
    expect(vi.mocked(syncProviderPackageToPublishedProducts)).not.toHaveBeenCalled()
  })

  it('skips packages with missing or zero cost price', async () => {
    const noCost = makePackage({ id: 'pkg-1', costPrice: 0 })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([noCost])

    const result = await executeApplyRule('rule-1', 'draft', {})

    expect(result.matched).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('skips already published packages', async () => {
    const published = makePackage({ id: 'pkg-1', publishStatus: 'PUBLISHED' })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([published])

    const result = await executeApplyRule('rule-1', 'draft', {})

    expect(result.matched).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('skips packages already processed by this rule', async () => {
    const alreadyProcessed = makePackage({ id: 'pkg-1', autoConfiguredByRuleId: 'rule-1' })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([alreadyProcessed])

    const result = await executeApplyRule('rule-1', 'draft', {})

    expect(result.matched).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('skips packages where selling price cannot be computed', async () => {
    const noMarkupPkg = makePackage({ id: 'pkg-1' })
    const noMarkupRule = makeRule({ markupPercent: null, fixedPrice: null })
    vi.mocked(prisma.packageConfigurationRule.findUnique).mockResolvedValue(noMarkupRule)
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([noMarkupPkg])

    const result = await executeApplyRule('rule-1', 'draft', {})

    expect(result.matched).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('creates rule execution record with RUNNING status then updates to COMPLETED', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makePackage()])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))

    await executeApplyRule('rule-1', 'draft', {})

    expect(vi.mocked(prisma.ruleExecution.create)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ruleId: 'rule-1', status: 'RUNNING' }) }),
    )
    expect(vi.mocked(prisma.ruleExecution.update)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: executionId }, data: expect.objectContaining({ status: 'COMPLETED' }) }),
    )
  })

  it('creates audit log after success', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makePackage()])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))

    await executeApplyRule('rule-1', 'draft', {})

    expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalledWith({
      data: {
        userId: 'admin-1',
        action: 'RULE_APPLIED',
        entity: 'RuleExecution',
        entityId: executionId,
        details: expect.stringContaining('Rule "Test Rule" applied:'),
      },
    })
  })

  it('creates CatalogChangeSet after success', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makePackage()])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))

    await executeApplyRule('rule-1', 'draft', {})

    expect(vi.mocked(prisma.catalogChangeSet.create)).toHaveBeenCalledWith({
      data: {
        actionType: 'RULES_APPLIED',
        description: expect.stringContaining('Applied "Test Rule"'),
        createdById: 'admin-1',
        totalChanged: 1,
        metadata: { ruleId: 'rule-1', executionId },
      },
    })
  })

  it('returns structured error when transaction fails (outer try/catch)', async () => {
    const pkg = makePackage()
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pkg])
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('Transaction failed'))

    const result = await executeApplyRule('rule-1', 'draft', {})

    expect(result).toEqual({ success: false, error: 'Transaction failed' })
  })

  it('calls revalidateCatalogRoutes after success', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makePackage()])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))

    await executeApplyRule('rule-1', 'draft', {})

    expect(vi.mocked(revalidateCatalogRoutes)).toHaveBeenCalledTimes(1)
  })

  it('calls revalidatePath for /admin/package-rules after success', async () => {
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([makePackage()])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))

    await executeApplyRule('rule-1', 'draft', {})

    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith('/admin/package-rules')
  })

  it('return summary includes correct matched/skipped/failed counts', async () => {
    vi.mocked(prisma.packageConfigurationRule.findUnique).mockResolvedValue(makeRule({ providerId: 'prov-1' }))
    const matchedPkg = makePackage({ id: 'pkg-1', providerId: 'prov-1' })
    const skippedPkg = makePackage({ id: 'pkg-2', providerId: 'prov-other' })
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([matchedPkg, skippedPkg])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))

    const result = await executeApplyRule('rule-1', 'draft', {})

    expect(result.matched).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.skipReasons).toBeDefined()
    expect(result.skipReasons!.length).toBeGreaterThanOrEqual(1)
  })

  it('uses fixedPrice from rule when provided', async () => {
    const pkg = makePackage()
    const fixedRule = makeRule({ markupPercent: null, fixedPrice: 9.99, sellingCurrency: 'EUR' })
    vi.mocked(prisma.packageConfigurationRule.findUnique).mockResolvedValue(fixedRule)
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pkg])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))

    const result = await executeApplyRule('rule-1', 'draft', {})

    expect(result.matched).toBe(1)
    expect(vi.mocked(prisma.providerPackage.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pkg-1' },
        data: expect.objectContaining({
          sellingPrice: 9.99,
          sellingCurrency: 'EUR',
          pricingMode: 'FIXED_PRICE',
        }),
      }),
    )
  })

  it('uses overridden costPrice from rule when provided', async () => {
    const pkg = makePackage({ costPrice: 2.0 })
    const costRule = makeRule({ costPrice: 5.0, markupPercent: 100, fixedPrice: null })
    vi.mocked(prisma.packageConfigurationRule.findUnique).mockResolvedValue(costRule)
    vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([pkg])
    vi.mocked(prisma.providerPackage.update).mockResolvedValue({} as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))

    const result = await executeApplyRule('rule-1', 'draft', {})

    expect(result.matched).toBe(1)
    expect(vi.mocked(prisma.providerPackage.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pkg-1' },
        data: expect.objectContaining({
          sellingPrice: 10.0,
          costPrice: 5.0,
        }),
      }),
    )
  })
})
