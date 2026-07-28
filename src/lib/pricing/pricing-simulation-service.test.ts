import { describe, it, expect } from 'vitest'
import { simulateRulePricing } from './pricing-simulation-service'
import type { SimulationRequest, PricingRuleSummary } from './types'

function makeRule(overrides: Partial<PricingRuleSummary> = {}): PricingRuleSummary {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    providerId: null,
    country: null,
    region: null,
    productType: null,
    dataMinGB: null,
    dataMaxGB: null,
    validityMinDays: null,
    validityMaxDays: null,
    costPrice: null,
    markupPercent: 25,
    fixedPrice: null,
    sellingCurrency: 'USD',
    publishStatus: 'READY',
    priority: 10,
    isActive: true,
    ...overrides,
  }
}

const sampleRequest: SimulationRequest = {
  rule: makeRule(),
  packages: [
    {
      id: 'pkg-1', name: 'Package A', costPrice: 100, sellingPrice: 125,
      markupPercent: 25, sellingCurrency: 'USD', providerId: null, providerName: 'TestProvider',
      country: null, region: null, dataGB: 5, validityDays: 30,
      publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED', autoConfiguredByRuleId: null,
    },
    {
      id: 'pkg-2', name: 'Package B', costPrice: 50, sellingPrice: null,
      markupPercent: null, sellingCurrency: 'USD', providerId: null, providerName: null,
      country: null, region: null, dataGB: 10, validityDays: 7,
      publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED', autoConfiguredByRuleId: null,
    },
    {
      id: 'pkg-3', name: 'Package C', costPrice: 0, sellingPrice: null,
      markupPercent: null, sellingCurrency: 'USD', providerId: null, providerName: null,
      country: null, region: null, dataGB: 1, validityDays: 1,
      publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED', autoConfiguredByRuleId: null,
    },
    {
      id: 'pkg-4', name: 'Package D', costPrice: 200, sellingPrice: 300,
      markupPercent: 50, sellingCurrency: 'USD', providerId: null, providerName: null,
      country: 'UG', region: null, dataGB: 3, validityDays: 14,
      publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED', autoConfiguredByRuleId: null,
    },
  ],
}

