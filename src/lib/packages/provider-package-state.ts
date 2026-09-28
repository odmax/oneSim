/**
 * Admin Provider Catalog administrative state classification.
 *
 * The Provider Catalog is the UPSTREAM WORKSPACE: it must retain incomplete /
 * unpublished / quarantined plans so admins can configure them. This classifier
 * presents each record in one of five clear states (never deletes or hides them).
 *
 * Precedence:
 *   1. UNAVAILABLE_QUARANTINED  isAvailable === false (fail-closed quarantine)
 *   2. READY                    full operational PURCHASE readiness
 *   3. NEEDS_CONFIGURATION      NOT configured
 *   4. NEEDS_PRICING            configured but pricing/cost/snapshot not ready
 *   5. DRAFT_UNPUBLISHED        otherwise not PUBLISHED
 *
 * Provider-neutral. PURE — unit-testable.
 */

const CONFIGURED = ['CONFIGURED', 'AUTO_CONFIGURED']

export type ProviderPackageAdminState =
  | 'UNAVAILABLE_QUARANTINED'
  | 'READY'
  | 'NEEDS_CONFIGURATION'
  | 'NEEDS_PRICING'
  | 'DRAFT_UNPUBLISHED'
  | 'BLOCKED_OTHER'

export interface ProviderPackageAdminInput {
  isAvailable?: boolean | null
  purchaseReady?: boolean
  configurationStatus?: string | null
  publishStatus?: string | null
  pricingStatus?: string | null
  activePriceSnapshotId?: string | null
  sellingPrice?: unknown
  costPrice?: unknown
}

export const PROVIDER_PACKAGE_STATE_LABELS: Record<ProviderPackageAdminState, string> = {
  UNAVAILABLE_QUARANTINED: 'Unavailable / Quarantined',
  READY: 'Ready',
  NEEDS_CONFIGURATION: 'Needs Configuration',
  NEEDS_PRICING: 'Needs Pricing',
  DRAFT_UNPUBLISHED: 'Draft / Unpublished',
  BLOCKED_OTHER: 'Blocked (other)',
}

export const PROVIDER_PACKAGE_STATE_COLORS: Record<ProviderPackageAdminState, string> = {
  UNAVAILABLE_QUARANTINED: 'bg-red-100 text-red-700',
  READY: 'bg-emerald-100 text-emerald-700',
  NEEDS_CONFIGURATION: 'bg-amber-100 text-amber-700',
  NEEDS_PRICING: 'bg-blue-100 text-blue-700',
  DRAFT_UNPUBLISHED: 'bg-gray-100 text-gray-600',
  BLOCKED_OTHER: 'bg-red-100 text-red-600',
}

function num(v: unknown): number {
  if (v === null || v === undefined) return 0
  return Number(typeof v === 'object' && typeof (v as any).toString === 'function' ? (v as any).toString() : v)
}

export function classifyProviderPackageState(p: ProviderPackageAdminInput): ProviderPackageAdminState {
  if (p.isAvailable === false) return 'UNAVAILABLE_QUARANTINED'
  if (p.purchaseReady) return 'READY'
  if (!CONFIGURED.includes(p.configurationStatus || '')) return 'NEEDS_CONFIGURATION'
  const priced =
    p.pricingStatus === 'READY' &&
    num(p.sellingPrice) > 0 &&
    num(p.costPrice) > 0 &&
    !!p.activePriceSnapshotId
  if (!priced) return 'NEEDS_PRICING'
  if (p.publishStatus !== 'PUBLISHED') return 'DRAFT_UNPUBLISHED'
  return 'BLOCKED_OTHER'
}