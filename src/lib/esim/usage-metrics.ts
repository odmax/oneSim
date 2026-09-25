export interface UsageMetrics {
  hasSnapshot: boolean
  used: number
  total: number
  remaining: number
  percentage: number
  /** true when the provider reported an authoritative used value (0 is valid). */
  usedKnown: boolean
  /** true when the provider reported an authoritative remaining value (0 is valid). */
  remainingKnown: boolean
}

/**
 * Single documented staleness threshold for usage snapshots. The scheduled usage
 * cadence for ACTIVE/INSTALLED lines is every 6 hours; the threshold is set to
 * 12 hours so ordinary scheduler/queue delay never marks a freshly-synced
 * snapshot as stale. A snapshot older than this is presented as STALE
 * (last-known data), never as live. DEPLETED lines recheck every 24 hours.
 */
export const USAGE_STALE_AFTER_MS = 12 * 60 * 60 * 1000

export interface UsageStaleness {
  /** a successful usage-sync timestamp exists */
  synchronized: boolean
  /** snapshot age exceeds the documented threshold (last-known, not live) */
  stale: boolean
  ageMs: number | null
}

export function getUsageStaleness(
  lastUsageSyncAt?: Date | string | null,
  now: Date = new Date(),
  staleAfterMs: number = USAGE_STALE_AFTER_MS,
): UsageStaleness {
  if (!lastUsageSyncAt) return { synchronized: false, stale: false, ageMs: null }
  const t = lastUsageSyncAt instanceof Date ? lastUsageSyncAt.getTime() : new Date(lastUsageSyncAt).getTime()
  if (!Number.isFinite(t)) return { synchronized: false, stale: false, ageMs: null }
  const ageMs = Math.max(0, now.getTime() - t)
  return { synchronized: true, stale: ageMs > staleAfterMs, ageMs }
}

/**
 * Derive display metrics for the usage contract. A snapshot exists only when a
 * real total or remaining allowance was recorded; otherwise the UI must show
 * "Usage unavailable" instead of a misleading 0.00 GB. Valid zero usage with a
 * real total stays a valid snapshot; a genuine numeric zero is preserved and
 * reported as known via `usedKnown` / `remainingKnown`. Missing values are
 * unknown — they must never be presented as zero.
 *
 * Server/client-neutral pure helper. Single canonical implementation — Server
 * Components and the client `UsageBar` component both import this module, so
 * the helper is never a client-reference proxy.
 */
export function deriveUsageMetrics(dataUsedMB?: number | null, dataTotalMB?: number | null, dataRemainingMB?: number | null): UsageMetrics {
  const usedKnown = dataUsedMB != null && Number.isFinite(Number(dataUsedMB))
  const remainingKnown = dataRemainingMB != null && Number.isFinite(Number(dataRemainingMB))
  const hasSnapshot = dataTotalMB != null || remainingKnown
  if (!hasSnapshot) return { hasSnapshot: false, used: 0, total: 0, remaining: 0, percentage: 0, usedKnown, remainingKnown }

  const used = usedKnown ? Number(dataUsedMB) : 0
  const total = dataTotalMB != null && Number.isFinite(Number(dataTotalMB))
    ? Number(dataTotalMB)
    : remainingKnown
      ? used + Number(dataRemainingMB)
      : 0
  const remaining = remainingKnown
    ? Math.max(0, Number(dataRemainingMB))
    : total > 0 && usedKnown
      ? Math.max(0, total - used)
      : 0
  const percentage = total > 0 && usedKnown ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0

  return { hasSnapshot: true, used, total, remaining, percentage, usedKnown, remainingKnown }
}

/**
 * Final customer-facing "used" label. An eSIM without an authoritative usage
 * snapshot — or with an unknown used value — renders exactly
 * "Usage unavailable"; a known zero renders "0.00 GB". Never a fabricated zero.
 */
export function usageUsedLabel(metrics: UsageMetrics): string {
  return metrics.hasSnapshot && metrics.usedKnown ? `${(metrics.used / 1024).toFixed(2)} GB` : 'Usage unavailable'
}

/** Final customer-facing "remaining" label; unknown ⇒ em dash. */
export function usageRemainingLabel(metrics: UsageMetrics): string {
  if (!metrics.hasSnapshot) return '—'
  if (metrics.remainingKnown || (metrics.usedKnown && metrics.total > 0)) return `${Math.max(0, metrics.remaining / 1024).toFixed(2)} GB`
  return '—'
}