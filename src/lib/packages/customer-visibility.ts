/**
 * CANONICAL CUSTOMER-VISIBILITY POLICY
 * =====================================
 *
 * The single documented policy deciding whether a retail product may be
 * surfaced to business clients (Business Buy eSIM catalog and the /api/v1
 * client API). EVERY consumer — the Buy SSR page, the client API, the admin
 * Product Catalog counts — must derive "customer visible" exclusively from
 * this module so a product is never silently reachable in one surface and
 * invisible in another.
 *
 * A retail package is CUSTOMER-VISIBLE (portal) only when ALL of:
 *
 *   1. OPERATIONAL READINESS (getPackagePurchaseReadiness, strict PURCHASE):
 *        - retail is active, not hidden, not archived, sourced
 *          CATALOG_PRODUCT/MANUAL, and linked to a ProviderPackage that is
 *          PUBLISHED, CONFIGURED/AUTO_CONFIGURED, cost VALID/OVERRIDDEN,
 *          pricing READY, has an ACTIVE price snapshot, a positive selling
 *          price, and a provider that is operational (ACTIVE/DEGRADED/
 *          TESTING) and supports PURCHASE.
 *   2. PRICE QUALITY (parity guard): a BOUND package's retail priceUSD must
 *        equal the ProviderPackage sellingPrice within 0.5¢. A stale retail
 *        price is never offered to clients (it would bill the wrong amount).
 *   3. PROVIDER EXPOSURE PRIVACY: the provider's PURCHASE capability must be
 *        exposed to the client surface (clientPortalEnabled / clientApiEnabled).
 *        This is the provider-privacy gate — a provider may operate perfectly
 *        while being intentionally invisible to clients.
 *
 * Custom multi-provider packages (no single providerPackageId, ≥1 binding)
 * keep their own retail price; the parity guard and PP-linked gates do not
 * apply to them (their backings are validated by the caller).
 *
 * Operational "Live" differs from "Customer-visible": an operationally-live
 * product that is stale-priced or provider-paused is still reported as
 * operational in the admin catalog but must be excluded from client surfaces,
 * with the exact reason surfaced so operators can repair it.
 */

import { getPackagePurchaseReadiness } from './purchase-readiness'
import { parseDecimalSafe } from '@/lib/services/catalog-price-utils'
import type { PackageReadiness } from './purchase-readiness'

/**
 * A custom-product binding whose ProviderPackage carries the full operational
 * PURCHASE readiness fields (including isAvailable) and its owning Provider.
 */
export interface RetailCustomBinding {
  isActive?: boolean
  providerPackage?: (CustomerVisibilityProviderPackage & {
    provider?: CustomerVisibilityProvider | null
  }) | null
}

/**
 * Count bindings whose ProviderPackage + Provider satisfy the COMPLETE
 * operational PURCHASE readiness policy (getPackagePurchaseReadiness, mode
 * PURCHASE): published/configured/priced/snapshot, positive selling, positive
 * cost, isAvailable!==false, provider operational, provider PURCHASE capability.
 * An active-binding count alone is NOT sufficient — that is exactly the
 * weakness this repairs. Provider-neutral: no provider-code branches, no stock
 * or inventory criterion. PURCHASE portal/API exposure is intentionally NOT
 * applied here (that belongs to the customer-surface layer only).
 */
export function countOperationalReadyCustomBackings(bindings?: Array<RetailCustomBinding | null | undefined>): number {
  let verified = 0
  for (const b of bindings || []) {
    if (!b || b.isActive === false) continue
    const pp = b.providerPackage || null
    const prov = pp?.provider || null
    const r = getPackagePurchaseReadiness({
      providerPkg: pp as any,
      provider: prov ? { status: prov.status || '', enabledCapabilities: prov.enabledCapabilities, code: prov.code || null } : null,
    })
    if (r.ready) verified++
  }
  return verified
}

export interface CustomerVisibilityPackage {
  isActive?: boolean
  hiddenFromCatalog?: boolean | null
  archivedAt?: Date | string | null
  source?: string | null
  providerPackageId?: string | null
  priceUSD?: { toString(): string } | number | null
}

export interface CustomerVisibilityProviderPackage {
  costStatus: string | null
  pricingStatus: string | null
  publishStatus: string | null
  configurationStatus: string | null
  activePriceSnapshotId: string | null
  sellingPrice: unknown
  costPrice: unknown
  isAvailable?: boolean
}

export interface CustomerVisibilityProvider {
  status: string | null
  enabledCapabilities: unknown
  code?: string | null
}

