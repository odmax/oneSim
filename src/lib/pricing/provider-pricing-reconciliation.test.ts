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
  it('auto only for genuine drift classes: BELOW_COST / STALE_SNAPSHOT / RETAIL_PARITY', () => {
    expect(isAutoApplicable(['BELOW_COST_REPRICE'])).toBe(true)
    expect(isAutoApplicable(['STALE_SNAPSHOT_COST'])).toBe(true)
    expect(isAutoApplicable(['RETAIL_PARITY_MISMATCH'])).toBe(true)
  })

  it('UNPRICED_RULE_AVAILABLE is REPORT-ONLY — a matching rule is NOT config intent', () => {
    expect(isAutoApplicable(['UNPRICED_RULE_AVAILABLE'])).toBe(false)
  })

  it('never auto: MISSING_RETAIL / UNPRICED_NO_RULE / UNPRICED_RULE_AVAILABLE / COST_UNAVAILABLE / REQUIRES_PRICING', () => {
    expect(isAutoApplicable(['MISSING_RETAIL'])).toBe(false)
    expect(isAutoApplicable(['UNPRICED_NO_RULE'])).toBe(false)
    expect(isAutoApplicable(['UNPRICED_RULE_AVAILABLE'])).toBe(false)
    expect(isAutoApplicable(['COST_UNAVAILABLE'])).toBe(false)
    expect(isAutoApplicable(['REQUIRES_PRICING'])).toBe(false)
  })

  it('auto class poisoned by a never-auto class stays manual', () => {
    expect(isAutoApplicable(['MISSING_RETAIL', 'MISSING_SNAPSHOT'])).toBe(false)
    expect(isAutoApplicable(['MISSING_RETAIL', 'BELOW_COST_REPRICE'])).toBe(false)
    expect(isAutoApplicable(['UNPRICED_RULE_AVAILABLE', 'BELOW_COST_REPRICE'])).toBe(false)
  })

  it('MISSING_SNAPSHOT alone is not auto (no auto class present)', () => {
    expect(isAutoApplicable(['MISSING_SNAPSHOT'])).toBe(false)
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

  it('UNPRICED_RULE_AVAILABLE is REPORT-ONLY — zero mutation, even with a matching rule', async () => {
    const result = reconcileProviderPackage(input({ pricingStatus: 'READY' }))
    expect(result.applyAllowed).toBe(false)
    expect(result.proposedAction).toContain('REPORT ONLY')
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'DRAFT', classifications: result.classifications }, result)
    expect(out.applied).toBe(false)
    expect(out.skipped).toBe(true)
    expect(mockRecalc).not.toHaveBeenCalled()
    expect(mockPrisma.providerPackage.update).not.toHaveBeenCalled()
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
  })

  it('BELOW_COST_REPRICE on a priced package declares established policy and recales (mutation gate passes)', async () => {
    // A priced row (sellingPrice>0) is established intent per the shared helper,
    // so BELOW_COST (cost changed below an existing selling) is forward-reprice
    // eligible. This proves the mutation gate allows reprice when intent exists.
    const result = reconcileProviderPackage(input({
      costPrice: 9, sellingPrice: 8, markupPercent: null, pricingStatus: 'READY',
      publishStatus: 'READY', configurationStatus: 'CONFIGURED',
      activeSnapshotId: null, activeSnapshot: null,
    }))
    expect(result.establishedPolicy).toBe(true)
    expect(result.classifications).toContain('BELOW_COST_REPRICE')
    expect(result.applyAllowed).toBe(true)
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'READY', classifications: result.classifications }, result)
    expect(out.applied).toBe(true)
    expect(mockRecalc).toHaveBeenCalledTimes(1)
  })

  it('BELOW_COST_REPRICE on unconfigured inventory with NO policy is blocked before any recalc', async () => {
    // Force establishedPolicy=false: no autoConfiguredByRuleId, no markup, no
    // selling, no snapshot, no lifecycle state. (A selling-price-only row is
    // treated as intent by the shared helper, so construct an explicit false.)
    const noPolicy = input({
      costPrice: 9, sellingPrice: null, markupPercent: null, pricingStatus: 'COST_UNAVAILABLE',
      publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED',
      activeSnapshotId: null, activeSnapshot: null, rule: { ruleAvailable: true, resolvedRuleId: 'cmr-9' },
    })
    const result = reconcileProviderPackage(noPolicy)
    // It classifies UNPRICED_RULE_AVAILABLE (report-only), never reaches recalc.
    expect(result.classifications).toContain('UNPRICED_RULE_AVAILABLE')
    expect(result.applyAllowed).toBe(false)
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'DRAFT', classifications: result.classifications }, result)
    expect(out.applied).toBe(false)
    expect(mockRecalc).not.toHaveBeenCalled()
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

  it('MISSING_SNAPSHOT only → automatic repair blocked', async () => {
    const result = reconcileProviderPackage(input({
      costPrice: 4.5, sellingPrice: 4.91, markupPercent: 9, pricingStatus: 'READY',
      activeSnapshotId: null, activeSnapshot: null, publishStatus: 'READY', configurationStatus: 'CONFIGURED',
    }))
    expect(result.classifications).toContain('MISSING_SNAPSHOT')
    expect(result.applyAllowed).toBe(false)
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'READY', classifications: result.classifications }, result)
    expect(out.applied).toBe(false)
    expect(mockRecalc).not.toHaveBeenCalled()
  })

  it('unknown/ambiguous classification set never mutates (fail closed even if report bypassed)', async () => {
    const result = reconcileProviderPackage(input({ pricingStatus: 'REQUIRES_PRICING' }))
    expect(result.applyAllowed).toBe(false)
    const unknown = { ...result, classifications: ['REQUIRES_PRICING'] as any }
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'DRAFT', classifications: unknown.classifications }, unknown as any)
    expect(out.applied).toBe(false)
    expect(mockRecalc).not.toHaveBeenCalled()
  })

  it('reconciliation never auto-publishes a never-configured row merely from valid cost', async () => {
    const result = reconcileProviderPackage(input({ pricingStatus: 'READY' }))
    expect(result.applyAllowed).toBe(false)
    expect(result.proposedAction).toContain('REPORT ONLY')
    await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'DRAFT', classifications: result.classifications }, result)
    expect(mockPrisma.providerPackage.update).not.toHaveBeenCalled()
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
  })

  it('reconciliation never creates a missing retail product (MISSING_RETAIL always manual)', async () => {
    const result = reconcileProviderPackage(input({
      costPrice: 10.99, sellingPrice: 11.26, markupPercent: 2.5, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
    }))
    expect(result.applyAllowed).toBe(false)
    const out = await applyPackageReconciliation({ id: 'pp-1', providerPlanId: 'P-1', publishStatus: 'PUBLISHED', classifications: result.classifications }, result)
    expect(out.applied).toBe(false)
    expect(mockRecalc).not.toHaveBeenCalled()
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
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

describe('multi-provider parity — provider identity never changes the decision', () => {
  // The classifier receives ONLY lifecycle state (ClassificationInput); it has no
  // provider-code/name input. Identical state → identical decision regardless of
  // whether it is AIRHUB, CHOICE, US-MATRIX, IBASIS, TELNA, or generic.
  it('unconfigured inventory + matching rule → UNPRICED_RULE_AVAILABLE report-only for ANY provider', () => {
    for (const _provider of ['AIRHUB', 'CHOICE', 'USMATRIX', 'IBASIS', 'TELNA', 'generic_future_provider']) {
      // provider identity is intentionally NOT part of the classification input.
      const result = reconcileProviderPackage(input({
        costPrice: 4.5, sellingPrice: null, pricingStatus: 'READY',
        publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED',
        autoConfiguredByRuleId: null, activeSnapshotId: null, activeSnapshot: null,
      }))
      expect(result.classifications).toContain('UNPRICED_RULE_AVAILABLE')
      expect(result.applyAllowed).toBe(false)
      expect(result.proposedAction).toContain('REPORT ONLY')
    }
  })

  it('previously configured package + established intent + cost drift → identical auto-reprice for ANY provider', () => {
    for (const _provider of ['AIRHUB', 'CHOICE', 'USMATRIX', 'IBASIS', 'TELNA', 'generic_future_provider']) {
      const result = reconcileProviderPackage(input({
        costPrice: 22.5, sellingPrice: 23.76, markupPercent: 9, pricingStatus: 'READY',
        publishStatus: 'PUBLISHED', configurationStatus: 'AUTO_CONFIGURED',
        autoConfiguredByRuleId: 'cmr-intent',
        activeSnapshotId: 'snap-1', activeSnapshot: { effectiveCostAmount: 21.8, originalCostAmount: 21.8 },
        retailLinked: true, retailPriceUSD: 23.76,
      }))
      expect(result.classifications).toContain('STALE_SNAPSHOT_COST')
      expect(result.applyAllowed).toBe(true)
      expect(result.proposedAction).toContain('canonical forward reprice')
    }
  })

  it('identical lifecycle state produces byte-identical decision across providers (no provider branch)', () => {
    const mk = () => classifyPackage(input({
      costPrice: 25, sellingPrice: 27.25, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
      configurationStatus: 'CONFIGURED', activeSnapshotId: 'snap-1',
      activeSnapshot: { effectiveCostAmount: 25, originalCostAmount: 25 },
      retailLinked: true, retailPriceUSD: 27.47,
    }))
    const airhub = classifyPackage({
      ...input({}),
      costPrice: 25, sellingPrice: 27.25, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
      configurationStatus: 'CONFIGURED', activeSnapshotId: 'snap-1',
      activeSnapshot: { effectiveCostAmount: 25, originalCostAmount: 25 },
      retailLinked: true, retailPriceUSD: 27.47,
    })
    // supplier identity never enters the classifier; both must equal the mk() result.
    expect(airhub).toEqual(mk())
  })
})