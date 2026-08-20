import { prisma } from '@/lib/prisma'
import { isPackagePublishEligible } from '@/lib/catalog/publish-eligibility'

/**
 * Provider-neutral backing resolution for the canonical purchase flow.
 *
 * This is the single source of truth that turns a OneSIM retail package into an
 * authoritative execution backing (provider + provider-owned plan id). It is a
 * committed order/provider service so PurchaseOrchestrator never depends on the
 * (separately released) Custom Package Builder module.
 *
 * Resolution order:
 *   1. bound single ProviderPackage (pkg.providerPackageId)
 *   2. explicit multi-backing providerBindings (only when the binding model is
 *      present — see resolveExplicitBindings)
 *   3. legacy denormalized providerId+providerPlanId → a UNIQUE ProviderPackage
 *   4. otherwise → NONE (fail safe; never guess a provider or rank the retail id)
 */

export interface ResolvedBacking {
  providerPackageId: string
  providerId: string
  providerPlanId: string
}

export interface ResolvedCustomBacking {
  providerPackageId: string
  providerId: string
  providerName: string
  priority: number
}

export type PackageBackingResolution =
  | { kind: 'BOUND'; backing: ResolvedBacking }
  | { kind: 'CUSTOM'; backings: ResolvedCustomBacking[] }
  /** Bound backing is missing or deactivated (retryable refresh). */
  | { kind: 'UNAVAILABLE' }
  /** No authoritative backing could be resolved (zero/ambiguous legacy). */
  | { kind: 'NONE' }

interface BackingCandidateLike {
  id: string
  providerId: string
  provider: { id: string; name: string; status: string }
  configurationStatus?: string | null
  publishStatus?: string | null
  sellingPrice?: unknown
  costPrice?: unknown
}

/** Purchase-ready filter for a candidate backing (provider-neutral). */
function isBackingPurchaseReady(b: BackingCandidateLike): boolean {
  const providerOk = !!b.provider && ['ACTIVE', 'DEGRADED', 'TESTING'].includes(String(b.provider.status || '').toUpperCase())
  if (!providerOk) return false
  const configurationStatus = b.configurationStatus || 'UNCONFIGURED'
  const publishStatus = b.publishStatus || 'DRAFT'
  if (!isPackagePublishEligible({ configurationStatus, publishStatus })) return false
  const sell = b.sellingPrice != null ? Number(b.sellingPrice) : 0
  const cost = b.costPrice != null ? Number(b.costPrice) : 0
  return sell > 0 && cost > 0
}

/**
 * Resolve explicit multi-backing provider bindings. The binding model is
 * introduced by the Custom Package Builder schema migration; access it
 * defensively so the canonical purchase flow compiles and runs without it and
 * gains multi-backing support only when that migration is applied.
 */
async function resolveExplicitBindings(esimPackageId: string): Promise<ResolvedCustomBacking[] | null> {
  const bindingModel = (prisma as any).eSIMPackageProviderBinding as
    | { findMany(args: any): Promise<any[]> }
    | undefined
  if (!bindingModel) return null

  const bindings = await bindingModel.findMany({
    where: { esimPackageId, isActive: true },
    include: {
      providerPackage: {
        include: { provider: { select: { id: true, name: true, status: true } } },
      },
    },
    orderBy: { priority: 'asc' },
  }).catch(() => [])

  const result: ResolvedCustomBacking[] = []
  for (const b of bindings || []) {
    const pp = b?.providerPackage
    if (!pp) continue
    if (!isBackingPurchaseReady({
      id: pp.id,
      providerId: pp.providerId,
      provider: pp.provider,
      configurationStatus: pp.configurationStatus,
      publishStatus: pp.publishStatus,
      sellingPrice: pp.sellingPrice,
      costPrice: pp.costPrice,
    })) continue
    result.push({ providerPackageId: pp.id, providerId: pp.providerId, providerName: pp.provider?.name || '?', priority: b.priority })
  }
  return result
}

export async function resolvePackageBacking(pkg: {
  id: string
  providerPackageId?: string | null
  providerId?: string | null
  providerPlanId?: string | null
}): Promise<PackageBackingResolution> {
  // 1. Bound single ProviderPackage — authoritative.
  if (pkg.providerPackageId) {
    const bb = await prisma.providerPackage.findUnique({
      where: { id: pkg.providerPackageId },
      select: { id: true, providerId: true, providerPlanId: true, isAvailable: true },
    })
    if (!bb || bb.isAvailable === false) return { kind: 'UNAVAILABLE' }
    return { kind: 'BOUND', backing: { providerPackageId: bb.id, providerId: bb.providerId, providerPlanId: bb.providerPlanId } }
  }

  // 2. Explicit multi-backing provider bindings (custom package).
  const bindings = await resolveExplicitBindings(pkg.id)
  if (bindings && bindings.length > 0) return { kind: 'CUSTOM', backings: bindings }

  // 3. Legacy denormalized providerId+providerPlanId → UNIQUE ProviderPackage.
  if (pkg.providerId && pkg.providerPlanId) {
    const legacy = await prisma.providerPackage.findMany({
      where: { providerId: pkg.providerId, providerPlanId: pkg.providerPlanId, isAvailable: true },
      select: { id: true, providerId: true, providerPlanId: true },
    })
    if (legacy.length === 1) {
      return { kind: 'BOUND', backing: { providerPackageId: legacy[0].id, providerId: legacy[0].providerId, providerPlanId: legacy[0].providerPlanId } }
    }
    return { kind: 'NONE' }
  }

  return { kind: 'NONE' }
}
