import { prisma } from '@/lib/prisma'

/**
 * Deterministic, globally monotonic per-order ProviderAttempt number.
 *
 * Invariant: `attemptNumber` is UNIQUE across every source (PURCHASE,
 * RECONCILIATION, POLLING, WEBHOOK) for a single order. This keeps consumers
 * that order by attemptNumber — recovery "last attempt", the operations
 * timeline, and authoritative-reference selection — collision-free and
 * unambiguous (no two rows ever share a number on the same order).
 *
 * Allocation is max(attemptNumber)+1 over the order (all sources). It is safe
 * for the serialized order-processing model (one order's jobs run sequentially
 * in the worker). Under a rare multi-worker race a duplicate pair would still
 * self-heal on the next allocation (max grows) and consumers tie-break by
 * startedAt; a `@@unique([orderId, attemptNumber])` index would harden it
 * fully and is intentionally NOT added here (no schema migration).
 */
export async function allocateProviderAttemptNumber(orderId: string): Promise<number> {
  const agg = await prisma.providerAttempt.aggregate({
    where: { orderId },
    _max: { attemptNumber: true },
  })
  return (agg?._max?.attemptNumber ?? 0) + 1
}