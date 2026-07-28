import { describe, it, expect } from 'vitest'
import {
  roundMoney,
  roundPercentage,
  validatePricing,
  validatePricingInput,
  calculatePricing,
  derivePricing,
  markSellingPriceByPercent,
  computeMarkupFromCostAndSell,
  computeMarginFromCostAndSell,
  computeMarginAmount,
  explainPricing,
  simulatePricing,
  applyPriceConstraints,
  applyTax,
  convertCurrency,
  applyDiscount,
} from './pricing-engine'
import type { PricingContext } from './types'

describe('roundMoney', () => {
  it('rounds to 2 decimal places', () => {
    expect(roundMoney(1.234)).toBe(1.23)
    expect(roundMoney(1.235)).toBe(1.24)
    expect(roundMoney(1.2)).toBe(1.2)
    expect(roundMoney(0)).toBe(0)
    expect(roundMoney(-1.555)).toBe(-1.55)
  })

  it('handles very small values', () => {
    expect(roundMoney(0.001)).toBe(0)
    expect(roundMoney(0.005)).toBe(0.01)
  })
})

describe('roundPercentage', () => {
  it('rounds to 2 decimal places', () => {
    expect(roundPercentage(25.555)).toBe(25.56)
    expect(roundPercentage(25.554)).toBe(25.55)
    expect(roundPercentage(0)).toBe(0)
    expect(roundPercentage(100)).toBe(100)
  })
})

describe('validatePricing', () => {
  it('accepts valid pricing', () => {
    const result = validatePricing(10, 15, 'MARKUP_PERCENT')
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects NaN cost', () => {
    const result = validatePricing(NaN, 15, 'MARKUP_PERCENT')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Cost must be a valid finite number')
  })

  it('rejects NaN selling price', () => {
    const result = validatePricing(10, NaN, 'MARKUP_PERCENT')
    expect(result.valid).toBe(false)
  })

  it('rejects Infinity', () => {
    const result = validatePricing(Infinity, 15, 'MARKUP_PERCENT')
    expect(result.valid).toBe(false)
  })

  it('rejects negative cost', () => {
    const result = validatePricing(-5, 15, 'MARKUP_PERCENT')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Cost cannot be negative')
  })

  it('rejects negative selling price', () => {
    const result = validatePricing(10, -5, 'MARKUP_PERCENT')
    expect(result.valid).toBe(false)
  })

  it('rejects selling below cost', () => {
    const result = validatePricing(10, 5, 'MARKUP_PERCENT')
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('below cost'))).toBe(true)
  })

  it('rejects zero cost for percentage strategies', () => {
    const result = validatePricing(0, 15, 'MARKUP_PERCENT')
    expect(result.valid).toBe(false)
  })
})

describe('validatePricingInput', () => {
  it('accepts valid 25% markup', () => {
    const result = validatePricingInput({ cost: 100, strategy: 'MARKUP_PERCENT', value: 25 })
    expect(result.valid).toBe(true)
  })

  it('accepts valid 20% margin', () => {
    const result = validatePricingInput({ cost: 100, strategy: 'MARGIN_PERCENT', value: 20 })
    expect(result.valid).toBe(true)
  })

  it('rejects 100%+ margin', () => {
    const result = validatePricingInput({ cost: 100, strategy: 'MARGIN_PERCENT', value: 100 })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('less than 100%'))).toBe(true)
  })

  it('rejects 120% margin', () => {
    const result = validatePricingInput({ cost: 100, strategy: 'MARGIN_PERCENT', value: 120 })
    expect(result.valid).toBe(false)
  })

  it('rejects fixed selling price below cost', () => {
    const result = validatePricingInput({ cost: 100, strategy: 'FIXED_SELLING_PRICE', value: 50 })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('below cost'))).toBe(true)
  })

  it('rejects NaN cost', () => {
    const result = validatePricingInput({ cost: NaN, strategy: 'MARKUP_PERCENT', value: 25 })
    expect(result.valid).toBe(false)
  })

  it('rejects negative value', () => {
    const result = validatePricingInput({ cost: 100, strategy: 'MARKUP_PERCENT', value: -10 })
    expect(result.valid).toBe(false)
  })
})

