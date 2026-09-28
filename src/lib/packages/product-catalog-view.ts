export const PRODUCT_CATALOG_VIEWS = [
  'all',
  'operational-live',
  'customer-visible',
  'draft-inactive',
  'needs-pricing',
] as const

export type ProductCatalogView = (typeof PRODUCT_CATALOG_VIEWS)[number]

export function resolveProductCatalogView(value?: string, legacyTab?: string): ProductCatalogView {
  if (PRODUCT_CATALOG_VIEWS.includes(value as ProductCatalogView)) {
    return value as ProductCatalogView
  }

  if (legacyTab === 'live') return 'operational-live'
  if (legacyTab === 'draft') return 'draft-inactive'
  if (legacyTab === 'needs-pricing') return 'needs-pricing'
  return 'all'
}

export function filterProductCatalogView<T extends { id: string }>(
  packages: T[],
  view: ProductCatalogView,
  groups: {
    operationalLiveIds: ReadonlySet<string>
    customerVisibleIds: ReadonlySet<string>
    draftInactiveIds: ReadonlySet<string>
    needsPricingIds: ReadonlySet<string>
  },
): T[] {
  switch (view) {
    case 'operational-live':
      return packages.filter(pkg => groups.operationalLiveIds.has(pkg.id))
    case 'customer-visible':
      return packages.filter(pkg => groups.customerVisibleIds.has(pkg.id))
    case 'draft-inactive':
      return packages.filter(pkg => groups.draftInactiveIds.has(pkg.id))
    case 'needs-pricing':
      return packages.filter(pkg => groups.needsPricingIds.has(pkg.id))
    default:
      return packages
  }
}
