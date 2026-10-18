import { resolvePackageBacking } from '@/lib/services/orders/package-backing-resolver'

export interface SyncProviderPurchase {
  providerId?: string | null
  package?: {
    id: string
    providerPackageId?: string | null
    providerId?: string | null
    providerPlanId?: string | null
  } | null
}

/**
 * Resolve the actual provider responsible for an eSIM.
 * Never use an unverified retail package default as fulfillment evidence.
 */
export async function resolveSyncProviderId(
  purchase: SyncProviderPurchase | null | undefined,
): Promise<string | null> {
  if (purchase?.providerId) return purchase.providerId

  if (!purchase?.package) return null

  const backing = await resolvePackageBacking(purchase.package)

  return backing.kind === 'BOUND' ? backing.backing.providerId : null
}


/**
 * Only pass package identifiers verified as belonging to the actual
 * fulfillment provider. Retail package defaults are not ownership evidence.
 */
export async function resolveSyncPackageIdentity(
  purchase: SyncProviderPurchase | null | undefined,
  providerId: string,
): Promise<{ providerPackageId?: string; providerPlanId?: string }> {
  if (!providerId || !purchase?.package?.id) return {}

  const resolution = await resolvePackageBacking(purchase.package)

  if (resolution.kind !== 'BOUND') return {}
  if (resolution.backing.providerId !== providerId) return {}

  return {
    providerPackageId: resolution.backing.providerPackageId,
    providerPlanId: resolution.backing.providerPlanId ?? undefined,
  }
}
