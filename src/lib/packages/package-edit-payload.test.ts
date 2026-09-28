import { describe, it, expect } from 'vitest'
import { buildSinglePackageEditPayload, clampQuantity } from './package-edit-payload'

const publishedPkg = {
  costPrice: { toString: () => '0.99' },
  sellingPrice: { toString: () => '21.49' },
  sellingCurrency: 'USD',
  markupPercent: { toString: () => '30' },
  pricingMode: 'MARKUP_PERCENT',
  publishStatus: 'PUBLISHED',
  configurationStatus: 'CONFIGURED',
  notes: 'ok',
}

describe('buildSinglePackageEditPayload — same product edited twice', () => {
  it('first edit changes only the selling price and includes SELLING intent', () => {
    const payload = buildSinglePackageEditPayload(publishedPkg, {
      costPrice: '0.99',
      sellingPrice: '25,00', // comma decimal
      sellingCurrency: 'USD',
      markupPercent: '30',
      pricingMode: 'MARKUP_PERCENT',
      publishStatus: 'PUBLISHED',
      configurationStatus: 'CONFIGURED',
      notes: 'ok',
      pricingIntent: 'SELLING',
    })
    expect(payload.hasChanges).toBe(true)
    expect(payload.parsingIssues).toEqual([])
    expect(payload.data).toEqual({ sellingPrice: 25, pricingIntent: 'SELLING' })
  })

  it('second edit of the same product never re-sends PUBLISHED as a transition', () => {
    const payload = buildSinglePackageEditPayload(
      { ...publishedPkg, sellingPrice: { toString: () => '25' } },
      {
        costPrice: '0.99',
        sellingPrice: '26', // a further price tweak
        sellingCurrency: 'USD',
        markupPercent: '30',
        pricingMode: 'MARKUP_PERCENT',
        publishStatus: 'PUBLISHED',
        configurationStatus: 'CONFIGURED',
        notes: 'ok',
        pricingIntent: 'SELLING',
      },
    )
    expect(payload.hasChanges).toBe(true)
    // publishStatus is unchanged → NOT included → simple-edit path, no re-publish
    expect(payload.data.publishStatus).toBeUndefined()
    expect(payload.data).toEqual({ sellingPrice: 26, pricingIntent: 'SELLING' })
  })

  it('a no-op reopen (Save without changes) has no changes and no parse issues', () => {
    const payload = buildSinglePackageEditPayload(publishedPkg, {
      costPrice: '0.99',
      sellingPrice: '21.49',
      sellingCurrency: 'USD',
      markupPercent: '30',
      pricingMode: 'MARKUP_PERCENT',
      publishStatus: 'PUBLISHED',
      configurationStatus: 'CONFIGURED',
      notes: 'ok',
    })
    expect(payload.hasChanges).toBe(false)
  })
})

describe('buildSinglePackageEditPayload — edit product A then product B', () => {
  it('fields are bound to each package persisted snapshot (no cross-product leakage)', () => {
    const pkgA = publishedPkg
    const pkgB = {
      costPrice: { toString: () => '1.5' },
      sellingPrice: { toString: () => '9.99' },
      sellingCurrency: 'USD',
      markupPercent: { toString: () => '20' },
      pricingMode: 'MARKUP_PERCENT',
      publishStatus: 'DRAFT',
      configurationStatus: 'UNCONFIGURED',
      notes: '',
    }
    const editA = buildSinglePackageEditPayload(pkgA, { costPrice: '0.99', sellingPrice: '25,00', sellingCurrency: 'USD', markupPercent: '30', pricingMode: 'MARKUP_PERCENT', publishStatus: 'PUBLISHED', configurationStatus: 'CONFIGURED', notes: 'ok', pricingIntent: 'SELLING' })
    const editB = buildSinglePackageEditPayload(pkgB, { costPrice: '2,00', sellingPrice: '9.99', sellingCurrency: 'USD', markupPercent: '20', pricingMode: 'MARKUP_PERCENT', publishStatus: 'DRAFT', configurationStatus: 'CONFIGURED', notes: '', pricingIntent: 'COST' })
    expect(editA.data).toEqual({ sellingPrice: 25, pricingIntent: 'SELLING' })
    expect(editB.data).toEqual({ costPrice: 2, configurationStatus: 'CONFIGURED', pricingIntent: 'COST' })
  })
})

describe('buildSinglePackageEditPayload — persistence on reopen', () => {
  it('reopening loads current persisted values so a fresh save is a no-op', () => {
    const afterFirstSave = { ...publishedPkg, costPrice: { toString: () => '1.1' }, sellingPrice: { toString: () => '25' }, markupPercent: { toString: () => '25' } }
    const payload = buildSinglePackageEditPayload(afterFirstSave, {
      costPrice: '1.1',
      sellingPrice: '25',
      sellingCurrency: 'USD',
      markupPercent: '25',
      pricingMode: 'MARKUP_PERCENT',
      publishStatus: 'PUBLISHED',
      configurationStatus: 'CONFIGURED',
      notes: 'ok',
      pricingIntent: 'COST',
    })
    expect(payload.hasChanges).toBe(false)
  })
})

