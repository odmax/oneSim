/**
 * Provider operational monitoring policy.
 *
 * Which provider.statues are ACTIVELY MONITORED (their alert codes are opened/
 * upserted when a condition triggers), which are SUPPRESSED (no new alert is
 * opened; existing alerts for the codes are auto-resolved so they do not linger
 * after a status change), and which are EXCLUDED from evaluation entirely.
 *
 *   ACTIVE      → MONITORED
 *   DEGRADED    → MONITORED   (a degraded provider is still in service)
 *   TESTING     → MONITORED   (a testing provider is still routable and must be
 *                              watched — per existing product rules it is
 *                              counted as operational and purchase-eligible)
 *   MAINTENANCE → SUPPRESSED  (planned outage: catalog staleness, failure
 *                              windows and credential gaps are expected noise)
 *   INACTIVE    → SUPPRESSED  (not in service by design: no credentials,
 *                              no runtime activity to alert on)
 *   ARCHIVED    → EXCLUDED    (never selected by the self-heal scheduler or the
 *                              ops/diagnostics pages — not evaluated at all)
 */

export const PROVIDER_MONITORED_STATUSES = ['ACTIVE', 'DEGRADED', 'TESTING'] as const

/** Provider statuses that are suppressed from alerting (auto-resolved). */
export const PROVIDER_SUPPRESSED_STATUSES = ['MAINTENANCE', 'INACTIVE'] as const

/** Provider statuses that are excluded from evaluation entirely. */
export const PROVIDER_EXCLUDED_STATUSES = ['ARCHIVED'] as const

export function isProviderMonitored(status: string | null | undefined): boolean {
  return (PROVIDER_MONITORED_STATUSES as readonly string[]).includes(String(status || '').toUpperCase())
}

export function isProviderAlertSuppressed(status: string | null | undefined): boolean {
  return (PROVIDER_SUPPRESSED_STATUSES as readonly string[]).includes(String(status || '').toUpperCase())
}

export function isProviderAlertExcluded(status: string | null | undefined): boolean {
  return (PROVIDER_EXCLUDED_STATUSES as readonly string[]).includes(String(status || '').toUpperCase())
}