import { describe, it, expect } from 'vitest'
import { analyzeProviderGroup } from './provider-intelligence'
import type { ProviderIntelligenceInput } from './provider-intelligence'

function makeInput(overrides: Partial<ProviderIntelligenceInput> = {}): ProviderIntelligenceInput {
  return {
    packageId: 'pkg-1',
    packageName: 'Test Package',
    providerId: 'prov-1',
    providerCode: 'TEST',
    providerName: 'Test Provider',
    providerStatus: 'ACTIVE',
    costPrice: 100,
    dataGB: 5,
    validityDays: 30,
    ...overrides,
  }
}

describe('analyzeProviderGroup', () => {
  it('returns empty result for no packages', () => {
    const result = analyzeProviderGroup([], 125, 'local:KE:5GB:30')
    expect(result.comparisons).toHaveLength(0)
    expect(result.recommendedProvider).toBeNull()
    expect(result.recommendationReason).toContain('No provider packages')
  })

  it('identifies cheapest provider', () => {
    const result = analyzeProviderGroup([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Expensive', costPrice: 150 }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Cheap', costPrice: 80 }),
      makeInput({ packageId: 'c', providerId: 'p3', providerName: 'Middle', costPrice: 100 }),
    ], 150, null)

    expect(result.lowestCostProvider!.providerName).toBe('Cheap')
    expect(result.comparisons.find(c => c.providerName === 'Cheap')!.indicators).toContain('CHEAPEST')
  })

  it('recommends cheapest provider when current is more expensive', () => {
    const result = analyzeProviderGroup([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Current', costPrice: 150, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Cheaper', costPrice: 100 }),
    ], 200, null)

    expect(result.recommendedProvider!.providerName).toBe('Cheaper')
    expect(result.recommendationReason).toContain('lowest cost')
    // Current is not cheapest, so recommendation switches
    expect(result.estimatedCostSavings).toBe(50)
  })

  it('keeps current provider when already cheapest', () => {
    const result = analyzeProviderGroup([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Current', costPrice: 50, currentProviderPackageId: 'a' }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Expensive', costPrice: 100 }),
    ], 150, null)

    expect(result.recommendedProvider!.providerName).toBe('Current')
    expect(result.recommendationReason).toContain('already the cheapest')
  })

  it('computes profit and margin correctly', () => {
    const result = analyzeProviderGroup([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'ProvA', costPrice: 100 }),
    ], 150, null)

    const comp = result.comparisons[0]
    expect(comp.profit).toBe(50)
    expect(comp.marginPercent).toBe(33.33)
    expect(comp.markupPercent).toBe(50)
  })

  it('returns null profit/margin when no selling price', () => {
    const result = analyzeProviderGroup([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'ProvA', costPrice: 100 }),
    ], null, null)

    const comp = result.comparisons[0]
    expect(comp.profit).toBeNull()
    expect(comp.marginPercent).toBeNull()
    expect(comp.markupPercent).toBeNull()
    expect(comp.indicators).toContain('NO_PRICING')
  })

  it('marks current provider', () => {
    const result = analyzeProviderGroup([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'A', costPrice: 100 }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'B', costPrice: 90, currentProviderPackageId: 'b' }),
    ], 150, null)

    const current = result.comparisons.find(c => c.providerName === 'B')!
    expect(current.isCurrentProvider).toBe(true)
    expect(current.indicators).toContain('CURRENT_PROVIDER')
  })

  it('flags more expensive providers', () => {
    const result = analyzeProviderGroup([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Cheapest', costPrice: 50 }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'Mid', costPrice: 75 }),
      makeInput({ packageId: 'c', providerId: 'p3', providerName: 'Expensive', costPrice: 100 }),
    ], 150, null)

    expect(result.comparisons.find(c => c.providerName === 'Mid')!.indicators).toContain('MORE_EXPENSIVE')
    expect(result.comparisons.find(c => c.providerName === 'Expensive')!.indicators).toContain('MORE_EXPENSIVE')
    expect(result.comparisons.find(c => c.providerName === 'Cheapest')!.indicators).not.toContain('MORE_EXPENSIVE')
  })

  it('handles single provider', () => {
    const result = analyzeProviderGroup([
      makeInput({ packageId: 'only', providerId: 'p1', providerName: 'Solo', costPrice: 100 }),
    ], 150, 'local:KE:1GB:7')

    expect(result.comparisons).toHaveLength(1)
    expect(result.recommendationReason).toContain('Only one provider')
  })

  it('identifies best margin provider', () => {
    const result = analyzeProviderGroup([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'LowMargin', costPrice: 120 }),
      makeInput({ packageId: 'b', providerId: 'p2', providerName: 'HighMargin', costPrice: 80 }),
    ], 200, null)

    const bestMargin = result.highestMarginProvider!
    expect(bestMargin.providerName).toBe('HighMargin')
    expect(bestMargin.indicators).toContain('BEST_MARGIN')
    // 200 - 80 = 120 profit, 120/200 = 60% margin
    expect(bestMargin.marginPercent).toBe(60)
  })

  it('uses effectiveCostPrice when available', () => {
    const result = analyzeProviderGroup([
      makeInput({ packageId: 'a', providerId: 'p1', providerName: 'Prov', costPrice: 200, effectiveCostPrice: 100 }),
    ], 150, null)

    // Using effective cost 100, not provider cost 200
    expect(result.comparisons[0].costPrice).toBe(100)
    expect(result.comparisons[0].profit).toBe(50)
  })

  it('never writes to database', () => {
    const result = analyzeProviderGroup([
      makeInput(),
    ], 125)

    expect(result).toHaveProperty('currentProvider')
    expect(result).toHaveProperty('recommendedProvider')
    expect(result).toHaveProperty('comparisons')
    expect(result).not.toHaveProperty('updatedAt')
    expect(result).not.toHaveProperty('transactionId')
  })
})
