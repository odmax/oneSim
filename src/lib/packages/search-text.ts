/**
 * Build a normalized searchable text field for a package, combining its display
 * name, provider country, region, and normalized country data. This single field
 * allows a simple `includes()` check without fragile per-field OR logic.
 */
export function buildPackageSearchText(pkg: {
  displayName?: string | null
  name?: string
  providerPackage?: {
    country?: string | null
    normalizedCountry?: string | null
    region?: string | null
  } | null
}): string {
  const parts: string[] = []
  if (pkg.displayName) parts.push(pkg.displayName)
  if (pkg.name && pkg.name !== pkg.displayName) parts.push(pkg.name)
  const pp = pkg.providerPackage
  if (pp) {
    if (pp.normalizedCountry) parts.push(pp.normalizedCountry)
    if (pp.country) parts.push(pp.country)
    if (pp.region) parts.push(pp.region)
  }
  return parts.join(' | ').toLowerCase()
}
