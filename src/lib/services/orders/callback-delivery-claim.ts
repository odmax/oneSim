import { prisma } from '@/lib/prisma'

/**
 * Atomic, DB-backed CLAIM for an outbound order callback delivery.
 *
 * Two ECS replicas must not POST the same callback simultaneously. Before any
 * outbound HTTP request the delivery is claimed with a single conditional
 * UPDATE ... WHERE eligible-condition (Prisma updateMany is one atomic
 * statement). Exactly one process wins (affected=1); the loser gets affected=0
 * and MUST NOT perform the HTTP request (no in-memory mutex, no read-then-write
 * race).
 *
 * Eligible: status is PENDING or RETRY_SCHEDULED, nextAttemptAt is due, and
 * the delivery is not already claimed by a live owner (claimOwner null or
 * claimedUntil expired). Terminals (DELIVERED / DEAD_LETTERED / CANCELLED /
 * FAILED / INVALID_URL) can never be re-claimed.
 *
 * Stale/crashed claims become retryable as soon as claimedUntil passes, and the
 * delivery route clears the claim on every outcome write. DELIVERED is never
 * written before the HTTP request succeeds (the caller controls that), and a
 * failed HTTP request can never permanently strand a delivery: it either
 * schedules a retry (RETRY_SCHEDULED) or reaches DEAD_LETTERED only after max
 * attempts. The outbound HTTP request is never performed inside a DB
 * transaction.
 *
 * Clock rule: `now` is a JS Date serialized by Prisma as UTC wall-clock, which
 * is consistent with the guarded order_callback_deliveries timestamp columns.
 */

export const CALLBACK_CLAIM_TTL_MS = 5 * 60 * 1000

export async function claimOrderCallbackDelivery(
  deliveryId: string,
  owner: string,
  ttlMs: number = CALLBACK_CLAIM_TTL_MS,
): Promise<boolean> {
  if (!deliveryId || !owner) return false
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false

  const now = new Date()
  const claimedUntil = new Date(now.getTime() + ttlMs)
  const res = await prisma.orderCallbackDelivery.updateMany({
    where: {
      id: deliveryId,
      status: { in: ['PENDING', 'RETRY_SCHEDULED'] },
      nextAttemptAt: { lte: now },
      OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }],
    },
    data: { claimOwner: owner, claimedUntil },
  })
  return res.count === 1
}