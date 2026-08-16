import { prisma } from '@/lib/prisma'
import { deriveEsimLifecycleStatus } from '@/lib/services/esims/lifecycle-status'
import { getStatusNextSync, getUsageNextSync } from '@/lib/services/jobs/sync-policy'
import { capabilitySupported, resolveStatusLookup, buildProviderConnector } from '@/lib/services/esims/sync-lookup'
import type { StatusResultEvidence } from '@/lib/providers/connectors/connector-interface'

export interface SyncStatusResult {
  success: boolean
  statusChanged?: boolean
  newStatus?: string
  activated?: boolean
  /** The canonical lifecycle status persisted by this sync. */
  status?: string
  error?: string
  skipped?: boolean
  skipReason?: string
}

/**
 * Canonical single-eSIM status sync (also used by manual Refresh Status).
 *
 * Provider-neutral:
 *   - capability gate: skips providers whose connector does not declare status
 *     lookup (US-Matrix returns NOT_IMPLEMENTED today → skipped cleanly).
 *   - identifier safety: uses only provider-owned identifiers via the connector
 *     (never a local OneSIM id).
 *   - canonical lifecycle derivation: `deriveEsimLifecycleStatus` decides the
 *     stored status from evidence (never infers ACTIVE from "assigned").
 *   - monotonic: ACTIVE cannot regress to PENDING from stale provider data.
 *   - schedules next sync (with backoff on failure).
 *
 * This sync is intentionally decoupled from USAGE — a separate usage sync path
 * owns usage data.
 */
export async function syncESIMStatus(esimId: string): Promise<SyncStatusResult> {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: true } } },
  })
  if (!esim) return { success: false, error: 'eSIM not found' }

  const providerId = esim.purchase?.package?.providerId
  if (!providerId) return { success: false, error: 'No provider configured' }

  const connector = await buildProviderConnector(providerId)
  if (!connector) return { success: false, error: 'Provider connector unavailable' }

  // Capability gate: only sync status for connectors that declare it.
  if (!capabilitySupported(connector, 'statusLookup')) {
    return { success: true, skipped: true, skipReason: 'STATUS_CAPABILITY_NOT_SUPPORTED' }
  }

  // Safe provider-neutral identifier (never a local OneSIM id).
  const lookup = resolveStatusLookup(connector, esim)
  if (!lookup.ok) {
    return { success: true, skipped: true, skipReason: lookup.skipReason }
  }

  let providerStatus: string | undefined
  let evidence: StatusResultEvidence | undefined
  let sanitizedRawMetadata: Record<string, unknown> | undefined

  try {
    const statusResult = await connector.getStatus(lookup.identifier)
    if (statusResult.success && statusResult.data) {
      providerStatus = statusResult.data.status
      evidence = statusResult.data.evidence
      if (statusResult.data.rawMetadata && typeof statusResult.data.rawMetadata === 'object') {
        sanitizedRawMetadata = statusResult.data.rawMetadata as Record<string, unknown>
      }
    } else if (statusResult.error?.code === 'NOT_IMPLEMENTED') {
      return { success: true, skipped: true, skipReason: 'STATUS_CAPABILITY_NOT_SUPPORTED' }
    } else {
      return { success: false, error: statusResult.error?.message || 'Status lookup failed' }
    }
  } catch {
    return { success: false, error: 'Status lookup threw' }
  }

  // Canonical evidence-aware lifecycle derivation (monotonic, never regress).
  // Verified connector evidence (network attach / device install) is forwarded
  // so the lifecycle engine can promote ACTIVE/INSTALLED without a
  // provider-name branch.
  const lifecycle = deriveEsimLifecycleStatus({
    providerNormalizedStatus: providerStatus || 'UNKNOWN',
    currentStatus: esim.status,
    dataUsedMB: esim.dataUsedMB || 0,
    activatedAt: esim.activatedAt,
    providerInstalledSignal: evidence?.deviceInstalled,
    providerNetworkAttachedSignal: evidence?.networkAttached,
  })

  const updateData: any = {
    providerStatus: providerStatus || esim.providerStatus,
    lastSyncAt: new Date(),
    lastStatusSyncAt: new Date(),
    statusNextSyncAt: getStatusNextSync(lifecycle.status, 0),
    statusSyncRetryCount: 0,
  }

  if (lifecycle.status !== esim.status) {
    updateData.status = lifecycle.status
  }

  if (lifecycle.setActivatedAt && !esim.activatedAt) {
    updateData.activatedAt = new Date()
    updateData.activationDetectedAt = new Date()
  }

  // Sanitized evidence audit trail — MERGE, never overwrite existing
  // providerResponse keys (e.g. a persisted usage association id). The
  // connector whitelists its rawMetadata (no credentials); the lifecycle
  // reason/observedAt document the canonical interpretation.
  updateData.providerResponse = {
    ...(esim.providerResponse && typeof esim.providerResponse === 'object' ? esim.providerResponse as Record<string, unknown> : {}),
    ...(sanitizedRawMetadata ?? {}),
    evidence: lifecycle.reason,
    evidenceObservedAt: new Date().toISOString(),
  }

  // Usage polling handoff: when a sync proves ACTIVE/INSTALLED and the connector
  // supports usage lookup, seed usageNextSyncAt if it was never scheduled
  // (e.g. pre-existing eSIMs). Provider-neutral — capability-driven, no
  // provider-name branch.
  if ((lifecycle.status === 'ACTIVE' || lifecycle.status === 'INSTALLED') && esim.usageNextSyncAt == null) {
    if (connector.capabilities?.usageLookup === true) {
      updateData.usageNextSyncAt = getUsageNextSync(lifecycle.status, 0)
    }
  }

  await prisma.eSIM.update({ where: { id: esimId }, data: updateData })

  return {
    success: true,
    statusChanged: lifecycle.status !== esim.status,
    newStatus: lifecycle.status,
    status: lifecycle.status,
    activated: lifecycle.setActivatedAt && !esim.activatedAt,
  }
}

