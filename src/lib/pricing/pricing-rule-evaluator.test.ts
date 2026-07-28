import { describe, it, expect } from 'vitest'
import {
  inferPricingStrategy,
  extractPricingValue,
  doesRuleMatchPackage,
  describeMatchedConditions,
  describeSkipReason,
  evaluateRule,
  evaluatePackageRules,
} from './pricing-rule-evaluator'
import type { PricingRuleSummary, ProviderPackageSummary } from './types'

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

function makePkg(overrides: Partial<ProviderPackageSummary> = {}): ProviderPackageSummary {
  return {
    id: 'pkg-1',
    name: 'Test Package',
    providerId: null,
    country: null,
    region: null,
    dataGB: 5,
    validityDays: 30,
    costPrice: 10,
    sellingPrice: null,
    markupPercent: null,
    configurationStatus: 'UNCONFIGURED',
    publishStatus: 'DRAFT',
    autoConfiguredByRuleId: null,
    lastConfiguredAt: null,
    ...overrides,
  }
}

describe('inferPricingStrategy', () => {
  it('detects FIXED_SELLING_PRICE when fixedPrice is set', () => {
    expect(inferPricingStrategy(makeRule({ fixedPrice: 150 }))).toBe('FIXED_SELLING_PRICE')
  })

  it('detects MARKUP_PERCENT when only markup is set', () => {
    expect(inferPricingStrategy(makeRule({ markupPercent: 25, fixedPrice: null }))).toBe('MARKUP_PERCENT')
  })

  it('defaults to MARKUP_PERCENT when nothing is set', () => {
    expect(inferPricingStrategy(makeRule({ markupPercent: null, fixedPrice: null }))).toBe('MARKUP_PERCENT')
  })

  it('prefers FIXED_SELLING_PRICE when both are set', () => {
    const result = inferPricingStrategy(makeRule({ markupPercent: 25, fixedPrice: 150 }))
    expect(result).toBe('FIXED_SELLING_PRICE')
  })
})

describe('extractPricingValue', () => {
  it('returns fixedPrice when set', () => {
    expect(extractPricingValue(makeRule({ fixedPrice: 150 }))).toBe(150)
  })

  it('returns markupPercent when fixedPrice is not set', () => {
    expect(extractPricingValue(makeRule({ markupPercent: 30, fixedPrice: null }))).toBe(30)
  })

  it('returns null when neither is set', () => {
    expect(extractPricingValue(makeRule({ markupPercent: null, fixedPrice: null }))).toBeNull()
  })

  it('returns null when values are zero', () => {
    expect(extractPricingValue(makeRule({ fixedPrice: 0, markupPercent: null }))).toBeNull()
  })
})

