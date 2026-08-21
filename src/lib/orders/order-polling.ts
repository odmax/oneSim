/**
 * Order status polling policy for the Buy eSIM flow.
 *
 * After enqueue the UI shows PROCESSING and polls order state; it must stop
 * waiting once the outcome is known, and keep a slow watch on orders that are
 * in provider reconciliation.
 */

/** Statuses where the outcome is final — stop polling. */
export const TERMINAL_ORDER_STATUSES = new Set([
  'FULFILLED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'EXPIRED',
  'INSTALLED',
  'ACTIVE',
  'PARTIALLY_FULFILLED',
])

/** In-flight statuses polled at the fast cadence (~2.5s). */
const FAST_POLL_MS = 2_500
/** PROVIDER_RECONCILIATION keeps a slow background watch. */
const RECONCILIATION_POLL_MS = 10_000

export function shouldStopPolling(status: string): boolean {
  return TERMINAL_ORDER_STATUSES.has(status)
}

export function nextPollDelayMs(status: string): number {
  if (status === 'PROVIDER_RECONCILIATION') return RECONCILIATION_POLL_MS
  return FAST_POLL_MS
}