describe('calculatePricing', () => {
  describe('MARKUP_PERCENT', () => {
    it('25% markup on $100 gives $125 selling price', () => {
      const result = calculatePricing({ cost: 100, strategy: 'MARKUP_PERCENT', value: 25 })
      expect(result.sellingPrice).toBe(125)
      expect(result.profit).toBe(25)
      expect(result.markupPercent).toBe(25)
      expect(result.marginPercent).toBe(20)
    })

    it('0% markup returns cost as selling price', () => {
      const result = calculatePricing({ cost: 50, strategy: 'MARKUP_PERCENT', value: 0 })
      expect(result.sellingPrice).toBe(50)
      expect(result.profit).toBe(0)
      expect(result.markupPercent).toBe(0)
      expect(result.marginPercent).toBe(0)
    })

    it('100% markup doubles the price', () => {
      const result = calculatePricing({ cost: 100, strategy: 'MARKUP_PERCENT', value: 100 })
      expect(result.sellingPrice).toBe(200)
      expect(result.profit).toBe(100)
    })

    it('50% markup on $10', () => {
      const result = calculatePricing({ cost: 10, strategy: 'MARKUP_PERCENT', value: 50 })
      expect(result.sellingPrice).toBe(15)
      expect(result.profit).toBe(5)
      expect(result.markupPercent).toBe(50)
      expect(result.marginPercent).toBeCloseTo(33.33, 1)
    })
  })

  describe('MARGIN_PERCENT', () => {
    it('20% margin on $100 gives $125 selling price', () => {
      const result = calculatePricing({ cost: 100, strategy: 'MARGIN_PERCENT', value: 20 })
      expect(result.sellingPrice).toBe(125)
      expect(result.profit).toBe(25)
      expect(result.markupPercent).toBe(25)
      expect(result.marginPercent).toBe(20)
    })

    it('50% margin on $50 gives $100 selling price', () => {
      const result = calculatePricing({ cost: 50, strategy: 'MARGIN_PERCENT', value: 50 })
      expect(result.sellingPrice).toBe(100)
      expect(result.profit).toBe(50)
      expect(result.markupPercent).toBe(100)
      expect(result.marginPercent).toBe(50)
    })

    it('0% margin returns cost as selling price', () => {
      const result = calculatePricing({ cost: 75, strategy: 'MARGIN_PERCENT', value: 0 })
      expect(result.sellingPrice).toBe(75)
      expect(result.profit).toBe(0)
      expect(result.markupPercent).toBe(0)
    })
  })

  describe('FIXED_SELLING_PRICE', () => {
    it('$150 fixed on $100 cost gives $50 profit and 50% markup', () => {
      const result = calculatePricing({ cost: 100, strategy: 'FIXED_SELLING_PRICE', value: 150 })
      expect(result.sellingPrice).toBe(150)
      expect(result.profit).toBe(50)
      expect(result.markupPercent).toBe(50)
      expect(result.marginPercent).toBeCloseTo(33.33, 1)
    })

    it('fixed price equal to cost gives zero profit', () => {
      const result = calculatePricing({ cost: 200, strategy: 'FIXED_SELLING_PRICE', value: 200 })
      expect(result.sellingPrice).toBe(200)
      expect(result.profit).toBe(0)
      expect(result.markupPercent).toBe(0)
      expect(result.marginPercent).toBe(0)
    })
  })

  describe('FIXED_PROFIT', () => {
    it('$30 fixed profit on $100 gives $130 selling price', () => {
      const result = calculatePricing({ cost: 100, strategy: 'FIXED_PROFIT', value: 30 })
      expect(result.sellingPrice).toBe(130)
      expect(result.profit).toBe(30)
      expect(result.markupPercent).toBe(30)
      expect(result.marginPercent).toBeCloseTo(23.08, 1)
    })

    it('$0 profit keeps price at cost', () => {
      const result = calculatePricing({ cost: 50, strategy: 'FIXED_PROFIT', value: 0 })
      expect(result.sellingPrice).toBe(50)
      expect(result.profit).toBe(0)
    })
  })

  describe('rounding', () => {
    it('rounds money to 2 decimals', () => {
      const result = calculatePricing({ cost: 1.111, strategy: 'MARKUP_PERCENT', value: 33.333 })
      expect(result.sellingPrice).toBe(1.48) // 1.111 * 1.33333 = 1.481... rounded to 1.48
    })

    it('rounds percentages to 2 decimals', () => {
      const result = calculatePricing({ cost: 3, strategy: 'FIXED_SELLING_PRICE', value: 5 })
      expect(result.markupPercent).toBe(66.67)
      expect(result.marginPercent).toBe(40)
    })
  })
})