describe('buildSinglePackageEditPayload — decimal comma/point safety', () => {
  it('21,49 becomes 21.49 exactly, never 2149 / 21 / 0 / NaN', () => {
    const payload = buildSinglePackageEditPayload({ ...publishedPkg, sellingPrice: { toString: () => '21' } }, {
      costPrice: '0.99',
      sellingPrice: '21,49',
      sellingCurrency: 'USD',
      markupPercent: '30',
      pricingMode: 'MARKUP_PERCENT',
      publishStatus: 'PUBLISHED',
      configurationStatus: 'CONFIGURED',
      notes: 'ok',
      pricingIntent: 'SELLING',
    })
    expect(payload.hasChanges).toBe(true)
    expect(payload.data.sellingPrice).toBe(21.49)
    expect(payload.data.sellingPrice).not.toBe(2149)
    expect(payload.data.sellingPrice).not.toBe(21)
    expect(payload.data.sellingPrice).not.toBe(0)
    expect(Number.isNaN(payload.data.sellingPrice)).toBe(false)
  })

  it('garbage input is surfaced as a parsing issue, not silently coerced', () => {
    const payload = buildSinglePackageEditPayload(publishedPkg, {
      costPrice: '0.99',
      sellingPrice: 'abc',
      sellingCurrency: 'USD',
      markupPercent: '30',
      pricingMode: 'MARKUP_PERCENT',
      publishStatus: 'PUBLISHED',
      configurationStatus: 'CONFIGURED',
      notes: 'ok',
      pricingIntent: 'SELLING',
    })
    expect(payload.parsingIssues).toContain('Selling Price')
    expect(payload.data.sellingPrice).toBeUndefined()
  })
})

describe('buildSinglePackageEditPayload — idempotent fixed-price and markup updates', () => {
  it('FIXED_PRICE selling edit never re-sends markup or publish', () => {
    const fixedPkg = { ...publishedPkg, pricingMode: 'FIXED_PRICE', costPrice: { toString: () => '5' }, markupPercent: { toString: () => '0' } }
    const payload = buildSinglePackageEditPayload(fixedPkg, {
      costPrice: '5',
      sellingPrice: '50',
      sellingCurrency: 'USD',
      markupPercent: '0',
      pricingMode: 'FIXED_PRICE',
      publishStatus: 'PUBLISHED',
      configurationStatus: 'CONFIGURED',
      notes: 'ok',
      pricingIntent: 'SELLING',
    })
    expect(payload.data).toEqual({ sellingPrice: 50, pricingIntent: 'SELLING' })
  })
})

describe('buildSinglePackageEditPayload — status changes', () => {
  it('only includes publishStatus when the operator actually changes it', () => {
    const draftPkg = { ...publishedPkg, publishStatus: 'DRAFT' }
    const payload = buildSinglePackageEditPayload(draftPkg, {
      costPrice: '0.99',
      sellingPrice: '21.49',
      sellingCurrency: 'USD',
      markupPercent: '30',
      pricingMode: 'MARKUP_PERCENT',
      publishStatus: 'PUBLISHED', // operator flips to published
      configurationStatus: 'CONFIGURED',
      notes: 'ok',
      pricingIntent: 'COST',
    })
    expect(payload.data.publishStatus).toBe('PUBLISHED')
  })

  it('HIDDEN transition is a real change and gets sent', () => {
    const payload = buildSinglePackageEditPayload(publishedPkg, {
      costPrice: '0.99',
      sellingPrice: '21.49',
      sellingCurrency: 'USD',
      markupPercent: '30',
      pricingMode: 'MARKUP_PERCENT',
      publishStatus: 'HIDDEN',
      configurationStatus: 'CONFIGURED',
      notes: 'ok',
      pricingIntent: 'NONE',
    })
    expect(payload.data.publishStatus).toBe('HIDDEN')
  })
})

describe('clampQuantity', () => {
  it('clamps to 1..100 and integer', () => {
    expect(clampQuantity('1')).toBe(1)
    expect(clampQuantity('50')).toBe(50)
    expect(clampQuantity('200')).toBe(100)
    expect(clampQuantity('0')).toBe(1)
    expect(clampQuantity('-5')).toBe(1)
    expect(clampQuantity('2.5')).toBe(3)
    expect(clampQuantity('2,5')).toBe(3)
    expect(clampQuantity('')).toBe(1)
    expect(clampQuantity('abc')).toBe(1)
  })
})