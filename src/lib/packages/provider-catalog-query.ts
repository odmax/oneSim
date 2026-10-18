export interface ProviderCatalogSearchParams {
  provider?: string
  publishStatus?: string
  configStatus?: string
  search?: string
  country?: string
  costFilter?: string
}

/** SQL-level filters only; canonical administrative state is applied later. */
export function buildProviderCatalogWhere(params: ProviderCatalogSearchParams): Record<string, unknown> {
  const where: Record<string, any> = {}
  const and: Record<string, unknown>[] = []

  if (params.provider) where.providerId = params.provider
  if (params.publishStatus) where.publishStatus = params.publishStatus
  if (params.configStatus) where.configurationStatus = params.configStatus
  if (params.country) where.country = params.country
  if (params.costFilter === 'missing') and.push({ costPrice: { lte: 0 } })
  if (params.search?.trim()) {
    const query = params.search.trim()
    and.push({ OR: [
      { name: { contains: query, mode: 'insensitive' } },
      { providerPlanId: { contains: query, mode: 'insensitive' } },
      { providerPlanCode: { contains: query, mode: 'insensitive' } },
    ] })
  }
  if (and.length) where.AND = and
  return where
}
