import { computeMarginFromCostAndSell } from '@/lib/pricing/pricing-engine'
import { isPackagePublishEligible } from '@/lib/catalog/publish-eligibility'
import { prisma } from '@/lib/prisma'

/**
 * Provider-neutral OneSIM Custom Package Builder service.
 *
 * A custom retail package is a customer-facing OneSIM product that is fulfilled
 * by one or more existing synced `ProviderPackage` backends (priority-ordered).
 * This module owns the provider-neutral logic only: compatibility, pricing/
 * margin, and backing resolution. Provider-side package creation is NOT used
 * here (no provider connector is proven to support it).
 */

export interface CustomPackageCompatibilityInput {
  /** Custom package data allowance in GB. */
  dataGB: number
  /** Custom package validity in days. */
  validityDays: number
  /** Customer-facing coverage countries (ISO3) requested. */
  countries?: string[]
  /** Backing ProviderPackage data in GB. */
  backingDataGB: number
  /** Backing ProviderPackage validity in days. */
  backingValidityDays: number
  /** Backing ProviderPackage country coverage (ISO3 or a single country). */
  backingCountry?: string | null
  /** Backing ProviderPackage region, if any. */
  backingRegion?: string | null
}

export type CompatibilityPolicy = 'EXACT' | 'AT_LEAST'

/**
 * Provider-neutral compatibility policy.
 *
 * EXACT: backing.dataGB === custom.dataGB AND backing.validityDays === custom.validityDays.
 *        Prevents overselling/underselling semantics.
 * AT_LEAST: backing.dataGB >= custom.dataGB AND backing.validityDays >= custom.validityDays
 *        AND coverage includes the requested countries.
 *
 * Default is AT_LEAST (allows 12GB/60d to fulfill 10GB/30d). This does NOT silently
 * expose a smaller allowance to the customer — the customer still buys the custom
 * package's own 10GB/30d; the backing simply has capacity to fulfill it. Where the
 * platform cannot enforce a smaller cap, callers should use EXACT instead.
 */
export function isProviderPackageCompatible(
  input: CustomPackageCompatibilityInput,
  policy: CompatibilityPolicy = 'AT_LEAST',
): boolean {
  const { dataGB, validityDays, backingDataGB, backingValidityDays } = input
  if (policy === 'EXACT') {
    return backingDataGB === dataGB && backingValidityDays === validityDays
  }

  if (backingDataGB < dataGB) return false
  if (backingValidityDays < validityDays) return false
  return coverageIncludes(input.countries || [], input.backingCountry, input.backingRegion)
}

/**
 * Provider-neutral coverage compatibility. A backing covers the requested
 * countries only when its declared country is one of the requested countries,
 * or no countries were requested (country-agnostic custom package). A bare
 * region is NOT treated as country coverage — there is no provider-neutral
 * country→region mapping to prove it.
 */
export function coverageIncludes(
  requested: string[],
  backingCountry?: string | null,
  _backingRegion?: string | null,
): boolean {
  if (!requested || requested.length === 0) return true
  const want = requested.map(c => String(c).toUpperCase())
  if (backingCountry) {
    const countryUp = String(backingCountry).toUpperCase()
    if (want.includes(countryUp)) return true
  }
  return false
}

export interface BackingPricingInput {
  /** Backing ProviderPackage cost (provider cost). */
  providerCost: number
  /** OneSIM retail selling price. */
  sellingPrice: number
}

export interface BackingPricing {
  margin: number | null
  marginPercent: number | null
  /** Absolute profit (selling - cost). */
  profit: number | null
}

/**
 * Margin for one backing given a retail selling price (reuses canonical pricing
 * helpers). Does NOT mutate provider cost records.
 */
export function computeBackingPricing({ providerCost, sellingPrice }: BackingPricingInput): BackingPricing {
  const profit = sellingPrice - providerCost
  const marginPercent = computeMarginFromCostAndSell(providerCost, sellingPrice) ?? null
  return { margin: profit, marginPercent, profit }
}

export interface BackingProviderPackageLike {
  id: string
  providerId: string
  dataGB: number
  validityDays: number
  country?: string | null
  region?: string | null
  provider: {
    id: string
    status: string
    enabledCapabilities?: unknown
  }
  configurationStatus?: string | null
  publishStatus?: string | null
  sellingPrice?: { toString(): string } | number | null
  costPrice?: { toString(): string } | number | null
}

