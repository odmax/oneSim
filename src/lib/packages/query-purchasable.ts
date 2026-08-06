import { prisma } from '@/lib/prisma'
import { getPackagePurchaseReadiness } from './purchase-readiness'

const READINESS_INCLUDE = {
  providerPackage: {
    select: {
      country: true, region: true, normalizedCountry: true, providerRawData: true,
      costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true,
      activePriceSnapshotId: true, sellingPrice: true, costPrice: true,
    },
  },
  provider: { select: { status: true, enabledCapabilities: true, code: true } },
} as const

/**
 * Shared query returning only packages that pass centralized purchase readiness.
 * Used by both the Business Buy page and the V1 packages API.
 * Provider identity, cost, and adapter fields are never included.
 */
export async function queryPurchasablePackages() {
  const all = await prisma.eSIMPackage.findMany({
    where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    include: READINESS_INCLUDE,
    orderBy: { priceUSD: 'asc' },
  })

  return all.filter(pkg => {
    const readiness = getPackagePurchaseReadiness({
      pkg: { isActive: pkg.isActive, hiddenFromCatalog: pkg.hiddenFromCatalog, archivedAt: pkg.archivedAt, source: pkg.source, providerPackageId: pkg.providerPackageId },
      providerPkg: pkg.providerPackage,
      provider: pkg.provider,
    })
    return readiness.ready
  })
}
