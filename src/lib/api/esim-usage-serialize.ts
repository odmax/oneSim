/**
 * Shared, safe public serialization for eSIM usage snapshots.
 *
 * The DB `dataUsedMB` column is a non-null integer, so a stored `0` is a real
 * authoritative zero and must NEVER be replaced by a reconstructed history
 * aggregate. Missing (`null`) values stay null — a client can tell "no usage
 * known" from "zero usage". `lastUsageSyncAt` is a safe operational timestamp
 * (the last SUCCESSFUL usage fetch) and is exposed as-is; provider credentials,
 * configuration and raw provider fields are never included here.
 */

export function esimUsageSnapshotValues(esim: any): { dataUsedMB: number | null; dataTotalMB: number | null; dataRemainingMB: number | null } {
  const numOrNull = (v: any): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    return v ?? null
  }
  return {
    dataUsedMB: numOrNull(esim?.dataUsedMB) ?? null,
    dataTotalMB: numOrNull(esim?.dataTotalMB) ?? null,
    dataRemainingMB: numOrNull(esim?.dataRemainingMB) ?? null,
  }
}

/** Public eSIM usage-detail payload for GET /api/v1/esims/{esimId}/usage. */
export function serializePublicEsimUsageDetail(esim: any) {
  const { dataUsedMB, dataTotalMB, dataRemainingMB } = esimUsageSnapshotValues(esim)
  return {
    id: esim.id,
    iccid: esim.iccid,
    imsi: esim.imsi ?? null,
    status: esim.status,
    expiresAt: esim.expiresAt?.toISOString?.() ?? null,
    dataUsedMB,
    dataRemainingMB,
    dataTotalMB,
    lastUsageSyncAt: esim.lastUsageSyncAt?.toISOString?.() ?? null,
  }
}