/**
 * Provider-neutral purchase-readiness for a backing ProviderPackage.
 * A backing is usable only when its provider is operational and the ProviderPackage
 * is configured + purchase-ready (canonical eligibility).
 */
export function isBackingPurchaseReady(b: BackingProviderPackageLike): boolean {
  const providerOk = !!b.provider && ['ACTIVE', 'DEGRADED', 'TESTING'].includes(String(b.provider.status || '').toUpperCase())
  if (!providerOk) return false
  const configStatus = b.configurationStatus || 'UNCONFIGURED'
  const publishStatus = b.publishStatus || 'DRAFT'
  if (!isPackagePublishEligible({ configurationStatus: configStatus, publishStatus })) return false
  const sell = b.sellingPrice != null ? Number(b.sellingPrice) : 0
  const cost = b.costPrice != null ? Number(b.costPrice) : 0
  return sell > 0 && cost > 0
}

export interface BackingResolutionInput {
  /** Custom retail package allowance/validity/countries. */
  dataGB: number
  validityDays: number
  countries?: string[]
  policy?: CompatibilityPolicy
  /** Candidate backings, priority-ordered by the caller. */
  candidates: BackingProviderPackageLike[]
}

export interface ResolvedBacking {
  providerPackageId: string
  providerId: string
  dataGB: number
  validityDays: number
  providerCost: number
  compatible: boolean
  purchaseReady: boolean
  reason?: string
}

/**
 * Resolve which candidate ProviderPackages may back a custom package.
 * Provider-neutral — no provider-name branching.
 */
export function resolveBackingProviders(input: BackingResolutionInput): ResolvedBacking[] {
  const policy = input.policy || 'AT_LEAST'
  return input.candidates.map(c => {
    const compatible = isProviderPackageCompatible({
      dataGB: input.dataGB,
      validityDays: input.validityDays,
      countries: input.countries,
      backingDataGB: c.dataGB,
      backingValidityDays: c.validityDays,
      backingCountry: c.country,
      backingRegion: c.region,
    }, policy)
    const purchaseReady = compatible && isBackingPurchaseReady(c)
    const reason = !compatible
      ? 'incompatible'
      : !isBackingPurchaseReady(c)
        ? 'not-purchase-ready'
        : undefined
    return {
      providerPackageId: c.id,
      providerId: c.providerId,
      dataGB: c.dataGB,
      validityDays: c.validityDays,
      providerCost: c.costPrice != null ? Number(c.costPrice) : 0,
      compatible,
      purchaseReady,
      reason,
    }
  })
}

export interface CustomPackageBacking {
  providerPackageId: string
  providerId: string
  providerName: string
  priority: number
}

/**
 * Server-side resolution of a custom retail package's active, priority-ordered
 * backing ProviderPackages that are purchase-ready. Returns [] when the retail
 * package has no purchase-ready backings (the purchase must fail cleanly).
 */
export async function resolveCustomPackageBackings(esimPackageId: string): Promise<CustomPackageBacking[]> {
  const bindings = await prisma.eSIMPackageProviderBinding.findMany({
    where: { esimPackageId, isActive: true },
    include: {
      providerPackage: {
        include: { provider: { select: { id: true, name: true, status: true, enabledCapabilities: true } } },
      },
    },
    orderBy: { priority: 'asc' },
  }).catch(() => [])

  const result: CustomPackageBacking[] = []
  for (const b of bindings) {
    const pp = b.providerPackage
    if (!pp || !isBackingPurchaseReady({
      id: pp.id,
      providerId: pp.providerId,
      dataGB: pp.dataGB,
      validityDays: pp.validityDays,
      country: pp.country,
      region: pp.region,
      provider: { id: pp.provider.id, status: pp.provider.status, enabledCapabilities: pp.provider.enabledCapabilities },
      configurationStatus: pp.configurationStatus,
      publishStatus: pp.publishStatus,
      sellingPrice: pp.sellingPrice,
      costPrice: pp.costPrice,
    })) continue
    result.push({
      providerPackageId: pp.id,
      providerId: pp.provider.id,
      providerName: pp.provider.name,
      priority: b.priority,
    })
  }
  return result
}
