import { describe, expect, it } from 'vitest'
import { filterProductCatalogView, resolveProductCatalogView } from './product-catalog-view'

const packages = ['all-1', 'live-1', 'visible-1', 'draft-1', 'pricing-1'].map(id => ({ id }))
const groups = {
  operationalLiveIds: new Set(['live-1', 'visible-1']),
  customerVisibleIds: new Set(['visible-1']),
  draftInactiveIds: new Set(['draft-1']),
  needsPricingIds: new Set(['pricing-1']),
}

describe('product catalog card views', () => {
  it.each([
    ['all', ['all-1', 'live-1', 'visible-1', 'draft-1', 'pricing-1']],
    ['operational-live', ['live-1', 'visible-1']],
    ['customer-visible', ['visible-1']],
    ['draft-inactive', ['draft-1']],
    ['needs-pricing', ['pricing-1']],
  ] as const)('filters the complete population for %s', (view, expected) => {
    expect(filterProductCatalogView(packages, view, groups).map(pkg => pkg.id)).toEqual(expected)
  })

  it('defaults to all and accepts legacy tab URLs', () => {
    expect(resolveProductCatalogView()).toBe('all')
    expect(resolveProductCatalogView('customer-visible')).toBe('customer-visible')
    expect(resolveProductCatalogView(undefined, 'live')).toBe('operational-live')
    expect(resolveProductCatalogView(undefined, 'draft')).toBe('draft-inactive')
    expect(resolveProductCatalogView(undefined, 'needs-pricing')).toBe('needs-pricing')
  })
})
