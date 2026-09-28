/**
 * Admin Product Catalog statistical summary.
 *
 * Shares the EXACT predicates the Business Buy catalog and client API use so
 * the admin dashboard can never drift from client-visible reality:
 *   - Operational Live        → getPackagePurchaseReadiness (PURCHASE strict)
 *   - Customer-visible        → the canonical customer-visibility policy
 *                               (operational + price parity + portal exposure)
 *   - Draft / Inactive        → not operational for explicit lifecycle reasons
 *   - Needs Pricing           → operational retail but not ready (priced etc.)
 *
 * The gap between Operational Live and Customer-visible is always explained by
 * the aggregated `hiddenLiveReasons` list (e.g. stale retail price, provider
 * exposure OFF) so operators can repair instead of guessing.
 */

import { getPackagePurchaseReadiness } from './purchase-readiness'
import { evaluateCustomerVisibility, countOperationalReadyCustomBackings } from './customer-visibility'

export interface RetailStatsPackage {
  id: string
  isActive: boolean
  hiddenFromCatalog?: boolean | null
  archivedAt?: Date | string | null
  source?: string | null
  providerPackageId?: string | null
  priceUSD?: unknown
  providerId?: string | null
  providerPackage: {
    publishStatus?: string | null
    costStatus?: string | null
    pricingStatus?: string | null
    configurationStatus?: string | null
    activePriceSnapshotId?: string | null
    sellingPrice?: unknown
    costPrice?: unknown
    isAvailable?: boolean | null
    providerId?: string | null
  } | null
  provider?: {
    status?: string | null
    enabledCapabilities?: unknown
    code?: string | null
  } | null
  providerBindings?: Array<{
    isActive?: boolean
    providerPackage?: {
      id?: string
      providerId?: string | null
      publishStatus?: string | null
      configurationStatus?: string | null
      pricingStatus?: string | null
      costStatus?: string | null
      activePriceSnapshotId?: string | null
      sellingPrice?: unknown
      costPrice?: unknown
      isAvailable?: boolean | null
      provider?: {
        id?: string
        name?: string | null
        status?: string | null
        enabledCapabilities?: unknown
        code?: string | null
      } | null
    } | null
  }>
  _readiness?: { ready: boolean }
}

export interface CatalogStats {
  total: number
  operationalLive: number
  customerVisible: number
  draftInactive: number
  needsPricing: number
  hiddenLiveReasons: Array<{ reason: string; count: number }>
  /** IDs of operationally-live products (exact set for invariance tests). */
  operationalLiveIds: string[]
  /** IDs of customer-visible products — must equal the portal query IDs. */
  customerVisibleIds: string[]
}

export function computeCatalogStats(
  allRetail: RetailStatsPackage[],
  exposureMap: Map<string, boolean>,
): CatalogStats {
  let operationalLive = 0
  let customerVisible = 0
  let draftInactive = 0
  let needsPricing = 0
  const operationalLiveIds: string[] = []
  const customerVisibleIds: string[] = []
  const hiddenLiveReasons = new Map<string, number>()

  for (const p of allRetail) {
    const customBindingCount = p.providerBindings?.length ?? 0
    const isCustom = customBindingCount > 0 && !p.providerPackageId
    const customVerified = isCustom ? countOperationalReadyCustomBackings(p.providerBindings as any) : undefined
    const readiness = getPackagePurchaseReadiness({
      pkg: { isActive: p.isActive, hiddenFromCatalog: p.hiddenFromCatalog ?? undefined, archivedAt: p.archivedAt ? (p.archivedAt instanceof Date ? p.archivedAt : new Date(p.archivedAt)) : null, source: p.source || '', providerPackageId: p.providerPackageId },
      providerPkg: p.providerPackage as any,
      provider: p.provider
        ? { status: p.provider.status || '', enabledCapabilities: p.provider.enabledCapabilities, code: p.provider.code || null }
        : null,
      ...(customVerified !== undefined ? { customBackingCount: customVerified, customSellingPrice: parseFloat(String((p.priceUSD as any)?.toString?.() ?? p.priceUSD)) } : {}),
    })
    const live = readiness.ready
    if (live) { operationalLive++; operationalLiveIds.push(p.id) }
    else if (!p.isActive || p.hiddenFromCatalog || p.archivedAt ||
      (p.providerPackage?.publishStatus && p.providerPackage.publishStatus !== 'PUBLISHED')) draftInactive++
    else needsPricing++

    const providerId = p.providerId || p.providerPackage?.providerId || null
    const visibility = evaluateCustomerVisibility({
      pkg: {
        isActive: p.isActive,
        hiddenFromCatalog: p.hiddenFromCatalog,
        archivedAt: p.archivedAt,
        source: p.source,
        providerPackageId: p.providerPackageId,
        priceUSD: p.priceUSD as any,
      },
      providerPkg: p.providerPackage as any,
      provider: p.provider as any,
      portalExposed: providerId ? (exposureMap.get(providerId) ?? true) : true,
      ...(customVerified !== undefined ? { customBackingCount: customVerified } : {}),
    })
    if (visibility.visible) { customerVisible++; customerVisibleIds.push(p.id) }
    else if (live) {
      for (const reason of visibility.reasons) hiddenLiveReasons.set(reason, (hiddenLiveReasons.get(reason) || 0) + 1)
    }
  }

  return {
    total: allRetail.length,
    operationalLive,
    customerVisible,
    draftInactive,
    needsPricing,
    operationalLiveIds,
    customerVisibleIds,
    hiddenLiveReasons: Array.from(hiddenLiveReasons.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  }
}