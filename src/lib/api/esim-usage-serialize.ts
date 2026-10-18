import { deriveEsimLifecyclePresentation } from '@/lib/esim/lifecycle-presentation'
import { hasUsableInstallData } from '@/lib/esim/installation-data'

/**
 * Shared, safe public serialization for eSIM usage snapshots.
 *
 * The DB `dataUsedMB` column is a non-null integer, so a stored `0` is a real
 * authoritative zero and must NEVER be replaced by a reconstructed history
 * aggregate. Missing (`null`) values stay null — a client can tell "no usage
 * known" from "zero usage". `lastUsageSyncAt` is a safe operational timestamp
 * (the last SUCCESSFUL usage fetch) and is exposed as-is; provider credentials,
 * configuration and raw provider fields (including providerStatus) are never
 * included here.
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

/**
 * Public two-axis lifecycle presentation built from safe persisted fields only.
 * Raw provider status is never exposed. `installationStatus` is the canonical
 * stored column value; `installationStatusLabel` is the customer-facing setup
 * label derived from it and the persisted activation evidence.
 */
export function publicEsimLifecycleFields(esim: any) {
  const presentation = deriveEsimLifecyclePresentation({
    status: esim?.status,
    installationStatus: esim?.installationStatus,
    hasUsableInstallData: hasUsableInstallData(esim || null),
    activatedAt: esim?.activatedAt,
    activationDetectedAt: esim?.activationDetectedAt,
    dataUsedMB: esim?.dataUsedMB,
  })
  return {
    serviceStatus: presentation.serviceStatus,
    serviceStatusLabel: presentation.serviceLabel,
    installationStatus: esim?.installationStatus ?? null,
    installationStatusLabel: presentation.setupLabel,
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
    ...publicEsimLifecycleFields(esim),
    expiresAt: esim.expiresAt?.toISOString?.() ?? null,
    dataUsedMB,
    dataRemainingMB,
    dataTotalMB,
    lastUsageSyncAt: esim.lastUsageSyncAt?.toISOString?.() ?? null,
  }
}