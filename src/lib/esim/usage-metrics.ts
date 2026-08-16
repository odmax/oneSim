export interface UsageMetrics {
  hasSnapshot: boolean
  used: number
  total: number
  remaining: number
  percentage: number
}

/**
 * Derive display metrics for the usage contract. A snapshot exists only when a
 * real total or remaining allowance was recorded; otherwise the UI must show
 * "Usage unavailable" instead of a misleading 0.00 GB. Valid zero usage with a
 * real total stays a valid snapshot.
 *
 * Server/client-neutral pure helper. Single canonical implementation — Server
 * Components and the client `UsageBar` component both import this module, so
 * the helper is never a client-reference proxy.
 */
export function deriveUsageMetrics(dataUsedMB?: number | null, dataTotalMB?: number | null, dataRemainingMB?: number | null): UsageMetrics {
  const hasSnapshot = dataTotalMB != null || dataRemainingMB != null
  if (!hasSnapshot) return { hasSnapshot: false, used: 0, total: 0, remaining: 0, percentage: 0 }
  const used = dataUsedMB ?? 0
  const total = dataTotalMB ?? (dataRemainingMB != null ? used + dataRemainingMB : 0)
  const remaining = Math.max(0, dataRemainingMB ?? (total > 0 ? total - used : 0))
  const percentage = total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0
  return { hasSnapshot: true, used, total, remaining, percentage }
}