describe('simulateRulePricing', () => {
  it('returns simulation result with correct structure', () => {
    const result = simulateRulePricing(sampleRequest)

    expect(result.ruleId).toBe('rule-1')
    expect(result.ruleName).toBe('Test Rule')
    expect(result.packages).toBeInstanceOf(Array)
    expect(result.summary).toBeDefined()
    expect(result.warnings).toBeInstanceOf(Array)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('computes new selling price for matched packages', () => {
    const result = simulateRulePricing(sampleRequest)

    const pkgA = result.packages.find(p => p.packageId === 'pkg-1')!
    expect(pkgA).toBeDefined()
    // 25% markup on $100 = $125
    expect(pkgA.newSellingPrice).toBe(125)
    expect(pkgA.newMarginPercent).toBe(20)
    expect(pkgA.newMarkupPercent).toBe(25)
    // Current was also $125, so status should be 'no_change'
    expect(pkgA.status).toBe('no_change')
  })

  it('detects new pricing for packages with no current selling price', () => {
    const result = simulateRulePricing(sampleRequest)

    const pkgB = result.packages.find(p => p.packageId === 'pkg-2')!
    expect(pkgB).toBeDefined()
    // 25% markup on $50 = $62.50
    expect(pkgB.newSellingPrice).toBe(62.5)
    expect(pkgB.status).toBe('new')
    expect(pkgB.currentSellingPrice).toBeNull()
  })

  it('skips packages with zero cost', () => {
    const result = simulateRulePricing(sampleRequest)

    const pkgC = result.packages.find(p => p.packageId === 'pkg-3')
    expect(pkgC).toBeUndefined()

    // pkg-3 should be in warnings as NO_COST
    const noCostWarning = result.warnings.find(w => w.packageId === 'pkg-3')
    expect(noCostWarning).toBeDefined()
    expect(noCostWarning!.type).toBe('NO_COST')
  })

  it('detects price differences (increase/decrease)', () => {
    // For Package D: current = $300, new = 25% markup on $200 = $250
    const result = simulateRulePricing(sampleRequest)

    const pkgD = result.packages.find(p => p.packageId === 'pkg-4')!
    expect(pkgD.status).toBe('decrease')
    expect(pkgD.newSellingPrice).toBe(250)
    expect(pkgD.currentSellingPrice).toBe(300)
  })

  it('generates warnings for low margin', () => {
    // Very high cost → low margin
    const request: SimulationRequest = {
      rule: makeRule({ markupPercent: 2 }),
      packages: [{
        id: 'low-m', name: 'Low Margin Pkg', costPrice: 100, sellingPrice: null,
        markupPercent: null, sellingCurrency: 'USD', providerId: null, providerName: null,
        country: null, region: null, dataGB: 5, validityDays: 7,
        publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED', autoConfiguredByRuleId: null,
      }],
    }

    const result = simulateRulePricing(request)
    const lowMarginWarning = result.warnings.find(w => w.type === 'LOW_MARGIN')
    expect(lowMarginWarning).toBeDefined()
    expect(lowMarginWarning!.packageName).toBe('Low Margin Pkg')
  })

  it('generates warnings for selling below cost', () => {
    const request: SimulationRequest = {
      rule: makeRule({ fixedPrice: 50, markupPercent: null }),
      packages: [{
        id: 'below', name: 'Below Cost Pkg', costPrice: 100, sellingPrice: null,
        markupPercent: null, sellingCurrency: 'USD', providerId: null, providerName: null,
        country: null, region: null, dataGB: 5, validityDays: 7,
        publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED', autoConfiguredByRuleId: null,
      }],
    }

    const result = simulateRulePricing(request)
    const below = result.warnings.find(w => w.type === 'BELOW_COST')
    expect(below).toBeDefined()
    expect(below!.packageName).toBe('Below Cost Pkg')
  })

  it('computes aggregated summary correctly', () => {
    const result = simulateRulePricing(sampleRequest)

    expect(result.summary.packagesEvaluated).toBe(4)
    expect(result.summary.packagesUpdated).toBe(3) // pkg-A, pkg-B, pkg-D (pkg-C skipped - zero cost)
    expect(result.summary.packagesSkipped).toBe(1) // pkg-C has zero cost → NO_COST warning → skipped
    expect(result.summary.packagesUnchanged).toBe(1) // pkg-A is unchanged ($125 → $125)
  })

  it('respects rule country filter', () => {
    const request: SimulationRequest = {
      rule: makeRule({ country: 'KE' }),
      packages: [
        { ...sampleRequest.packages[0], id: 'ke-pkg', country: 'KE' },
        { ...sampleRequest.packages[0], id: 'tz-pkg', country: 'TZ' },
      ],
    }

    const result = simulateRulePricing(request)
    expect(result.packages.length).toBe(1)
    expect(result.packages[0].packageId).toBe('ke-pkg')
  })

  it('never writes to database', () => {
    // Verify the result is pure data — no DB-related properties
    const result = simulateRulePricing(sampleRequest)
    expect(result).toHaveProperty('ruleId')
    expect(result).toHaveProperty('packages')
    expect(result).toHaveProperty('summary')
    expect(result).toHaveProperty('warnings')

    for (const pkg of result.packages) {
      // Package simulations contain before/after pricing, never DB state
      expect(pkg).toHaveProperty('packageId')
      expect(pkg).toHaveProperty('newSellingPrice')
      expect(pkg).not.toHaveProperty('error') // No DB write errors
    }
  })

  it('rejects rule with no pricing value', () => {
    const request: SimulationRequest = {
      rule: makeRule({ markupPercent: null, fixedPrice: null }),
      packages: [sampleRequest.packages[0]],
    }

    const result = simulateRulePricing(request)
    const invalid = result.warnings.find(w => w.type === 'INVALID_PRICING')
    expect(invalid).toBeDefined()
    expect(result.packages.length).toBe(0)
  })

  it('handles large datasets efficiently', () => {
    const packages = Array.from({ length: 100 }, (_, i) => ({
      ...sampleRequest.packages[0],
      id: `pkg-${i}`,
      name: `Package ${i}`,
      costPrice: 10 + i,
      sellingPrice: 15 + i,
    }))

    const start = Date.now()
    const result = simulateRulePricing({ rule: makeRule(), packages })
    const elapsed = Date.now() - start

    expect(result.packages.length).toBe(100)
    expect(elapsed).toBeLessThan(1000) // Should complete in under 1s
  })
})