export interface CustomerVisibilityInput {
  pkg: CustomerVisibilityPackage
  providerPkg: CustomerVisibilityProviderPackage | null
  provider: CustomerVisibilityProvider | null
  /** Resolved portal PURCHASE exposure for the provider (null/undefined = default-true). */
  portalExposed: boolean | null
  /** Number of purchase-ready custom backing packages (custom-only). */
  customBackingCount?: number
}

export interface CustomerVisibilityResult {
  visible: boolean
  reasons: string[]
  readiness: PackageReadiness
  parityStale: boolean
  exposureBlocked: boolean
}

/** Parity tolerance in currency units (0.5¢). */
export const PARITY_TOLERANCE = 0.005

export function isStalePriced(pkg: CustomerVisibilityPackage, providerPkg: CustomerVisibilityProviderPackage | null): boolean {
  if (!pkg.providerPackageId || !providerPkg) return false
  const retailPrice = parseDecimalSafe(pkg.priceUSD as any)
  const ppSellingPrice = parseDecimalSafe(providerPkg.sellingPrice as any)
  if (retailPrice === null || ppSellingPrice === null) return false
  return Math.abs(retailPrice - ppSellingPrice) >= PARITY_TOLERANCE
}

export function evaluateCustomerVisibility(input: CustomerVisibilityInput): CustomerVisibilityResult {
  const { pkg, providerPkg, provider, portalExposed, customBackingCount } = input
  const reasons: string[] = []

  const readonly = getPackagePurchaseReadiness({
    pkg: {
      isActive: pkg.isActive,
      hiddenFromCatalog: pkg.hiddenFromCatalog ?? undefined,
      archivedAt: pkg.archivedAt instanceof Date ? pkg.archivedAt : (pkg.archivedAt ? new Date(pkg.archivedAt as string) : null),
      source: pkg.source || '',
      providerPackageId: pkg.providerPackageId ?? undefined,
    },
    providerPkg: providerPkg as any,
    provider: provider ? { status: provider.status || '', enabledCapabilities: provider.enabledCapabilities, code: provider.code || null } : null,
    ...(customBackingCount !== undefined ? { customBackingCount, customSellingPrice: parseDecimalSafe(pkg.priceUSD as any) || 0 } : {}),
  })
  if (!readonly.ready) reasons.push(...readonly.reasons)

  const parityStale = isStalePriced(pkg, providerPkg)
  if (parityStale) reasons.push(`Stale retail price: retail priceUSD does not match ProviderPackage sellingPrice (within ${PARITY_TOLERANCE})`)

  const exposureBlocked = portalExposed === false
  if (exposureBlocked) reasons.push('Provider PURCHASE capability is not exposed to the client portal')

  return { visible: reasons.length === 0, reasons, readiness: readonly, parityStale, exposureBlocked }
}

/**
 * Resolve portal PURCHASE exposure for many providers in one batched read.
 * Missing rows default to the documented default (PURCHASE exposed). The
 * result is identical to calling isCapabilityExposedToPortal per provider but
 * avoids the N+1 query pattern. Lives HERE so query-purchasable and the admin
 * Product Catalog share exactly the same exposure resolution.
 */
import { prisma } from '@/lib/prisma'

export async function resolvePortalExposure(providerIds: string[]): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>()
  const unique = [...new Set((providerIds || []).filter(Boolean))]
  if (!unique.length) return map

  const rows = await Promise.resolve(
  typeof prisma?.$queryRawUnsafe === 'function'
    ? prisma.$queryRawUnsafe<Array<{ providerId: string; clientPortalEnabled: boolean }>>(
        `SELECT "providerId", "clientPortalEnabled" FROM provider_capability_exposure WHERE "providerId" = ANY($1::text[]) AND capability = $2`,
        unique,
        'PURCHASE',
        )
    : Promise.resolve([]),
).catch(() => [])

  for (const row of rows) map.set(row.providerId, row.clientPortalEnabled)
  return map
}

/**
 * Build the exposure map for a retail candidate list, defaulting to exposed
 * (true) for providers that have no explicit exposure row.
 */
export async function buildPortalExposureForRetail(
  candidates: Array<{ providerId?: string | null; providerPackage?: { providerId?: string | null } | null }>,
): Promise<Map<string, boolean>> {
  const providerIds = candidates.map(c => c.providerId || c.providerPackage?.providerId || '')
  const resolved = await resolvePortalExposure(providerIds)
  const map = new Map<string, boolean>()
  for (const pid of providerIds) {
    if (pid && !map.has(pid)) map.set(pid, resolved.has(pid) ? resolved.get(pid)! : true)
  }
  return map
}