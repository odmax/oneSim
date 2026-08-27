import { prisma } from '@/lib/prisma'
import { getPackagePurchaseReadiness } from './purchase-readiness'
import { isCapabilityExposedToPortal, isCapabilityExposedToApi } from '@/lib/providers/capabilities/exposure'
import { ProviderCapability } from '@/lib/providers/capabilities/types'
import { parseDecimalSafe } from '@/lib/services/catalog-price-utils'

const READINESS_INCLUDE = {
  providerPackage: {
    select: {
      country: true, region: true, normalizedCountry: true, providerRawData: true,
      costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true,
      activePriceSnapshotId: true, sellingPrice: true, costPrice: true,
      providerId: true,
    },
  },
  provider: { select: { status: true, enabledCapabilities: true, code: true, id: true } },
  providerBindings: {
    where: { isActive: true },
    select: { id: true },
  },
} as const

/**
 * Shared query returning only packages that pass centralized purchase readiness.
 * Optionally filters by PURCHASE capability exposure (Portal or API context).
 *
 * Custom multi-provider packages (no single providerPackageId, but with
 * providerBindings) use the custom-backing readiness path and keep their own
 * retail selling price (never forced to an individual backing's sellingPrice).
 */
export async function queryPurchasablePackages(context?: 'portal' | 'api') {
  const all = await prisma.eSIMPackage.findMany({
    where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    include: READINESS_INCLUDE,
    orderBy: { priceUSD: 'asc' },
  })

  const ready = all.filter(pkg => {
    const customBindingCount = (pkg.providerBindings?.length ?? 0)
    const isCustom = !pkg.providerPackageId && customBindingCount > 0
    const readiness = getPackagePurchaseReadiness({
      pkg: { isActive: pkg.isActive, hiddenFromCatalog: pkg.hiddenFromCatalog, archivedAt: pkg.archivedAt, source: pkg.source, providerPackageId: pkg.providerPackageId },
      providerPkg: pkg.providerPackage,
      provider: pkg.provider,
      ...(isCustom ? {
        customBackingCount: customBindingCount,
        customSellingPrice: parseFloat(pkg.priceUSD.toString()),
      } : {}),
    })
    return readiness.ready
  })

  // Price parity filter: exclude BOUND packages whose retail priceUSD does
  // not match the ProviderPackage sellingPrice (stale-price detection).
  // CUSTOM and unlinked packages are not checked (they keep their own price).
  const priceValid = ready.filter(pkg => {
    if (!pkg.providerPackageId || !pkg.providerPackage) return true
    const retailPrice = parseDecimalSafe(pkg.priceUSD)
    const ppSellingPrice = parseDecimalSafe(pkg.providerPackage.sellingPrice)
    if (retailPrice === null || ppSellingPrice === null) return true
    if (Math.abs(retailPrice - ppSellingPrice) >= 0.005) {
      console.warn(`[CATALOG_PRICE_PARITY] Excluding stale-price package ${pkg.id} (retail=$${retailPrice} pp=$${ppSellingPrice})`)
      return false
    }
    return true
  })

  // Capability exposure filter
  if (context && priceValid.length > 0) {
    const filtered: typeof priceValid = []
    for (const pkg of priceValid) {
      const pp = pkg.providerPackage
      const providerId = pp?.providerId || pkg.provider?.id
      if (providerId) {
        const exposed = context === 'portal'
          ? await isCapabilityExposedToPortal(providerId, ProviderCapability.PURCHASE)
          : await isCapabilityExposedToApi(providerId, ProviderCapability.PURCHASE)
        if (!exposed) continue
      }
      filtered.push(pkg)
    }
    return filtered
  }

  return priceValid
}
