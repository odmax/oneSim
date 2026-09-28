export interface ProviderCatalogRuleFilters {
  providerId?: string
  country?: string
  region?: string
  network?: string
  publishStatus?: string
  configurationStatus?: string
  searchQuery?: string
  hasCostPrice?: boolean
  hasSellingPrice?: boolean
  hasValidity?: boolean
  hasDataAllowance?: boolean
  includeArchived?: boolean
  includeHidden?: boolean
}

/** Build one Prisma-compatible predicate for rule preview and execution. */
export function buildApplyRuleScopeWhere(
  scope: string,
  filters: ProviderCatalogRuleFilters,
  selectedIds?: string[],
): Record<string, unknown> {
  const where: Record<string, any> = {}
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
  } else if (scope === 'configured_draft') {
    where.OR = [
      { configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] } },
      { publishStatus: 'DRAFT' },
    ]
  } else if (scope === 'all_eligible') {
    where.OR = [
      { configurationStatus: 'UNCONFIGURED' },
      { configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] } },
      { publishStatus: 'DRAFT' },
    ]
    where.publishStatus = { notIn: ['PUBLISHED', 'ARCHIVED', 'HIDDEN'] }
    scopeManaged.add('configurationStatus').add('publishStatus')
  } else if (scope === 'selected' || scope === 'search') {
    // Fail closed if called directly with an empty selection.
    where.id = { in: selectedIds ?? [] }
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

  if (filters.searchQuery?.trim()) {
    const query = filters.searchQuery.trim()
    const search = [
      { name: { contains: query, mode: 'insensitive' } },
      { providerPlanId: { contains: query, mode: 'insensitive' } },
      { providerPlanCode: { contains: query, mode: 'insensitive' } },
    ]
    // Preserve a scope OR by combining both OR groups through AND.
    if (where.OR) {
      const scopeOr = where.OR
      delete where.OR
      where.AND = [{ OR: scopeOr }, { OR: search }]
    } else {
      where.OR = search
    }
  }

  // An explicit status is authoritative. Otherwise exclude hidden/archive
  // according to the checkboxes without overwriting another status predicate.
  if (!scopeManaged.has('publishStatus') && !filters.publishStatus) {
    const excludes: string[] = []
    if (!filters.includeArchived) excludes.push('ARCHIVED')
    if (!filters.includeHidden) excludes.push('HIDDEN')
    if (excludes.length === 1) where.publishStatus = { not: excludes[0] }
    if (excludes.length === 2) where.publishStatus = { notIn: excludes }
  }

  return where
}
