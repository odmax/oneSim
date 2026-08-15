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
  if (retryCount >= 5) return true
  if (lastErrorCode && ['AUTH_FAILED', 'NOT_SUPPORTED', 'PROVIDER_UNAVAILABLE'].includes(lastErrorCode)) return true
  return false
}
