/**
 * eSIM auto-sync scheduling policy.
 * Determines when a status or usage sync should next run.
 *
 * retryCount === 0  → SUCCESS cadence (base interval for the status).
 * retryCount > 0    → FAILURE backoff (5m / 15m / 30m / 2h). A failed sync
 *                     never falls back to the long success cadence — e.g. a
 *                     failed ACTIVE status sync retries at +5m, not +6h.
 */
export function getStatusNextSync(status: string, retryCount: number): Date {
  const now = Date.now()
  if (retryCount > 0) return new Date(now + retryBackoff(retryCount))
  return new Date(now + getBaseSyncInterval(status))
}

export function getUsageNextSync(status: string, retryCount: number): Date {
  const now = Date.now()
  if (retryCount > 0) return new Date(now + retryBackoff(retryCount))
  return new Date(now + getUsageBaseInterval(status))
}

function getBaseSyncInterval(status: string): number {
  switch (status) {
    case 'PENDING': case 'PENDING_ACTIVATION': case 'PROCESSING': case 'PROVISIONING': case 'RESERVED':
      return 60 * 1000 // 1 minute
    case 'ACTIVE': case 'INSTALLED': case 'INSTALLING':
      return 6 * 3600 * 1000 // 6 hours
    case 'SUSPENDED':
      return 24 * 3600 * 1000 // 24 hours
    default: // FAILED, EXPIRED, CANCELLED, REFUNDED
      return 0 // stop polling
  }
}

function getUsageBaseInterval(status: string): number {
  switch (status) {
    case 'ACTIVE': case 'INSTALLED':
      return 6 * 3600 * 1000
    case 'SUSPENDED':
      return 24 * 3600 * 1000
    default:
      return 0 // no polling for PENDING/FAILED/EXPIRED etc.
  }
}

function retryBackoff(retryCount: number): number {
  if (retryCount === 0) return 0
  if (retryCount === 1) return 5 * 60 * 1000
  if (retryCount === 2) return 15 * 60 * 1000
  if (retryCount === 3) return 30 * 60 * 1000
  return 2 * 3600 * 1000
}

export function shouldStopRetrying(retryCount: number, lastErrorCode?: string): boolean {
  // Budget exhaustion: never retry indefinitely.
  if (retryCount >= 5) return true
  // Immediate permanent stop ONLY for conditions that require administrative /
  // provider-side correction or that the operation simply does not support.
  // PROVIDER_UNAVAILABLE, NETWORK_ERROR, TIMEOUT, HTTP 429/5xx, NOT_FOUND etc.
  // are NOT listed here — they use the bounded retry/backoff path and stop only
  // when the retry budget above is exhausted.
  if (lastErrorCode && ['AUTH_FAILED', 'NOT_SUPPORTED'].includes(lastErrorCode)) return true
  return false
}

/**
 * Canonical RETRY vs STOP disposition for a failed automatic sync.
 *
 * RETRY → statusSyncRetryCount += 1 and a bounded-future nextSyncAt (backoff).
 * STOP  → statusSyncRetryCount += 1 and nextSyncAt = null (the scheduler
 *         exclusion marker: a null schedule is never selected and the backfill
 *         only seeds rows that have NEVER failed, retryCount === 0, so a stopped
 *         row never resurrects itself). A manual refresh resets retry state and
 *         restores a normal schedule.
 */
export interface RetryDisposition {
  nextRetryCount: number
  stop: boolean
  nextSyncAt: Date | null
}

export function nextStatusSyncDisposition(retryCount: number, lastErrorCode?: string): RetryDisposition {
  const next = retryCount + 1
  const stop = shouldStopRetrying(next, lastErrorCode)
  return { nextRetryCount: next, stop, nextSyncAt: stop ? null : new Date(Date.now() + retryBackoff(next)) }
}

export function nextUsageSyncDisposition(retryCount: number): RetryDisposition {
  const next = retryCount + 1
  const stop = shouldStopRetrying(next)
  return { nextRetryCount: next, stop, nextSyncAt: stop ? null : new Date(Date.now() + retryBackoff(next)) }
}