describe('doesRuleMatchPackage', () => {
  it('matches when no criteria are set', () => {
    expect(doesRuleMatchPackage(makeRule(), makePkg())).toBe(true)
  })

  it('matches when provider matches', () => {
    expect(doesRuleMatchPackage(
      makeRule({ providerId: 'prov-A' }),
      makePkg({ providerId: 'prov-A' }),
    )).toBe(true)
  })

  it('rejects when provider differs', () => {
    expect(doesRuleMatchPackage(
      makeRule({ providerId: 'prov-A' }),
      makePkg({ providerId: 'prov-B' }),
    )).toBe(false)
  })

  it('matches when country matches', () => {
    expect(doesRuleMatchPackage(
      makeRule({ country: 'KE' }),
      makePkg({ country: 'KE' }),
    )).toBe(true)
  })

  it('rejects when country differs', () => {
    expect(doesRuleMatchPackage(
      makeRule({ country: 'KE' }),
      makePkg({ country: 'TZ' }),
    )).toBe(false)
  })

  it('matches when region matches', () => {
    expect(doesRuleMatchPackage(
      makeRule({ region: 'Africa' }),
      makePkg({ region: 'Africa' }),
    )).toBe(true)
  })

  it('rejects when region differs', () => {
    expect(doesRuleMatchPackage(
      makeRule({ region: 'Africa' }),
      makePkg({ region: 'Asia' }),
    )).toBe(false)
  })

  it('rejects when data is below minimum', () => {
    expect(doesRuleMatchPackage(
      makeRule({ dataMinGB: 10 }),
      makePkg({ dataGB: 5 }),
    )).toBe(false)
  })

  it('matches when data is at minimum', () => {
    expect(doesRuleMatchPackage(
      makeRule({ dataMinGB: 5 }),
      makePkg({ dataGB: 5 }),
    )).toBe(true)
  })

  it('rejects when data exceeds maximum', () => {
    expect(doesRuleMatchPackage(
      makeRule({ dataMaxGB: 3 }),
      makePkg({ dataGB: 5 }),
    )).toBe(false)
  })

  it('rejects when validity is below minimum', () => {
    expect(doesRuleMatchPackage(
      makeRule({ validityMinDays: 7 }),
      makePkg({ validityDays: 3 }),
    )).toBe(false)
  })

  it('matches when validity is at minimum', () => {
    expect(doesRuleMatchPackage(
      makeRule({ validityMinDays: 7 }),
      makePkg({ validityDays: 7 }),
    )).toBe(true)
  })

  it('matches with primitive objects (no type required)', () => {
    expect(doesRuleMatchPackage(
      makeRule({ country: 'UG' }),
      { country: 'UG' },
    )).toBe(true)
  })
})

describe('describeMatchedConditions', () => {
  it('lists matched conditions', () => {
    const conditions = describeMatchedConditions(
      makeRule({ country: 'KE', dataMinGB: 1 }),
      makePkg({ country: 'KE', dataGB: 5 }),
    )
    expect(conditions).toContain('Country: KE')
    expect(conditions).toContain('Data ≥ 1GB')
  })

  it('returns generic message when no criteria', () => {
    const conditions = describeMatchedConditions(makeRule(), makePkg())
    expect(conditions).toContain('No specific criteria (matches all)')
  })
})

describe('describeSkipReason', () => {
  it('explains provider mismatch', () => {
    const reason = describeSkipReason(
      makeRule({ providerId: 'prov-A' }),
      makePkg({ providerId: 'prov-B' }),
    )
    expect(reason).toContain('Provider mismatch')
  })

  it('explains data too low', () => {
    const reason = describeSkipReason(
      makeRule({ dataMinGB: 10 }),
      makePkg({ dataGB: 5 }),
    )
    expect(reason).toContain('Data too low')
  })
})

describe('evaluateRule', () => {
  it('returns matched result for matching rule', () => {
    const result = evaluateRule({
      rule: makeRule({ markupPercent: 25 }),
      pkg: makePkg({ costPrice: 100 }),
    })
    expect(result.matched).toBe(true)
    expect(result.strategy).toBe('MARKUP_PERCENT')
    expect(result.pricingValue).toBe(25)
    expect(result.effectiveCost).toBe(100)
  })

  it('returns unmatched result for non-matching rule', () => {
    const result = evaluateRule({
      rule: makeRule({ country: 'KE' }),
      pkg: makePkg({ country: 'TZ' }),
    })
    expect(result.matched).toBe(false)
    expect(result.skipReason).toContain('Country mismatch')
  })

  it('uses rule cost override when set', () => {
    const result = evaluateRule({
      rule: makeRule({ costPrice: 200, markupPercent: 25 }),
      pkg: makePkg({ costPrice: 100 }),
    })
    expect(result.matched).toBe(true)
    expect(result.effectiveCost).toBe(200)
  })

  it('returns null effectiveCost when both cost and rule cost are zero', () => {
    const result = evaluateRule({
      rule: makeRule({ markupPercent: 25, costPrice: 0 }),
      pkg: makePkg({ costPrice: 0 }),
    })
    expect(result.matched).toBe(true)
    expect(result.effectiveCost).toBeNull()
  })
})

