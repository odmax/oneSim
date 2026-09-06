import { prisma } from '@/lib/prisma'

/**
 * Provider-owned reference recovery + acceptance evidence.
 *
 * Shared provider-neutral helpers so reconciliation, recovery, and redispatch
 * never duplicate the "which identifier can we poll" and "may we buy again"
 * logic — and never reinvent a provider identifier.
 */

export interface ProviderReferenceOrderLike {
  id: string
  providerId?: string | null
  providerFulfillId?: string | null
  providerReservationId?: string | null
}

export interface ProviderAttemptReference {
  providerId?: string | null
  providerReference?: string | null
  attemptNumber?: number
  startedAt?: Date | null
  status?: string
  source?: string
  retryClassification?: string | null
}

/**
 * Deterministic authoritative provider-owned reference for a pending order.
 *
 * Selection rule (never a local OneSIM order id, never another provider's
 * reference):
 *   1. durable ORDER-level evidence first: providerFulfillId, then
 *      providerReservationId;
 *   2. otherwise a provider-owned reference recovered from the order's existing
 *      ProviderAttempts, restricted to attempts whose `providerId` equals the
 *      order's provider, ordered deterministically by
 *      (attemptNumber desc, startedAt desc) — the highest attempt wins.
 *
 * Returns null only when no provider-owned reference can be recovered.
 */
export function resolveAuthoritativeProviderReference(
  order: ProviderReferenceOrderLike,
  attempts: ProviderAttemptReference[] = [],
): string | null {
  if (order.providerFulfillId) return order.providerFulfillId
  if (order.providerReservationId) return order.providerReservationId

  const owner = order.providerId
  const candidate = (attempts || [])
    .filter((a) => !!owner && a.providerId === owner && !!a.providerReference && String(a.providerReference).trim() !== '')
    .sort((a, b) => {
      const numDiff = (b.attemptNumber ?? 0) - (a.attemptNumber ?? 0)
      if (numDiff !== 0) return numDiff
      return (b.startedAt?.getTime() || 0) - (a.startedAt?.getTime() || 0)
    })[0]
  return candidate?.providerReference ? String(candidate.providerReference) : null
}

/**
 * True when durable provider ACCEPTANCE/reference evidence exists for the
 * order: order-level fulfillment/reservation evidence, a provider-owned
 * reference persisted on an attempt of the order's provider, OR any
 * owning-provider attempt in a possibly-committed state — i.e. any attempt
 * that is NOT a provable non-commitment (definitive FAILED, CANCELLED, or
 * SKIPPED). A timeout/ambiguous outcome or an in-flight/succeeded PURCHASE
 * attempt means the provider may already have accepted/charged the order.
 */
export function hasProviderAcceptanceEvidence(
  order: ProviderReferenceOrderLike,
  attempts: ProviderAttemptReference[] = [],
): boolean {
  if (order.providerFulfillId || order.providerReservationId) return true
  const owner = order.providerId
  return (attempts || []).some((a) => {
    if (!owner || a.providerId !== owner) return false
    if (a.providerReference && String(a.providerReference).trim() !== '') return true
    const status = String(a.status || '').toUpperCase()
    return !['FAILED', 'CANCELLED', 'SKIPPED'].includes(status)
  })
}

const ATTEMPT_REFERENCE_SELECT = {
  providerId: true,
  providerReference: true,
  attemptNumber: true,
  startedAt: true,
  status: true,
  source: true,
  retryClassification: true,
} as const

/** Load an order's attempt references (provider-owned identifiers only). */
export async function loadOrderAttemptReferences(orderId: string): Promise<ProviderAttemptReference[]> {
  const attempts = await prisma.providerAttempt.findMany({
    where: { orderId },
    orderBy: { attemptNumber: 'desc' },
    select: ATTEMPT_REFERENCE_SELECT,
  })
  return attempts as ProviderAttemptReference[]
}

/** Conv: resolve the authoritative reference for an order using its persisted attempts. */
export async function resolveAuthoritativeProviderReferenceForOrder(order: ProviderReferenceOrderLike): Promise<string | null> {
  const attempts = await loadOrderAttemptReferences(order.id)
  return resolveAuthoritativeProviderReference(order, attempts)
}

/** Conv: true when persisted provider acceptance evidence exists for the order. */
export async function orderHasProviderAcceptanceEvidence(order: ProviderReferenceOrderLike): Promise<boolean> {
  const attempts = await loadOrderAttemptReferences(order.id)
  return hasProviderAcceptanceEvidence(order, attempts)
}