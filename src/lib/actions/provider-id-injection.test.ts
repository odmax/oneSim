import { describe, it, expect } from 'vitest'

// Replicate buildScopeWhere with scope-precedence + ruleProviderId injection
function buildScopeWhere(scope: string, filters: any, ruleProviderId?: string | null, selectedIds?: string[]): any {
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

  if (filters.providerId && !scopeManaged.has('providerId')) where.providerId = filters.providerId
  if (filters.country) where.country = filters.country
  if (filters.region) where.region = filters.region
  if (filters.publishStatus && !scopeManaged.has('publishStatus')) where.publishStatus = filters.publishStatus
  if (filters.configurationStatus && !scopeManaged.has('configurationStatus')) where.configurationStatus = filters.configurationStatus
  if (filters.hasCostPrice) where.costPrice = { gt: 0 }
  if (filters.hasSellingPrice) where.sellingPrice = { gt: 0 }
  if (filters.hasValidity) where.validityDays = { gt: 0 }
  if (filters.hasDataAllowance) where.dataGB = { gt: 0 }

  // Inject rule's own providerId into the WHERE clause
  if (ruleProviderId && !where.providerId) {
    where.providerId = ruleProviderId
  }

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

const CHOICE_ID = 'cmpmdgxws00004kfa0i2iqsf4'

describe('providerId injection into scope query', () => {
  it('rule providerId is injected when scope has no providerId', () => {
    const where = buildScopeWhere('unconfigured', defaultFilters, CHOICE_ID)
    expect(where.providerId).toBe(CHOICE_ID)
  })

  it('rule providerId does NOT override explicit filter providerId', () => {
    const customFilters = { ...defaultFilters, providerId: 'custom-prov' }
    const where = buildScopeWhere('unconfigured', customFilters, CHOICE_ID)
    expect(where.providerId).toBe('custom-prov')
  })

  it('rule providerId is injected for all scope types', () => {
    for (const scope of ['unconfigured', 'configured', 'draft', 'all_eligible']) {
      const where = buildScopeWhere(scope, defaultFilters, CHOICE_ID)
      expect(where.providerId).toBe(CHOICE_ID)
    }
  })

  it('null rule providerId does not inject providerId', () => {
    const where = buildScopeWhere('unconfigured', defaultFilters, null)
    expect(where.providerId).toBeUndefined()
  })

  it('scope fields are still protected from filter override', () => {
    const where = buildScopeWhere('unconfigured', defaultFilters, CHOICE_ID)
    expect(where.configurationStatus).toBe('UNCONFIGURED')
    expect(where.providerId).toBe(CHOICE_ID)
  })

  it('no-filter rules still inject providerId into query', () => {
    const where = buildScopeWhere('unconfigured', { includeArchived: false, includeHidden: false }, CHOICE_ID)
    expect(where.providerId).toBe(CHOICE_ID)
    expect(where.configurationStatus).toBe('UNCONFIGURED')
  })

  it('Choice-specific rule with 1GB, 7 days: scope + providerId combined', () => {
    const where = buildScopeWhere('unconfigured', { includeArchived: false, includeHidden: false }, CHOICE_ID)
    expect(where.providerId).toBe(CHOICE_ID)
    expect(where.configurationStatus).toBe('UNCONFIGURED')
    // The DB query now returns ONLY Choice + UNCONFIGURED packages
    // No more cross-provider matches in the in-memory loop
  })
})
