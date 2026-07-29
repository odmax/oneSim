export interface EligibilityInput {
  configurationStatus: string | null
  sellingPrice: { toString(): string } | string | number | null
  sellingCurrency: string | null
  publishStatus: string | null
  isAvailable: boolean
  excludedFromCheapest: boolean
  excludedFromAutoPick: boolean
  costPrice: { toString(): string } | string | number | null
  effectiveCostPrice: number | null
  provider?: { status?: string | null } | null
  publishedAs?: { archivedAt?: Date | string | null; hiddenFromCatalog?: boolean | null } | null
}

export interface EligibilityResult {
  eligible: boolean
  reasons: string[]
  catalogHealthEligible: boolean
  cheapestCandidateEligible: boolean
  publishableEligible: boolean
}

export function checkPackageEligibility(pkg: EligibilityInput): EligibilityResult {
  const reasons: string[] = []

  const configStatus = pkg.configurationStatus
  const isConfigured = configStatus === 'CONFIGURED' || configStatus === 'AUTO_CONFIGURED'

  const sellPrice = pkg.sellingPrice
    ? typeof pkg.sellingPrice === 'object' && 'toString' in pkg.sellingPrice
      ? parseFloat(pkg.sellingPrice.toString())
      : typeof pkg.sellingPrice === 'string'
        ? parseFloat(pkg.sellingPrice)
        : Number(pkg.sellingPrice)
    : null

  const costPrice = pkg.costPrice
    ? typeof pkg.costPrice === 'object' && 'toString' in pkg.costPrice
      ? parseFloat(pkg.costPrice.toString())
      : typeof pkg.costPrice === 'string'
        ? parseFloat(pkg.costPrice)
        : Number(pkg.costPrice)
    : null

  // Catalog Health eligibility
  let catalogHealthEligible = true

  if (!isConfigured) {
    reasons.push('configurationStatus not CONFIGURED or AUTO_CONFIGURED')
    catalogHealthEligible = false
  }

  if (!sellPrice || sellPrice <= 0) {
    reasons.push('selling price missing or zero')
    catalogHealthEligible = false
  }

  if (!pkg.sellingCurrency) {
    reasons.push('selling currency missing')
    catalogHealthEligible = false
  }

  if (pkg.publishStatus === 'HIDDEN' || pkg.publishStatus === 'ARCHIVED') {
    reasons.push(`publishStatus is ${pkg.publishStatus}`)
    catalogHealthEligible = false
  }

  // Cheapest candidate eligibility
  let cheapestCandidateEligible = true

  if (!pkg.isAvailable) {
    reasons.push('unavailable (isAvailable = false)')
    cheapestCandidateEligible = false
  }

  if (pkg.excludedFromCheapest) {
    reasons.push('excluded from cheapest selection')
    cheapestCandidateEligible = false
  }

  if (pkg.provider?.status === 'INACTIVE' || pkg.provider?.status === 'ARCHIVED') {
    reasons.push(`provider status is ${pkg.provider.status}`)
    cheapestCandidateEligible = false
  }

  if (pkg.publishedAs?.archivedAt) {
    reasons.push('archived in catalog')
    cheapestCandidateEligible = false
  }

  if (pkg.publishedAs?.hiddenFromCatalog) {
    reasons.push('hidden from catalog')
    cheapestCandidateEligible = false
  }

  const effectiveCost = pkg.effectiveCostPrice ?? (costPrice && costPrice > 0 ? costPrice : null)
  if (!effectiveCost || effectiveCost <= 0) {
    reasons.push('effective cost missing or zero')
    cheapestCandidateEligible = false
  }

  // Publish eligibility
  let publishableEligible = true

  if (!isConfigured) {
    publishableEligible = false
  }
  if (!sellPrice || sellPrice <= 0) {
    publishableEligible = false
  }
  if (!pkg.sellingCurrency) {
    publishableEligible = false
  }
  if (!effectiveCost || effectiveCost <= 0) {
    publishableEligible = false
  }

  const overallEligible = catalogHealthEligible && cheapestCandidateEligible && publishableEligible

  console.log('[CATALOG_ELIGIBILITY]', JSON.stringify({
    planId: (pkg as any).id,
    eligible: overallEligible,
    reasons,
  }))

  return {
    eligible: overallEligible,
    reasons,
    catalogHealthEligible,
    cheapestCandidateEligible,
    publishableEligible,
  }
}
