import { prisma } from '@/lib/prisma'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'
import { isPackagePublishEligible } from '@/lib/catalog/publish-eligibility'

// ─────────────────────────────────────────────
// Normalized purchase-ready package contract
// ─────────────────────────────────────────────

export interface PurchasableEsimPackage {
  id: string
  displayName: string
  country: string | null
  countryCode: string | null
  region: string | null
  dataGB: number
  validityDays: number
  sellingPrice: string
  currency: string
  purchaseReady: boolean
  readinessReasons: string[]
  quoteSupported: boolean
  travelDateRequired: boolean
  minQuantity: number
  maxQuantity: number | null
}

export interface PackageReadiness {
  ready: boolean
  reasons: string[]
}

/**
 * Readiness semantics.
 *
 * - 'PURCHASE'   (DEFAULT, strict): the package must already be PUBLISHED and
 *                 safe for a client to purchase. Used by every client-facing
 *                 flow: portal/API queries, purchase, quote, top-up.
 * - 'PRE_PUBLISH': the package is valid enough to TRANSITION into PUBLISHED.
 *                 Requires the same pricing/config/provider/snapshot
 *                 guarantees, but does NOT require PUBLISHED already; instead
 *                 it enforces the shared publication eligibility contract
 *                 (CONFIGURED/AUTO_CONFIGURED/READY; never HIDDEN/ARCHIVED/
 *                 UNCONFIGURED-without-READY).
 */
export type PurchaseReadinessMode = 'PURCHASE' | 'PRE_PUBLISH'

/**
 * Centralized purchase readiness check.
 * Evaluates generic conditions only — never checks provider code.
 */
export function getPackagePurchaseReadiness(params: {
  pkg?: {
    isActive?: boolean
    hiddenFromCatalog?: boolean
    archivedAt?: Date | null
    source?: string
    providerPackageId?: string | null
  }
  providerPkg: {
    costStatus: string | null
    pricingStatus: string | null
    publishStatus: string | null
    configurationStatus: string | null
    activePriceSnapshotId: string | null
    sellingPrice: any
    costPrice: any
  } | null
  provider?: {
    status: string
    enabledCapabilities: any
    code: string | null
  } | null
  mode?: PurchaseReadinessMode
}): PackageReadiness {
  const reasons: string[] = []
  const { pkg = {}, providerPkg, provider, mode = 'PURCHASE' } = params

  if (pkg.isActive === false) reasons.push('Package is inactive')
  if (pkg.hiddenFromCatalog) reasons.push('Package is hidden from catalog')
  if (pkg.archivedAt) reasons.push('Package is archived')
  if (pkg.source === 'PROVIDER_PLAN') reasons.push('Source is PROVIDER_PLAN (not purchasable)')
  if (pkg.providerPackageId !== undefined && !pkg.providerPackageId) reasons.push('No provider package linked')

  if (!providerPkg) {
    reasons.push('Provider package not found')
    return { ready: false, reasons }
  }

  const validCostStatuses = ['VALID', 'OVERRIDDEN']
  if (!validCostStatuses.includes(providerPkg.costStatus ?? '')) reasons.push(`Cost status is ${providerPkg.costStatus || 'MISSING'} — admin cost override needed`)
  if (providerPkg.pricingStatus !== 'READY') reasons.push(`Pricing status is ${providerPkg.pricingStatus || 'COST_UNAVAILABLE'}`)

  if (mode === 'PURCHASE') {
    if (providerPkg.publishStatus !== 'PUBLISHED') reasons.push(`Package not published (${providerPkg.publishStatus})`)
    if (providerPkg.configurationStatus !== 'CONFIGURED' && providerPkg.configurationStatus !== 'AUTO_CONFIGURED') reasons.push(`Configuration incomplete (${providerPkg.configurationStatus})`)
  } else {
    // PRE_PUBLISH: enforce the shared publication eligibility contract instead
    // of requiring PUBLISHED. Source states allowed to transition into PUBLISHED:
    // CONFIGURED / AUTO_CONFIGURED / READY. HIDDEN, ARCHIVED, and
    // UNCONFIGURED-without-READY fail closed. Provider-neutral.
    if (!isPackagePublishEligible({ configurationStatus: providerPkg.configurationStatus, publishStatus: providerPkg.publishStatus })) {
      reasons.push('Package is not eligible for publication (must be CONFIGURED, AUTO_CONFIGURED, or READY)')
    }
  }

  const sellingPrice = Number(providerPkg.sellingPrice || 0)
  if (sellingPrice <= 0) reasons.push('No valid selling price')

  if (!providerPkg.activePriceSnapshotId) reasons.push('No active price snapshot')

  if (provider) {
    const operationalStatuses = ['ACTIVE', 'DEGRADED', 'TESTING']
    if (!operationalStatuses.includes(provider.status)) reasons.push(`Provider is ${provider.status}`)

    const caps = (provider.enabledCapabilities || DEFAULT_PROVIDER_CAPABILITIES[provider.code || ''] || []) as string[]
    if (!caps.includes('PURCHASE')) reasons.push('Provider does not support PURCHASE')
  }

  return { ready: reasons.length === 0, reasons }
}
