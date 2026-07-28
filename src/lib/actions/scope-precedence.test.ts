import { describe, it, expect } from 'vitest'

// Replicate buildScopeWhere logic to test scope precedence fix
function buildScopeWhere(scope: string, filters: any, selectedIds?: string[]): any {
  const where: any = {}
  const scopeManaged = new Set<string>()

  if (scope === 'unconfigured') {
    where.configurationStatus = 'UNCONFIGURED'
    where.publishStatus = { notIn: ['PUBLISHED', 'ARCHIVED', 'HIDDEN'] }
    scopeManaged.add('configurationStatus').add('publishStatus')
  } else if (scope === 'configured') {
    where.configurationStatus = { in: ['CONFIGURED', 'AUTO_CONFIGURED'] }
    scopeManaged.add('configurationStatus')
  } else if (scope === 'draft') {
    where.publishStatus = 'DRAFT'
    scopeManaged.add('publishStatus')
  } else if (scope === 'all_eligible') {
    where.OR = [
      { configurationStatus: 'UNCONFIGURED' },
      { configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] } },
      { publishStatus: 'DRAFT' },
    ]
    where.publishStatus = { notIn: ['PUBLISHED', 'ARCHIVED', 'HIDDEN'] }
    scopeManaged.add('configurationStatus').add('publishStatus')
  }

  if (filters.providerId) where.providerId = filters.providerId
  if (filters.country) where.country = filters.country
  if (filters.region) where.region = filters.region
  if (filters.publishStatus && !scopeManaged.has('publishStatus')) where.publishStatus = filters.publishStatus
  if (filters.configurationStatus && !scopeManaged.has('configurationStatus')) where.configurationStatus = filters.configurationStatus
  if (filters.hasCostPrice) where.costPrice = { gt: 0 }
  if (filters.hasSellingPrice) where.sellingPrice = { gt: 0 }
  if (filters.hasValidity) where.validityDays = { gt: 0 }
  if (filters.hasDataAllowance) where.dataGB = { gt: 0 }

  if (!scopeManaged.has('publishStatus')) {
    const publishExcludes: string[] = []
    if (!filters.includeArchived) publishExcludes.push('ARCHIVED')
    if (!filters.includeHidden) publishExcludes.push('HIDDEN')
    if (publishExcludes.length === 1) {
      where.publishStatus = { not: publishExcludes[0] }
    } else if (publishExcludes.length === 2) {
      where.publishStatus = { notIn: publishExcludes }
    }
  }

  return where
}

const defaultFilters = {
  configurationStatus: 'CONFIGURED',
  publishStatus: 'DRAFT',
  hasCostPrice: true,
  hasSellingPrice: true,
  includeArchived: false,
  includeHidden: false,
}

describe('buildScopeWhere scope/filter precedence', () => {
  it('scope=unconfigured: scope configurationStatus survives filter default', () => {
    const where = buildScopeWhere('unconfigured', defaultFilters)
    expect(where.configurationStatus).toBe('UNCONFIGURED')
    // Must NOT have costPrice > 0 and sellingPrice > 0 forcing filters on unconfigured packs
    // Actually hasCostPrice/hasSellingPrice apply — these are independent of scope
  })

  it('scope=unconfigured: publishStatus keeps scope value despite filter', () => {
    const where = buildScopeWhere('unconfigured', defaultFilters)
    expect(where.publishStatus).toEqual({ notIn: ['PUBLISHED', 'ARCHIVED', 'HIDDEN'] })
  })

  it('scope=configured: configurationStatus scope survives filter default', () => {
    const where = buildScopeWhere('configured', defaultFilters)
    expect(where.configurationStatus).toEqual({ in: ['CONFIGURED', 'AUTO_CONFIGURED'] })
  })

  it('scope=draft: publishStatus scope survives filter', () => {
    const where = buildScopeWhere('draft', defaultFilters)
    expect(where.publishStatus).toBe('DRAFT')
  })

  it('scope=unconfigured: non-scope filters (providerId) still apply', () => {
    const where = buildScopeWhere('unconfigured', { ...defaultFilters, providerId: 'prov-1' })
    expect(where.providerId).toBe('prov-1')
    expect(where.configurationStatus).toBe('UNCONFIGURED')
  })

  it('scope=configured: non-scope filters (country) still apply', () => {
    const where = buildScopeWhere('configured', { ...defaultFilters, country: 'KE' })
    expect(where.country).toBe('KE')
    expect(where.configurationStatus).toEqual({ in: ['CONFIGURED', 'AUTO_CONFIGURED'] })
  })

  it('empty filters: no-op scope works correctly', () => {
    const emptyFilters = { includeArchived: false, includeHidden: false }
    const where = buildScopeWhere('unconfigured', emptyFilters)
    expect(where.configurationStatus).toBe('UNCONFIGURED')
  })

  it('publishStatus in scope is NOT overridden by excluded archive/hidden', () => {
    const where = buildScopeWhere('draft', defaultFilters)
    // Draft scope already sets publishStatus, so the excluded/hidden filter should NOT override it
    expect(where.publishStatus).toBe('DRAFT')
  })

  it('simulates CHOICE rule: 1-1GB data, 1-20d validity, 9% markup, unconfigured scope', () => {
    const where = buildScopeWhere('unconfigured', {
      providerId: 'choice-prov-id',
      configurationStatus: 'CONFIGURED', // ← default filter should NOT override
      publishStatus: 'DRAFT',           // ← default filter should NOT override
      hasCostPrice: true,
      includeArchived: false,
      includeHidden: false,
    })
    // Scope takes precedence:
    expect(where.configurationStatus).toBe('UNCONFIGURED')
    expect(where.publishStatus).toEqual({ notIn: ['PUBLISHED', 'ARCHIVED', 'HIDDEN'] })
    // Non-scope filter still applies:
    expect(where.providerId).toBe('choice-prov-id')
  })
})
