import { describe, it, expect } from 'vitest'
import {
  PRICING_STATUS,
  resolvePricingStateOnCostSync,
  hasEstablishedPricingPolicy,
  costMateriallyChanged,
  COST_CHANGE_TOLERANCE,
} from './pricing-state'

describe('resolvePricingStateOnCostSync — canonical cost-ingestion semantics', () => {
  it('missing/invalid cost → COST_UNAVAILABLE (unchanged behavior)', () => {
    expect(resolvePricingStateOnCostSync({ costStatus: 'MISSING', providerCost: 0, previousCost: 0, existingPolicy: null }))
      .toBe(PRICING_STATUS.COST_UNAVAILABLE)
    expect(resolvePricingStateOnCostSync({ costStatus: 'INVALID', providerCost: 0, previousCost: 0, existingPolicy: null }))
      .toBe(PRICING_STATUS.COST_UNAVAILABLE)
  })

  it('valid cost + no established policy → REQUIRES_PRICING (never READY from cost alone)', () => {
    expect(resolvePricingStateOnCostSync({
      costStatus: 'VALID', providerCost: 4.5, previousCost: 0,
      existingPolicy: { configurationStatus: 'UNCONFIGURED', publishStatus: 'DRAFT' },
    })).toBe(PRICING_STATUS.REQUIRES_PRICING)
    expect(resolvePricingStateOnCostSync({
      costStatus: 'VALID', providerCost: 4.5, previousCost: 0,
      existingPolicy: null,
    })).toBe(PRICING_STATUS.REQUIRES_PRICING)
  })

  it('valid cost + established policy + materially changed cost → REQUIRES_RECALCULATION', () => {
    expect(resolvePricingStateOnCostSync({
      costStatus: 'VALID', providerCost: 4.5, previousCost: 4.0,
      existingPolicy: { markupPercent: 9, autoConfiguredByRuleId: 'rule-1' },
      existingPricingStatus: PRICING_STATUS.READY,
    })).toBe(PRICING_STATUS.REQUIRES_RECALCULATION)
  })

  it('valid cost + established policy + unchanged cost + already READY → READY (no churn)', () => {
    expect(resolvePricingStateOnCostSync({
      costStatus: 'VALID', providerCost: 4.5, previousCost: 4.5,
      existingPolicy: { markupPercent: 9 },
      existingPricingStatus: PRICING_STATUS.READY,
    })).toBe(PRICING_STATUS.READY)
  })

  it('valid cost + established policy + unchanged cost + NOT ready → REQUIRES_RECALCULATION', () => {
    expect(resolvePricingStateOnCostSync({
      costStatus: 'VALID', providerCost: 4.5, previousCost: 4.5,
      existingPolicy: { markupPercent: 9 },
      existingPricingStatus: PRICING_STATUS.REQUIRES_PRICING,
    })).toBe(PRICING_STATUS.REQUIRES_RECALCULATION)
  })
})

describe('hasEstablishedPricingPolicy', () => {
  it('true when a rule, markup, selling, snapshot, or configured/published lifecycle exists', () => {
    expect(hasEstablishedPricingPolicy({ autoConfiguredByRuleId: 'r1' })).toBe(true)
    expect(hasEstablishedPricingPolicy({ markupPercent: 9 })).toBe(true)
    expect(hasEstablishedPricingPolicy({ sellingPrice: '8.00' })).toBe(true)
    expect(hasEstablishedPricingPolicy({ activePriceSnapshotId: 'snap-1' })).toBe(true)
    expect(hasEstablishedPricingPolicy({ publishStatus: 'PUBLISHED' })).toBe(true)
    expect(hasEstablishedPricingPolicy({ configurationStatus: 'AUTO_CONFIGURED' })).toBe(true)
  })

  it('false for a bare unconfigured/draft row or null', () => {
    expect(hasEstablishedPricingPolicy(null)).toBe(false)
    expect(hasEstablishedPricingPolicy(undefined)).toBe(false)
    expect(hasEstablishedPricingPolicy({ publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED' })).toBe(false)
    expect(hasEstablishedPricingPolicy({})).toBe(false)
  })
})

describe('costMateriallyChanged + tolerance', () => {
  it('respects the platform tolerance', () => {
    expect(costMateriallyChanged(4.5, 4.5)).toBe(false)
    expect(costMateriallyChanged(4.5, 4.5 + COST_CHANGE_TOLERANCE / 2)).toBe(false)
    expect(costMateriallyChanged(4.5, 4.5 + COST_CHANGE_TOLERANCE + 0.001)).toBe(true)
    expect(costMateriallyChanged(null, 4.5)).toBe(true)
    expect(costMateriallyChanged(0, 4.5)).toBe(true)
  })
})