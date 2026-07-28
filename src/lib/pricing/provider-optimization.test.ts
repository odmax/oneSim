import { describe, it, expect } from 'vitest'
import { optimizePackage, batchOptimize } from './provider-optimization'
import type { OptimizationRules } from './provider-optimization'
import type { ProviderIntelligenceInput } from './provider-intelligence'

function makeInput(overrides: Partial<ProviderIntelligenceInput> = {}): ProviderIntelligenceInput {
  return {
    packageId: overrides.packageId || 'pkg-1',
    packageName: overrides.packageName || 'Test Package',
    providerId: overrides.providerId || 'prov-1',
    providerCode: 'PROV',
    providerName: overrides.providerName || 'Test Provider',
    providerStatus: 'ACTIVE',
    costPrice: overrides.costPrice ?? 100,
    dataGB: 5,
    validityDays: 30,
    ...overrides,
  }
}

const defaultRules: OptimizationRules = { strategy: 'LOWEST_COST', allowSwitching: true }

describe('optimizePackage', () => {
  it('recommends cheapest provider with LOWEST_COST strategy', () => {
    const result = optimizePackage([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Expensive', costPrice: 150, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Cheap', costPrice: 80 }),
    ], 200, 'local:KE:5GB:30', defaultRules)

    expect(result.shouldSwitch).toBe(true)
    expect(result.recommendedProvider!.providerName).toBe('Cheap')
    expect(result.costDifference).toBe(70)
    expect(result.confidence).toBeGreaterThanOrEqual(70)
  })

  it('keeps current when already cheapest', () => {
    const result = optimizePackage([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Best', costPrice: 50, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Expensive', costPrice: 100 }),
    ], 150, null, defaultRules)

    expect(result.shouldSwitch).toBe(false)
    expect(result.recommendedProvider!.providerName).toBe('Best')
  })

  it('respects switching disabled', () => {
    const rules: OptimizationRules = { strategy: 'LOWEST_COST', allowSwitching: false }
    const result = optimizePackage([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Current', costPrice: 150, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Cheaper', costPrice: 80 }),
    ], 200, null, rules)

    expect(result.shouldSwitch).toBe(false)
    expect(result.reason).toContain('switching is disabled')
  })

  it('filters providers below minimum margin', () => {
    const rules: OptimizationRules = { strategy: 'HIGHEST_MARGIN', minMarginPercent: 40, allowSwitching: true }
    const result = optimizePackage([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'LowMargin', costPrice: 180, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'HighMargin', costPrice: 120 }),
      makeInput({ packageId: 'c', providerId: 'p3', providerName: 'MidMargin', costPrice: 140 }),
    ], 200, null, rules)

    // At $200 selling: LowMargin=10%, HighMargin=40%, MidMargin=30%
    // Only HighMargin meets 40% threshold
    expect(result.recommendedProvider!.providerName).toBe('HighMargin')
  })

  it('excludes specific providers', () => {
    const rules: OptimizationRules = { strategy: 'LOWEST_COST', excludedProviderIds: ['p2'], allowSwitching: true }
    const result = optimizePackage([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Allowed', costPrice: 150, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Excluded', costPrice: 80 }),
    ], 200, null, rules)

    // p2 (cheapest) is excluded, so p1 should remain
    expect(result.recommendedProvider!.providerName).toBe('Allowed')
    expect(result.shouldSwitch).toBe(false)
  })

  it('enforces max acceptable cost', () => {
    const rules: OptimizationRules = { strategy: 'LOWEST_COST', maxAcceptableCost: 100, allowSwitching: true }
    const result = optimizePackage([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Expensive', costPrice: 200, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Mid', costPrice: 120 }),
      makeInput({ packageId: 'c', providerId: 'p3', providerName: 'Cheap', costPrice: 80 }),
    ], 200, null, rules)

    // Only $80 is under the $100 max
    expect(result.recommendedProvider!.providerName).toBe('Cheap')
  })

  it('skips when no valid providers after filtering', () => {
    const rules: OptimizationRules = { strategy: 'LOWEST_COST', maxAcceptableCost: 10, allowSwitching: true }
    const result = optimizePackage([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Expensive', costPrice: 100 }),
    ], 200, null, rules)

    expect(result.skipReason).toBeDefined()
    expect(result.recommendedProvider).toBeNull()
    expect(result.shouldSwitch).toBe(false)
  })

  it('supports HIGHEST_MARGIN strategy', () => {
    const rules: OptimizationRules = { strategy: 'HIGHEST_MARGIN', allowSwitching: true }
    const result = optimizePackage([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'LowMargin', costPrice: 180, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'HighMargin', costPrice: 120 }),
    ], 200, null, rules)

    expect(result.recommendedProvider!.providerName).toBe('HighMargin')
    // 200 - 180 = 20 profit, 120/200*100 = 60% margin
    // 200 - 120 = 80 profit, 80/200*100 = 40% margin
    // Wait: 200 sell - 120 cost = 80 profit. 80/200 = 40% margin
    // 200 sell - 180 cost = 20 profit. 20/200 = 10% margin
    // So HighMargin at 40% has higher margin than LowMargin at 10%
    // But wait - the names are swapped in my test! Let me check:
    // HighMargin has cost 120 → margin 40% ✓
    // LowMargin has cost 180 → margin 10%
    // So HighMargin is correctly recommended. 
    expect(result.marginDifference).toBe(30) // 40% - 10% = 30%
  })

  it('supports HIGHEST_PROFIT strategy', () => {
    const rules: OptimizationRules = { strategy: 'HIGHEST_PROFIT', allowSwitching: true }
    const result = optimizePackage([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'LowProfit', costPrice: 180, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'HighProfit', costPrice: 100 }),
    ], 200, null, rules)

    // 200 - 180 = $20 profit vs 200 - 100 = $100 profit
    expect(result.recommendedProvider!.providerName).toBe('HighProfit')
    expect(result.profitDifference).toBe(80)
  })

  it('supports CUSTOM strategy with preferred providers', () => {
    const rules: OptimizationRules = { strategy: 'CUSTOM', preferredProviderIds: ['p3'], allowSwitching: true }
    const result = optimizePackage([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Not Preferred', costPrice: 50, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Also Not', costPrice: 80 }),
      makeInput({ packageId: 'c', providerId: 'p3', providerName: 'Preferred', costPrice: 90 }),
    ], 200, null, rules)

    expect(result.recommendedProvider!.providerName).toBe('Preferred')
  })

  it('generates multiple justification reasons', () => {
    const result = optimizePackage([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Expensive', costPrice: 150, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Cheap', costPrice: 80 }),
    ], 200, null, defaultRules)

    expect(result.reasons.length).toBeGreaterThan(1)
    expect(result.reasons.some(r => r.includes('Lowest cost'))).toBe(true)
    expect(result.reasons.some(r => r.includes('Saves'))).toBe(true)
  })

  it('computes high confidence for strong recommendations', () => {
    const result = optimizePackage([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Expensive', costPrice: 200, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Cheap1', costPrice: 50 }),
      makeInput({ packageId: 'c', providerId: 'p3', providerName: 'Cheap2', costPrice: 60 }),
      makeInput({ packageId: 'd', providerId: 'p4', providerName: 'Cheap3', costPrice: 70 }),
    ], 200, null, defaultRules)

    expect(result.confidence).toBeGreaterThanOrEqual(90)
    expect(result.shouldSwitch).toBe(true)
  })

  it('never writes to database', () => {
    const result = optimizePackage([makeInput()], 150, null, defaultRules)
    expect(result).toHaveProperty('packageId')
    expect(result).toHaveProperty('confidence')
    expect(result).not.toHaveProperty('transactionId')
    expect(result).not.toHaveProperty('updatedAt')
  })
})