describe('evaluatePackageRules', () => {
  it('selects highest priority matching rule', () => {
    const highPri = makeRule({ id: 'high', priority: 100, markupPercent: 30 })
    const lowPri = makeRule({ id: 'low', priority: 50, markupPercent: 10 })

    const result = evaluatePackageRules([highPri, lowPri], makePkg({ costPrice: 100 }))
    expect(result.winner).not.toBeNull()
    expect(result.winner!.ruleId).toBe('high')
    expect(result.winner!.pricingValue).toBe(30)
  })

  it('skips non-matching rules and picks first match', () => {
    const nonMatch = makeRule({ id: 'skip', country: 'KE', priority: 100, markupPercent: 50 })
    const match = makeRule({ id: 'pick', priority: 50, markupPercent: 20 })

    const result = evaluatePackageRules([nonMatch, match], makePkg({ costPrice: 100 }))
    expect(result.winner).not.toBeNull()
    expect(result.winner!.ruleId).toBe('pick')
    expect(result.winner!.pricingValue).toBe(20)
  })

  it('returns null winner when no rules match', () => {
    const rule = makeRule({ country: 'UG', priority: 10 })
    const result = evaluatePackageRules([rule], makePkg({ country: 'KE', costPrice: 100 }))
    expect(result.winner).toBeNull()
    expect(result.evaluations.length).toBe(1)
    expect(result.evaluations[0].matched).toBe(false)
  })

  it('NEVER performs pricing calculations', () => {
    const result = evaluateRule({
      rule: makeRule({ markupPercent: 25 }),
      pkg: makePkg({ costPrice: 100 }),
    })
    // The result must NOT contain selling price, profit, margin, etc.
    expect(result).not.toHaveProperty('sellingPrice')
    expect(result).not.toHaveProperty('profit')
    expect(result).not.toHaveProperty('marginPercent')
    // It MUST contain matching metadata
    expect(result.matched).toBe(true)
    expect(result.strategy).toBeDefined()
    expect(result.pricingValue).toBeDefined()
  })
})

describe('regression: Choice 1GB 9% Markup rule', () => {
  it('exactly 1 GB data matches a 1-1 GB rule', () => {
    const rule = makeRule({ dataMinGB: 1, dataMaxGB: 1 })
    const pkg = makePkg({ dataGB: 1 })
    expect(doesRuleMatchPackage(rule, pkg)).toBe(true)
  })

  it('exactly 20 days validity matches a 1-20 day rule', () => {
    const rule = makeRule({ validityMinDays: 1, validityMaxDays: 20 })
    const pkg = makePkg({ validityDays: 20 })
    expect(doesRuleMatchPackage(rule, pkg)).toBe(true)
  })

  it('exactly 1 day validity matches a 1-20 day rule', () => {
    const rule = makeRule({ validityMinDays: 1, validityMaxDays: 20 })
    const pkg = makePkg({ validityDays: 1 })
    expect(doesRuleMatchPackage(rule, pkg)).toBe(true)
  })

  it('provider matching uses providerId', () => {
    const rule = makeRule({ providerId: 'cmpm-choice-id' })
    const pkg = makePkg({ providerId: 'cmpm-choice-id' })
    expect(doesRuleMatchPackage(rule, pkg)).toBe(true)
  })

  it('provider mismatch rejects correctly', () => {
    const rule = makeRule({ providerId: 'cmpm-choice-id' })
    const pkg = makePkg({ providerId: 'different-prov' })
    expect(doesRuleMatchPackage(rule, pkg)).toBe(false)
  })

  it('evaluator correctly infers 9% markup strategy and value', () => {
    const rule = makeRule({ markupPercent: 9, fixedPrice: null })
    expect(inferPricingStrategy(rule)).toBe('MARKUP_PERCENT')
    expect(extractPricingValue(rule)).toBe(9)
  })
})