describe('derivePricing', () => {
  it('derives profit/markup/margin from cost and selling price', () => {
    const result = derivePricing(100, 150)
    expect(result.profit).toBe(50)
    expect(result.markupPercent).toBe(50)
    expect(result.marginPercent).toBeCloseTo(33.33, 1)
  })

  it('returns zero profit when selling equals cost', () => {
    const result = derivePricing(200, 200)
    expect(result.profit).toBe(0)
    expect(result.markupPercent).toBe(0)
    expect(result.marginPercent).toBe(0)
  })

  it('handles zero cost', () => {
    const result = derivePricing(0, 100)
    expect(result.profit).toBe(100)
    expect(result.markupPercent).toBe(0) // division by zero protection
    expect(result.marginPercent).toBe(100)
  })

  it('handles zero selling price', () => {
    const result = derivePricing(100, 0)
    expect(result.profit).toBe(-100)
    expect(result.markupPercent).toBe(-100)
    expect(result.marginPercent).toBe(0) // division by zero protection
  })
})

describe('markSellingPriceByPercent', () => {
  it('computes selling price from cost and markup', () => {
    expect(markSellingPriceByPercent(100, 25)).toBe(125)
    expect(markSellingPriceByPercent(50, 10)).toBe(55)
  })

  it('returns 0 for invalid cost', () => {
    expect(markSellingPriceByPercent(0, 25)).toBe(0)
    expect(markSellingPriceByPercent(-5, 25)).toBe(0)
  })

  it('returns cost when markup is 0', () => {
    expect(markSellingPriceByPercent(100, 0)).toBe(100)
  })
})

describe('computeMarkupFromCostAndSell', () => {
  it('calculates markup percentage', () => {
    expect(computeMarkupFromCostAndSell(100, 125)).toBe(25)
    expect(computeMarkupFromCostAndSell(200, 300)).toBe(50)
  })

  it('returns undefined for invalid inputs', () => {
    expect(computeMarkupFromCostAndSell(0, 100)).toBeUndefined()
    expect(computeMarkupFromCostAndSell(100, 0)).toBeUndefined()
    expect(computeMarkupFromCostAndSell(-5, 100)).toBeUndefined()
  })
})

describe('computeMarginFromCostAndSell', () => {
  it('calculates margin percentage', () => {
    expect(computeMarginFromCostAndSell(100, 125)).toBe(20)
    expect(computeMarginFromCostAndSell(50, 100)).toBe(50)
  })

  it('returns undefined when selling price is zero', () => {
    expect(computeMarginFromCostAndSell(100, 0)).toBeUndefined()
  })
})

describe('computeMarginAmount', () => {
  it('calculates margin amount', () => {
    expect(computeMarginAmount(100, 150)).toBe(50)
    expect(computeMarginAmount(50, 75)).toBe(25)
  })

  it('returns undefined for invalid inputs', () => {
    expect(computeMarginAmount(0, 100)).toBeUndefined()
    expect(computeMarginAmount(100, 0)).toBeUndefined()
  })
})

describe('explainPricing', () => {
  it('returns structured explanation with steps', () => {
    const { result, explanation } = explainPricing({ cost: 100, strategy: 'MARKUP_PERCENT', value: 25 })

    expect(result.sellingPrice).toBe(125)
    expect(explanation.strategy).toBe('MARKUP_PERCENT')
    expect(explanation.costPrice).toBe(100)
    expect(explanation.inputValue).toBe(25)
    expect(explanation.sellingPrice).toBe(125)
    expect(explanation.profit).toBe(25)
    expect(explanation.markupPercent).toBe(25)
    expect(explanation.marginPercent).toBe(20)

    expect(explanation.calculationSteps).toContain('Validated input')
    expect(explanation.calculationSteps.some(s => s.includes('MARKUP_PERCENT'))).toBe(true)
    expect(explanation.calculationSteps).toContain('Rounded all values to 2 decimal places')

    expect(explanation.calculationSteps.length).toBeGreaterThanOrEqual(4)
  })

  it('returns validation failure steps for invalid input', () => {
    const { result, explanation } = explainPricing({ cost: 0, strategy: 'MARGIN_PERCENT', value: 50 })

    expect(explanation.calculationSteps[0]).toContain('Validation failed')
    expect(result.sellingPrice).toBe(0)
  })

  it('includes context when provided', () => {
    const ctx: PricingContext = { country: 'KE', providerId: 'prov-1' }
    const { explanation } = explainPricing({ cost: 100, strategy: 'MARKUP_PERCENT', value: 25 }, ctx)

    expect(explanation.context?.country).toBe('KE')
    expect(explanation.context?.providerId).toBe('prov-1')
  })

  it('explains each strategy', () => {
    const strategies = [
      { strategy: 'MARKUP_PERCENT' as const, cost: 100, value: 25 },
      { strategy: 'MARGIN_PERCENT' as const, cost: 100, value: 20 },
      { strategy: 'FIXED_SELLING_PRICE' as const, cost: 100, value: 150 },
      { strategy: 'FIXED_PROFIT' as const, cost: 100, value: 30 },
    ]

    for (const s of strategies) {
      const { explanation } = explainPricing({ cost: s.cost, strategy: s.strategy, value: s.value })
      expect(explanation.strategy).toBe(s.strategy)
      expect(explanation.calculationSteps.length).toBeGreaterThan(0)
    }
  })
})