/** Seed the next-sync schedules for a newly fulfilled eSIM (Part 13). */
export async function seedEsimSyncSchedules(esimId: string, providerId: string, status: string): Promise<void> {
  const now = new Date()
  const data: any = {
    statusNextSyncAt: getStatusNextSync(status || 'PENDING_ACTIVATION', 0),
    usageNextSyncAt: getUsageNextSync(status || 'PENDING_ACTIVATION', 0),
  }
  // Only seed usage when the provider's connector declares usage lookup.
  try {
    const connector = await buildProviderConnector(providerId)
    if (connector?.capabilities?.usageLookup !== true) {
      data.usageNextSyncAt = null
    }
    if (connector?.capabilities?.statusLookup !== true) {
      data.statusNextSyncAt = null
    }
  } catch {
    data.usageNextSyncAt = null
  }
  void now
  await prisma.eSIM.update({ where: { id: esimId }, data }).catch(() => {})
}

/** Batch sync of pending eSIMs (kept for backward compatibility). */
export async function batchSyncPendingEsims(): Promise<{ checked: number; activated: number; failed: number; skipped: number }> {
  const esims = await prisma.eSIM.findMany({
    where: {
      status: { in: ['PENDING_ACTIVATION', 'PENDING'] },
    },
    include: {
      purchase: { include: { package: true } },
    },
    take: 100,
  })

  let checked = 0
  let activated = 0
  let failed = 0
  let skipped = 0

  for (const esim of esims) {
    checked++
    const result = await syncESIMStatus(esim.id)
    if (result.success) {
      if (result.skipped) skipped++
      else if (result.activated) activated++
    } else {
      failed++
    }
  }

  return { checked, activated, failed, skipped }
}
