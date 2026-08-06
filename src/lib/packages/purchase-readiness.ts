import { prisma } from '@/lib/prisma'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'

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
}): PackageReadiness {
  const reasons: string[] = []
  const { pkg = {}, providerPkg, provider } = params

  if (pkg.isActive === false) reasons.push('Package is inactive')
  if (pkg.hiddenFromCatalog) reasons.push('Package is hidden from catalog')
  if (pkg.archivedAt) reasons.push('Package is archived')
  if (pkg.source === 'PROVIDER_PLAN') reasons.push('Source is PROVIDER_PLAN (not purchasable)')
  if (pkg.providerPackageId !== undefined && !pkg.providerPackageId) reasons.push('No provider package linked')

  if (!providerPkg) {
    reasons.push('Provider package not found')
    return { ready: false, reasons }
  }

  if (providerPkg.costStatus !== 'VALID') reasons.push(`Cost status is ${providerPkg.costStatus || 'MISSING'} — admin cost override needed`)
  if (providerPkg.pricingStatus !== 'READY') reasons.push(`Pricing status is ${providerPkg.pricingStatus || 'COST_UNAVAILABLE'}`)
  if (providerPkg.publishStatus !== 'PUBLISHED') reasons.push(`Package not published (${providerPkg.publishStatus})`)
  if (providerPkg.configurationStatus !== 'CONFIGURED' && providerPkg.configurationStatus !== 'AUTO_CONFIGURED') reasons.push(`Configuration incomplete (${providerPkg.configurationStatus})`)

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