describe('simulatePricing', () => {
  it('returns same result as calculatePricing', () => {
    const calc = calculatePricing({ cost: 100, strategy: 'MARKUP_PERCENT', value: 25 })
    const sim = simulatePricing({ cost: 100, strategy: 'MARKUP_PERCENT', value: 25 })

    expect(sim.sellingPrice).toBe(calc.sellingPrice)
    expect(sim.profit).toBe(calc.profit)
    expect(sim.markupPercent).toBe(calc.markupPercent)
    expect(sim.marginPercent).toBe(calc.marginPercent)
  })

  it('accepts PricingContext', () => {
    const ctx: PricingContext = { country: 'TZ' }
    const sim = simulatePricing({ cost: 50, strategy: 'FIXED_PROFIT', value: 10 }, ctx)
    expect(sim.sellingPrice).toBe(60)
  })
})

describe('pipeline consistency', () => {
  it('all strategies produce consistent derived values', () => {
    const inputs = [
      { cost: 100, strategy: 'MARKUP_PERCENT' as const, value: 25 },
      { cost: 100, strategy: 'MARGIN_PERCENT' as const, value: 20 },
      { cost: 100, strategy: 'FIXED_SELLING_PRICE' as const, value: 150 },
      { cost: 100, strategy: 'FIXED_PROFIT' as const, value: 30 },
    ]

    for (const input of inputs) {
      const result = calculatePricing(input)

      // Profit should always equal sellingPrice - cost
      expect(result.profit).toBe(result.sellingPrice - result.cost)

      // markupPercent should equal (profit / cost) * 100
      if (result.cost > 0) {
        expect(result.markupPercent).toBeCloseTo((result.profit / result.cost) * 100, 1)
      }

      // marginPercent should equal (profit / sellingPrice) * 100
      if (result.sellingPrice > 0) {
        expect(result.marginPercent).toBeCloseTo((result.profit / result.sellingPrice) * 100, 1)
      }
    }
  })
})

describe('future hooks', () => {
  describe('applyPriceConstraints', () => {
    it('enforces minimum price', () => {
      expect(applyPriceConstraints(5, { minimumPrice: 10 })).toBe(10)
    })

    it('enforces maximum price', () => {
      expect(applyPriceConstraints(200, { maximumPrice: 150 })).toBe(150)
    })

    it('enforces both floor and ceiling', () => {
      expect(applyPriceConstraints(5, { minimumPrice: 10, maximumPrice: 100 })).toBe(10)
      expect(applyPriceConstraints(200, { minimumPrice: 10, maximumPrice: 100 })).toBe(100)
    })

    it('passes through when within constraints', () => {
      expect(applyPriceConstraints(50, { minimumPrice: 10, maximumPrice: 100 })).toBe(50)
    })

    it('returns original price when constraints are null', () => {
      expect(applyPriceConstraints(50, undefined)).toBe(50)
      expect(applyPriceConstraints(50, null as any)).toBe(50)
    })
  })

  describe('applyTax', () => {
    it('applies 20% tax', () => {
      expect(applyTax(100, 0.2)).toBe(120)
    })

    it('applies 0% tax', () => {
      expect(applyTax(100, 0)).toBe(100)
    })

    it('rounds to 2 decimals', () => {
      expect(applyTax(33.333, 0.1)).toBe(36.67)
    })
  })

  describe('convertCurrency', () => {
    it('converts USD to EUR at 0.85 rate', () => {
      expect(convertCurrency(100, 0.85)).toBe(85)
    })

    it('rounds to 2 decimals', () => {
      expect(convertCurrency(10, 1.23456)).toBe(12.35)
    })
  })

  describe('applyDiscount', () => {
    it('applies 10% discount', () => {
      expect(applyDiscount(100, 10)).toBe(90)
    })

    it('applies 100% discount', () => {
      expect(applyDiscount(100, 100)).toBe(0)
    })

    it('returns 0 for over-100% discount', () => {
      expect(applyDiscount(100, 120)).toBe(0)
    })

    it('applies 0% discount (no change)', () => {
      expect(applyDiscount(100, 0)).toBe(100)
    })
  })
})
