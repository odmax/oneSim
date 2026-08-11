import { prisma } from '@/lib/prisma'
import { getPackagePurchaseReadiness } from './purchase-readiness'
import { isCapabilityExposedToPortal, isCapabilityExposedToApi } from '@/lib/providers/capabilities/exposure'
import { ProviderCapability } from '@/lib/providers/capabilities/types'

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
} as const

/**
 * Shared query returning only packages that pass centralized purchase readiness.
 * Optionally filters by PURCHASE capability exposure (Portal or API context).
 */
export async function queryPurchasablePackages(context?: 'portal' | 'api') {
  const all = await prisma.eSIMPackage.findMany({
    where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    include: READINESS_INCLUDE,
    orderBy: { priceUSD: 'asc' },
  })

  const ready = all.filter(pkg => {
    const readiness = getPackagePurchaseReadiness({
      pkg: { isActive: pkg.isActive, hiddenFromCatalog: pkg.hiddenFromCatalog, archivedAt: pkg.archivedAt, source: pkg.source, providerPackageId: pkg.providerPackageId },
      providerPkg: pkg.providerPackage,
      provider: pkg.provider,
    })
    return readiness.ready
  })

  // Capability exposure filter
  if (context && ready.length > 0) {
    const filtered: typeof ready = []
    for (const pkg of ready) {
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

  return ready
}
