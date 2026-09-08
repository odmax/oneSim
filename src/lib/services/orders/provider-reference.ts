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
  dispatchStartedAt?: Date | null
}

/**
 * Dispatch-marker vocabulary (V2):
 *  - dispatchStartedAt == NULL  + non-terminal attempt = PRE_DISPATCH_CLAIM_ONLY
 *    — the order was claimed but the mutating HTTP provably never started.
 *    Only such attempts may be resumed/redispatched by recovery.
 *  - dispatchStartedAt != NULL  + non-terminal attempt = DISPATCH_MAY_HAVE_OCCURRED
 *    — the mutation boundary was crossed; any interruption afterwards
 *    (crash before/during HTTP, lost response, NULL providerReference, stale
 *    job) is treated as AMBIGUOUS and must reconcile — NEVER redispatch.
 * False-positive ambiguity is always preferred over a duplicate purchase.
 *
 * LEGACY_STARTED_CUTOVER: deployment-complete timestamp of the marker-first
 * code (run AFTER all pre-marker workers are drained). ProviderAttempt rows
 * created BEFORE this instant were written by code without a dispatchStartedAt
 * column, so a legacy bare STARTED row is NOT provably pre-dispatch — the old
 * code may have crossed the HTTP boundary before it died. Such rows stay
 * AMBIGUOUS (reconciliation). Rows created at/after the cutover run the
 * marker-first code, so STARTED + NULL marker is a provable non-commitment
 * (redispatch-safe).
 *
 * Config: LEGACY_STARTED_CUTOVER (ISO-8601). Missing or invalid configuration
 * FAILS CONSERVATIVE — every unmarked STARTED row is treated as possibly
 * committed, so no unknown legacy attempt can ever be redispatched.
 */
export const LEGACY_STARTED_CUTOVER_ENV = 'LEGACY_STARTED_CUTOVER'

/** Resolve the configured cutover; null when missing/invalid → fail conservative. */
export function resolveLegacyStartedCutover(): Date | null {
  const raw = process.env[LEGACY_STARTED_CUTOVER_ENV]
  if (!raw) return null
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return null
  return new Date(ms)
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
 * reference persisted on an attempt of the order's provider, OR an
 * owning-provider attempt in a possibly-committed state:
 *  - SUCCEEDED / PROCESSING / AMBIGUOUS always;
 *  - STARTED + dispatchStartedAt set (DISPATCH_MAY_HAVE_OCCURRED) — the
 *    mutating HTTP may have left OneSIM;
 *  - STARTED + dispatchStartedAt NULL but created before LEGACY_STARTED_CUTOVER
 *    — written by pre-marker code, the boundary may have been crossed.
 * The other terminal states (definitive FAILED/CANCELLED/SKIPPED) are provable
 * non-commitments. A STARTED attempt whose dispatchStartedAt is NULL and that
 * was created at/after the cutover provably never crossed the boundary
 * (PRE_DISPATCH_CLAIM_ONLY) — NOT acceptance evidence — recovery may
 * resume/redispatch it.
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
    if (['FAILED', 'CANCELLED', 'SKIPPED'].includes(status)) return false
    if (['SUCCEEDED', 'PROCESSING', 'AMBIGUOUS'].includes(status)) return true
    // STARTED (PRE_DISPATCH_CLAIM_ONLY vs DISPATCH_MAY_HAVE_OCCURRED): evidence
    // when the boundary was provably crossed (dispatchStartedAt set) OR the row
    // predates the marker-first code and may have crossed under the old code.
    // A bare STARTED row is redispatch-safe ONLY when the cutover is configured
    // AND the row provably ran the marker-first code (startedAt at/after
    // cutover). Missing/invalid cutover configuration fails conservative.
    if (a.dispatchStartedAt != null) return true
    const cutover = resolveLegacyStartedCutover()
    if (cutover === null) return true
    return a.startedAt != null && a.startedAt.getTime() < cutover.getTime()
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
  dispatchStartedAt: true,
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