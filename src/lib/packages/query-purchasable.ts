import { prisma } from '@/lib/prisma'
import { getPackagePurchaseReadiness } from './purchase-readiness'
import { isCapabilityExposedToApi } from '@/lib/providers/capabilities/exposure'
import { ProviderCapability } from '@/lib/providers/capabilities/types'
import { buildPortalExposureForRetail, evaluateCustomerVisibility, isStalePriced, countOperationalReadyCustomBackings } from './customer-visibility'

const READINESS_INCLUDE = {
  providerPackage: {
    select: {
      country: true, region: true, normalizedCountry: true, providerRawData: true,
      costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true,
      activePriceSnapshotId: true, sellingPrice: true, costPrice: true,
      providerId: true, isAvailable: true,
    },
  },
  provider: { select: { status: true, enabledCapabilities: true, code: true, id: true } },
  providerBindings: {
    where: { isActive: true },
    select: {
      id: true,
      isActive: true,
      providerPackage: {
        select: {
          id: true, providerId: true, publishStatus: true, configurationStatus: true,
          pricingStatus: true, costStatus: true, activePriceSnapshotId: true,
          sellingPrice: true, costPrice: true, isAvailable: true,
          provider: { select: { id: true, name: true, status: true, enabledCapabilities: true, code: true } },
        },
      },
    },
  },
} as const

/**
 * Shared query returning only packages that pass centralized purchase readiness.
 * Optionally filters by PURCHASE capability exposure (Portal or API context).
 *
 * The PORTAL result is the canonical CUSTOMER-VISIBLE set: operational
 * readiness + price-quality parity + portal exposure (see
 * customer-visibility.ts). The API result uses the same operational readiness
 * and parity guards with the API exposure gate.
 *
 * Custom multi-provider packages (no single providerPackageId, but with
 * providerBindings) use the custom-backing readiness path and keep their own
 * retail selling price (never forced to an individual backing's sellingPrice).
 *
 * Deterministic ordering: priceUSD asc, then id asc as the tiebreaker so
 * pagination never duplicates or skips across pages.
 */
export async function queryPurchasablePackages(context?: 'portal' | 'api') {
  const all = await prisma.eSIMPackage.findMany({
    where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    include: READINESS_INCLUDE,
    orderBy: [{ priceUSD: 'asc' }, { id: 'asc' }],
  })

  const exposureMap = context === 'portal'
    ? await buildPortalExposureForRetail(all as unknown as Array<{ providerId?: string | null; providerPackage?: { providerId?: string | null } | null }>)
    : new Map<string, boolean>()

const ready: typeof all = []
  for (const pkg of all) {
    const customBindingCount = (pkg.providerBindings?.length ?? 0)
    const isCustom = !pkg.providerPackageId && customBindingCount > 0
    // Operational PURCHASE fidelity for custom products: an active-binding
    // count is NOT enough — require bindings whose ProviderPackage + Provider
    // actually satisfy the complete operational readiness policy (incl.
    // isAvailable). Exposure is applied at the customer-surface layer only.
    const customVerified = isCustom ? countOperationalReadyCustomBackings(pkg.providerBindings as any) : undefined

    if (context === 'portal') {
      // Canonical customer-visibility policy (shared with the admin Product
      // Catalog counts — one predicate, one source of truth).
      const providerId = pkg.providerPackage?.providerId || pkg.provider?.id || null
      const visibility = evaluateCustomerVisibility({
        pkg,
        providerPkg: pkg.providerPackage,
        provider: pkg.provider,
        portalExposed: providerId ? (exposureMap.get(providerId) ?? true) : true,
        ...(customVerified !== undefined ? { customBackingCount: customVerified } : {}),
      })
      if (visibility.visible) {
        ready.push(pkg)
      } else if (visibility.parityStale) {
        console.warn(`[CATALOG_PRICE_PARITY] Excluding stale-price package ${pkg.id} (retail=$` +
          `${String((pkg.priceUSD as any)?.toString?.() ?? pkg.priceUSD)} pp=$${String((pkg.providerPackage?.sellingPrice as any)?.toString?.() ?? pkg.providerPackage?.sellingPrice)})`)
      }
      continue
    }

    const readiness = getPackagePurchaseReadiness({
      pkg: { isActive: pkg.isActive, hiddenFromCatalog: pkg.hiddenFromCatalog, archivedAt: pkg.archivedAt, source: pkg.source, providerPackageId: pkg.providerPackageId },
      providerPkg: pkg.providerPackage,
      provider: pkg.provider,
      ...(customVerified !== undefined ? {
        customBackingCount: customVerified,
        customSellingPrice: parseFloat(pkg.priceUSD.toString()),
      } : {}),
    })
    if (!readiness.ready) continue

    // Price parity filter (single canonical predicate shared with the portal
    // path): exclude BOUND packages whose retail priceUSD does not match the
    // ProviderPackage sellingPrice (stale-price detection).
    if (isStalePriced(pkg, pkg.providerPackage)) continue

    if (context === 'api' && (pkg.providerPackage?.providerId || pkg.provider?.id)) {
      const providerId = pkg.providerPackage?.providerId || pkg.provider?.id
      const exposed = await isCapabilityExposedToApi(providerId!, ProviderCapability.PURCHASE)
      if (!exposed) continue
    }

    ready.push(pkg)
  }

  return ready
}
