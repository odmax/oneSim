import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  classifyPackage,
  reconcileProviderPackage,
  isAutoApplicable,
  applyPackageReconciliation,
  resolveProviderPricingRule,
  type ClassificationInput,
} from './provider-pricing-reconciliation'

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    providerPackage: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    packageConfigurationRule: { findFirst: vi.fn() },
    eSIMPackage: { findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}))
const { mockRecalc } = vi.hoisted(() => ({ mockRecalc: vi.fn() }))
const { mockSyncRetail } = vi.hoisted(() => ({ mockSyncRetail: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/pricing/price-recalculation-service', () => ({ recalculatePackagePrice: mockRecalc }))
vi.mock('@/lib/services/catalog-price-sync', () => ({
  syncProviderPackageToPublishedProducts: mockSyncRetail,
}))

import { prisma } from '@/lib/prisma'

const rule9: ClassificationInput['rule'] = {
  ruleAvailable: true,
  resolvedRuleId: 'cmr-9',
  resolvedRuleName: '9%',
  resolvedMarkupPercent: 9,
}

function input(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    costPrice: 4.5,
    sellingPrice: null,
    markupPercent: null,
    pricingStatus: 'COST_UNAVAILABLE',
    publishStatus: 'DRAFT',
    configurationStatus: 'UNCONFIGURED',
    activeSnapshotId: null,
    activeSnapshot: null,
    retailLinked: false,
    retailPriceUSD: null,
    rule: rule9,
    ...overrides,
  }
}

describe('classifyPackage — deterministic multi-finding classification', () => {
  it('231-style unpriced row + applicable rule → UNPRICED_RULE_AVAILABLE', () => {
    const r = classifyPackage(input({
      costPrice: 4.5, sellingPrice: null, pricingStatus: 'READY',
      publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED',
    }))
    expect(r).toEqual(['UNPRICED_RULE_AVAILABLE'])
  })

  it('valid cost + no rule → UNPRICED_NO_RULE', () => {
    const r = classifyPackage(input({ rule: { ruleAvailable: false, resolvedRuleId: null } }))
    expect(r).toEqual(['UNPRICED_NO_RULE'])
  })

  it('BELOW_COST_REPRICE when selling < cost and priced', () => {
    const r = classifyPackage(input({
      costPrice: 8.49, sellingPrice: 7.09, markupPercent: 9, pricingStatus: 'READY', publishStatus: 'DRAFT',
    }))
    expect(r).toContain('BELOW_COST_REPRICE')
  })

  it('STALE_SNAPSHOT_COST when snapshot cost differs materially (increase)', () => {
    const r = classifyPackage(input({
      costPrice: 22.5, sellingPrice: 23.76, pricingStatus: 'READY', publishStatus: 'READY',
      activeSnapshotId: 'snap-1', activeSnapshot: { effectiveCostAmount: 21.8, originalCostAmount: 21.8 },
    }))
    expect(r).toContain('STALE_SNAPSHOT_COST')
  })

  it('STALE_SNAPSHOT_COST when snapshot cost differs materially (decrease)', () => {
    const r = classifyPackage(input({
      costPrice: 8, sellingPrice: 13.63, pricingStatus: 'READY', publishStatus: 'READY',
      activeSnapshotId: 'snap-1', activeSnapshot: { effectiveCostAmount: 12.5, originalCostAmount: 12.5 },
    }))
    expect(r).toContain('STALE_SNAPSHOT_COST')
  })

  it('no stale snapshot when costs match within tolerance', () => {
    const r = classifyPackage(input({
      costPrice: 22.5, sellingPrice: 23.76, pricingStatus: 'READY',
      activeSnapshotId: 'snap-1', activeSnapshot: { effectiveCostAmount: 22.5, originalCostAmount: 22.5 },
    }))
    expect(r).not.toContain('STALE_SNAPSHOT_COST')
    expect(r).toEqual(['OK'])
  })

  it('RETAIL_PARITY_MISMATCH when retail price differs from selling', () => {
    const r = classifyPackage(input({
      costPrice: 25, sellingPrice: 27.25, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
      activeSnapshotId: 'snap-1', activeSnapshot: { effectiveCostAmount: 25, originalCostAmount: 25 },
      retailLinked: true, retailPriceUSD: 27.47,
    }))
    expect(r).toContain('RETAIL_PARITY_MISMATCH')
    expect(r).not.toContain('OK')
  })

  it('South Africa: PUBLISHED + no snapshot + no retail → MISSING_SNAPSHOT + MISSING_RETAIL', () => {
    const r = classifyPackage(input({
      costPrice: 10.99, sellingPrice: 11.26, markupPercent: 2.5, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
      activeSnapshotId: null, activeSnapshot: null, retailLinked: false, retailPriceUSD: null,
    }))
    expect(r).toEqual(expect.arrayContaining(['MISSING_SNAPSHOT', 'MISSING_RETAIL']))
  })

  it('COST_UNAVAILABLE when cost missing/invalid', () => {
    const r = classifyPackage(input({ costPrice: 0, sellingPrice: null, pricingStatus: 'COST_UNAVAILABLE' }))
    expect(r).toEqual(['COST_UNAVAILABLE'])
  })

  it('REQUIRES_PRICING passes through the new semantic state', () => {
    const r = classifyPackage(input({ pricingStatus: 'REQUIRES_PRICING' }))
    expect(r).toEqual(['REQUIRES_PRICING'])
  })

  it('consistent priced row → OK', () => {
    const r = classifyPackage(input({
      costPrice: 4.5, sellingPrice: 4.91, markupPercent: 9, pricingStatus: 'READY',
      activeSnapshotId: 'snap-1', activeSnapshot: { effectiveCostAmount: 4.5, originalCostAmount: 4.5 },
    }))
    expect(r).toEqual(['OK'])
  })
})

describe('isAutoApplicable — conservative never-auto set', () => {
  it('UNPRICED_RULE_AVAILABLE / BELOW_COST / STALE_SNAPSHOT / RETAIL_PARITY are auto', () => {
    expect(isAutoApplicable(['UNPRICED_RULE_AVAILABLE'])).toBe(true)
    expect(isAutoApplicable(['BELOW_COST_REPRICE'])).toBe(true)
    expect(isAutoApplicable(['STALE_SNAPSHOT_COST'])).toBe(true)
    expect(isAutoApplicable(['RETAIL_PARITY_MISMATCH'])).toBe(true)
  })

  it('never auto: MISSING_RETAIL / UNPRICED_NO_RULE / COST_UNAVAILABLE / REQUIRES_PRICING', () => {
    expect(isAutoApplicable(['MISSING_RETAIL'])).toBe(false)
    expect(isAutoApplicable(['UNPRICED_NO_RULE'])).toBe(false)
    expect(isAutoApplicable(['COST_UNAVAILABLE'])).toBe(false)
    expect(isAutoApplicable(['REQUIRES_PRICING'])).toBe(false)
  })

  it('auto class poisoned by a never-auto class stays manual (South Africa)', () => {
    expect(isAutoApplicable(['MISSING_RETAIL', 'MISSING_SNAPSHOT'])).toBe(false)
    expect(isAutoApplicable(['MISSING_RETAIL', 'BELOW_COST_REPRICE'])).toBe(false)
  })
})

describe('applyPackageReconciliation — conservative apply', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRecalc.mockResolvedValue({ success: true, pricingStatus: 'READY', priceSnapshotId: 'snap-new' })
    mockSyncRetail.mockResolvedValue({ matchedProducts: 1, updatedProducts: 1, skippedProducts: 0, productIds: ['retail-1'] } as any)
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      mockPrisma.providerPackage.findUnique.mockResolvedValue({
        id: 'pp-1', name: 'X', dataGB: 1, validityDays: 30, costPrice: 4.5, currency: 'USD',
        sellingPrice: 4.91, sellingCurrency: 'USD', markupPercent: 9, providerPlanId: 'P-1', providerId: 'prov-1', publishStatus: 'PUBLISHED',
      })
      await fn(mockPrisma)
    })
  })

  it('UNPRICED_RULE_AVAILABLE → canonical recalc + fresh snapshot, no publish', async () => {
    const result = reconcileProviderPackage(input({ pricingStatus: 'READY' }))
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'DRAFT', classifications: result.classifications }, result)
    expect(out.applied).toBe(true)
    expect(mockRecalc).toHaveBeenCalledTimes(1)
    expect(mockRecalc.mock.calls[0][0]).toBe('pp-1')
    expect(mockRecalc.mock.calls[0][1]).toBe('PROVIDER_COST_CHANGED')
    // DRAFT → no retail sync
    expect(mockSyncRetail).not.toHaveBeenCalled()
  })

  it('BELOW_COST_REPRICE → recalc; PUBLISHED → retail synced after success', async () => {
    const result = reconcileProviderPackage(input({
      costPrice: 8.49, sellingPrice: 7.09, markupPercent: 9, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
      activeSnapshotId: 'snap-1', activeSnapshot: { effectiveCostAmount: 8.49, originalCostAmount: 8.49 },
      retailLinked: true, retailPriceUSD: 8,
    }))
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'PUBLISHED', classifications: result.classifications }, result)
    expect(out.applied).toBe(true)
    expect(mockRecalc).toHaveBeenCalledTimes(1)
    expect(mockSyncRetail).toHaveBeenCalledTimes(1)
  })

  it('STALE_SNAPSHOT_COST (increase) → recalc + retail sync for published', async () => {
    const result = reconcileProviderPackage(input({
      costPrice: 22.5, sellingPrice: 23.76, markupPercent: 9, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
      activeSnapshotId: 'snap-1', activeSnapshot: { effectiveCostAmount: 21.8, originalCostAmount: 21.8 },
      retailLinked: true, retailPriceUSD: 23.76,
    }))
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'PUBLISHED', classifications: result.classifications }, result)
    expect(out.applied).toBe(true)
    expect(mockRecalc).toHaveBeenCalledTimes(1)
    expect(mockSyncRetail).toHaveBeenCalledTimes(1)
  })

  it('RETAIL_PARITY_MISMATCH alone → retail-only sync, no recalc, no new retail', async () => {
    const result = reconcileProviderPackage(input({
      costPrice: 25, sellingPrice: 27.25, markupPercent: 9, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
      activeSnapshotId: 'snap-1', activeSnapshot: { effectiveCostAmount: 25, originalCostAmount: 25 },
      retailLinked: true, retailPriceUSD: 27.47,
    }))
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'PUBLISHED', classifications: result.classifications }, result)
    expect(out.applied).toBe(true)
    expect(mockRecalc).not.toHaveBeenCalled()
    expect(mockSyncRetail).toHaveBeenCalledTimes(1)
  })

  it('recalc failure → skipped with error, retail NOT touched, no new row', async () => {
    mockRecalc.mockResolvedValue({ success: false, pricingStatus: 'MARGIN_BELOW_MINIMUM', reason: 'Sell <= cost' })
    const result = reconcileProviderPackage(input({
      costPrice: 9, sellingPrice: 8, markupPercent: 9, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
      activeSnapshotId: 'snap-1', activeSnapshot: { effectiveCostAmount: 9, originalCostAmount: 9 },
      retailLinked: true, retailPriceUSD: 8,
    }))
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'PUBLISHED', classifications: result.classifications }, result)
    expect(out.applied).toBe(false)
    expect(out.error).toBeTruthy()
    expect(mockSyncRetail).not.toHaveBeenCalled()
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
  })

  it('MISSING_RETAIL never auto-repairs (South Africa safety)', async () => {
    const result = reconcileProviderPackage(input({
      costPrice: 10.99, sellingPrice: 11.26, markupPercent: 2.5, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
    }))
    expect(result.applyAllowed).toBe(false)
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'PUBLISHED', classifications: result.classifications }, result)
    expect(out.applied).toBe(false)
    expect(out.skipped).toBe(true)
    expect(mockRecalc).not.toHaveBeenCalled()
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
  })

  it('UNPRICED_NO_RULE never fabricates selling', async () => {
    const result = reconcileProviderPackage(input({ rule: { ruleAvailable: false, resolvedRuleId: null } }))
    expect(result.applyAllowed).toBe(false)
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'DRAFT', classifications: result.classifications }, result)
    expect(out.applied).toBe(false)
    expect(mockRecalc).not.toHaveBeenCalled()
    expect(mockPrisma.providerPackage.create).not.toHaveBeenCalled()
  })
})

describe('resolveProviderPricingRule', () => {
  it('returns the active provider-level rule (highest priority)', async () => {
    mockPrisma.packageConfigurationRule.findFirst.mockResolvedValue({ id: 'cmr-9', name: '9%', markupPercent: 9, priority: 0, isActive: true })
    const r = await resolveProviderPricingRule('prov-1')
    expect(r.ruleAvailable).toBe(true)
    expect(r.resolvedRuleId).toBe('cmr-9')
    expect(r.resolvedMarkupPercent).toBe(9)
  })

  it('no rule → ruleAvailable false', async () => {
    mockPrisma.packageConfigurationRule.findFirst.mockResolvedValue(null)
    const r = await resolveProviderPricingRule('prov-1')
    expect(r.ruleAvailable).toBe(false)
    expect(r.resolvedRuleId).toBeNull()
  })
})