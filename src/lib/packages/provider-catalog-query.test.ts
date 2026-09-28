import { describe, expect, it } from 'vitest'
import { buildProviderCatalogWhere } from './provider-catalog-query'

describe('buildProviderCatalogWhere', () => {
  it('combines missing-cost and text search with AND', () => {
    const where = buildProviderCatalogWhere({ costFilter: 'missing', search: 'Singapore' })
    expect(where).toEqual({ AND: [
      { costPrice: { lte: 0 } },
      { OR: [
        { name: { contains: 'Singapore', mode: 'insensitive' } },
        { providerPlanId: { contains: 'Singapore', mode: 'insensitive' } },
        { providerPlanCode: { contains: 'Singapore', mode: 'insensitive' } },
      ] },
    ] })
  })

  it('combines exact dropdown filters with search', () => {
    const where = buildProviderCatalogWhere({
      provider: 'provider-1', publishStatus: 'READY', configStatus: 'CONFIGURED', country: 'ZA', search: '10GB',
    })
    expect(where.providerId).toBe('provider-1')
    expect(where.publishStatus).toBe('READY')
    expect(where.configurationStatus).toBe('CONFIGURED')
    expect(where.country).toBe('ZA')
    expect(where.AND).toHaveLength(1)
  })
})