describe('batchOptimize', () => {
  it('processes multiple groups and returns summary', () => {
    const result = batchOptimize([
      {
        comparableKey: 'local:KE:5GB:30',
        packages: [
          makeInput({ packageId: 'a1', providerId: 'p1', providerName: 'A', costPrice: 150, currentProviderPackageId: 'a1' }),
          makeInput({ packageId: 'a2', providerId: 'p2', providerName: 'B', costPrice: 80 }),
        ],
        catalogSellingPrice: 200,
        currency: 'USD',
      },
      {
        comparableKey: 'local:TZ:1GB:7',
        packages: [
          makeInput({ packageId: 'b1', providerId: 'p3', providerName: 'C', costPrice: 50, currentProviderPackageId: 'b1' }),
          makeInput({ packageId: 'b2', providerId: 'p4', providerName: 'D', costPrice: 100 }),
        ],
        catalogSellingPrice: 100,
        currency: 'USD',
      },
    ], defaultRules)

    expect(result.summary.totalAnalyzed).toBe(2)
    expect(result.results).toHaveLength(2)
    // Group 1: should switch from A($150) to B($80)
    // Group 2: C($50) already cheapest, should stay
    expect(result.summary.requireChange).toBe(1)
    expect(result.summary.alreadyOptimal).toBe(1)
  })

  it('tracks estimated savings', () => {
    const result = batchOptimize([
      {
        comparableKey: 'local:KE:5GB:30',
        packages: [
          makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Exp', costPrice: 150, currentProviderPackageId: 'a' }),
          makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Cheap', costPrice: 80 }),
        ],
        catalogSellingPrice: 200,
        currency: 'USD',
      },
    ], defaultRules)

    expect(result.summary.estimatedMonthlyCostSavings).toBe(70) // 150 - 80
  })
})
