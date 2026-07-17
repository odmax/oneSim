import { describe, it, expect } from 'vitest'
import { checkPackageEligibility } from './package-eligibility'

function makePkg(overrides: Record<string, any> = {}) {
  return {
    configurationStatus: 'CONFIGURED',
    sellingPrice: 5.00,
    sellingCurrency: 'USD',
    publishStatus: 'READY',
    isAvailable: true,
    excludedFromCheapest: false,
    excludedFromAutoPick: false,
    costPrice: 2.00,
    effectiveCostPrice: 2.00,
    provider: { status: 'ACTIVE' },
    publishedAs: null,
    ...overrides,
  }
}

describe('checkPackageEligibility', () => {
  it('returns eligible for a fully configured plan', () => {
    const result = checkPackageEligibility(makePkg())
    expect(result.eligible).toBe(true)
    expect(result.catalogHealthEligible).toBe(true)
    expect(result.cheapestCandidateEligible).toBe(true)
    expect(result.publishableEligible).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('rejects READY with missing configurationStatus', () => {
    const result = checkPackageEligibility(makePkg({ configurationStatus: 'UNCONFIGURED' }))
    expect(result.eligible).toBe(false)
    expect(result.catalogHealthEligible).toBe(false)
    expect(result.reasons).toContain('configurationStatus not CONFIGURED or AUTO_CONFIGURED')
  })

  it('rejects READY with missing selling price', () => {
    const result = checkPackageEligibility(makePkg({ sellingPrice: null }))
    expect(result.eligible).toBe(false)
    expect(result.catalogHealthEligible).toBe(false)
    expect(result.reasons).toContain('selling price missing or zero')
  })

  it('rejects READY with zero selling price', () => {
    const result = checkPackageEligibility(makePkg({ sellingPrice: 0 }))
    expect(result.eligible).toBe(false)
    expect(result.reasons).toContain('selling price missing or zero')
  })

  it('rejects READY with missing selling currency', () => {
    const result = checkPackageEligibility(makePkg({ sellingCurrency: null }))
    expect(result.eligible).toBe(false)
    expect(result.catalogHealthEligible).toBe(false)
    expect(result.reasons).toContain('selling currency missing')
  })

  it('rejects HIDDEN publishStatus', () => {
    const result = checkPackageEligibility(makePkg({ publishStatus: 'HIDDEN' }))
    expect(result.eligible).toBe(false)
    expect(result.catalogHealthEligible).toBe(false)
    expect(result.reasons).toContain('publishStatus is HIDDEN')
  })

  it('rejects ARCHIVED publishStatus', () => {
    const result = checkPackageEligibility(makePkg({ publishStatus: 'ARCHIVED' }))
    expect(result.eligible).toBe(false)
    expect(result.catalogHealthEligible).toBe(false)
    expect(result.reasons).toContain('publishStatus is ARCHIVED')
  })

  it('rejects unavailable plan (isAvailable=false)', () => {
    const result = checkPackageEligibility(makePkg({ isAvailable: false }))
    expect(result.eligible).toBe(false)
    expect(result.cheapestCandidateEligible).toBe(false)
    expect(result.reasons).toContain('unavailable (isAvailable = false)')
  })

  it('rejects excluded from cheapest', () => {
    const result = checkPackageEligibility(makePkg({ excludedFromCheapest: true }))
    expect(result.eligible).toBe(false)
    expect(result.cheapestCandidateEligible).toBe(false)
    expect(result.reasons).toContain('excluded from cheapest selection')
  })

  it('rejects inactive provider', () => {
    const result = checkPackageEligibility(makePkg({ provider: { status: 'INACTIVE' } }))
    expect(result.eligible).toBe(false)
    expect(result.cheapestCandidateEligible).toBe(false)
    expect(result.reasons).toContain('provider status is INACTIVE')
  })

  it('rejects archived provider', () => {
    const result = checkPackageEligibility(makePkg({ provider: { status: 'ARCHIVED' } }))
    expect(result.eligible).toBe(false)
    expect(result.cheapestCandidateEligible).toBe(false)
    expect(result.reasons).toContain('provider status is ARCHIVED')
  })

  it('rejects archived in catalog', () => {
    const result = checkPackageEligibility(makePkg({ publishedAs: { archivedAt: new Date().toISOString() } }))
    expect(result.eligible).toBe(false)
    expect(result.cheapestCandidateEligible).toBe(false)
    expect(result.reasons).toContain('archived in catalog')
  })

  it('rejects missing effective cost', () => {
    const result = checkPackageEligibility(makePkg({ effectiveCostPrice: null, costPrice: 0 }))
    expect(result.eligible).toBe(false)
    expect(result.cheapestCandidateEligible).toBe(false)
    expect(result.reasons).toContain('effective cost missing or zero')
  })

  it('shows multiple reasons for multi-failure plan', () => {
    const result = checkPackageEligibility(makePkg({
      configurationStatus: 'UNCONFIGURED',
      sellingPrice: null,
      sellingCurrency: null,
      publishStatus: 'HIDDEN',
      isAvailable: false,
      excludedFromCheapest: true,
    }))
    expect(result.eligible).toBe(false)
    expect(result.reasons.length).toBeGreaterThanOrEqual(4)
    expect(result.reasons).toContain('configurationStatus not CONFIGURED or AUTO_CONFIGURED')
    expect(result.reasons).toContain('selling price missing or zero')
    expect(result.reasons).toContain('selling currency missing')
    expect(result.reasons).toContain('publishStatus is HIDDEN')
  })

  it('handles sellingPrice as string', () => {
    const result = checkPackageEligibility(makePkg({ sellingPrice: '3.50' }))
    expect(result.catalogHealthEligible).toBe(true)
  })

  it('handles sellingPrice as object with toString', () => {
    const result = checkPackageEligibility(makePkg({ sellingPrice: { toString: () => '4.99' } }))
    expect(result.catalogHealthEligible).toBe(true)
  })
})
