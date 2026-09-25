import { prisma } from '@/lib/prisma'
import { getStatusNextSync, getUsageNextSync, shouldStopRetrying, nextStatusSyncDisposition, nextUsageSyncDisposition } from '../sync-policy'
import { claimEsimForSync } from '../recurring-jobs'
import type { IProviderConnector } from '@/lib/providers/connectors/connector-interface'
import { deriveEsimLifecycleStatus, deriveDepletionStatus, deriveUsageActivation, isProviderExhaustedStatus } from '@/lib/services/esims/lifecycle-status'
import { capabilitySupported, resolveStatusLookup, resolveUsageLookup, buildProviderConnector, mergeProviderPackageEsimId, isUsageLookupSkip, type SyncLookupEsim } from '@/lib/services/esims/sync-lookup'
import { normalizeDataRemainingMB } from '@/lib/services/usage/sync-usage'
import { upsertProviderAlert, resolveProviderAlert } from '@/lib/services/operations/provider-alerts'

async function getConnector(providerId: string): Promise<IProviderConnector | null> {
  return buildProviderConnector(providerId)
}

function maskIccid(iccid: string | null | undefined): string {
  if (!iccid) return ''
  return iccid.length <= 8 ? '****' : `${iccid.slice(0, 4)}••••${iccid.slice(-4)}`
}

const SYNC_RETRY_EXHAUSTED = 'SYNC_RETRY_EXHAUSTED' as const

/**
 * One deduplicated durable operational signal when an eSIM's automatic sync
 * retry budget is exhausted. Scoped to (provider, eSIM identity, sync type) so
 * status/usage and different eSIMs never merge, and one eSIM's recovery never
 * clears another's. resourceId is the INTERNAL eSIM id; only a masked ICCID
 * appears in the human-readable message.
 */
function emitSyncExhaustedAlert(providerId: string | undefined | null, syncType: 'status' | 'usage', esimId: string, iccid: string | null | undefined): void {
  if (!providerId) return
  upsertProviderAlert(providerId, {
    code: SYNC_RETRY_EXHAUSTED,
    severity: 'WARNING',
    message: `${syncType} sync retries exhausted for eSIM ${maskIccid(iccid)}`,
  }, { resourceType: 'ESIM', resourceId: esimId, dedupKey: syncType })
}

/** Resolve ONLY this eSIM's + sync-type exhaustion on a successful authoritative refresh. */
function resolveSyncExhaustedAlert(providerId: string | undefined | null, syncType: 'status' | 'usage', esimId: string): void {
  if (!providerId) return
  resolveProviderAlert(providerId, SYNC_RETRY_EXHAUSTED, { resourceType: 'ESIM', resourceId: esimId, dedupKey: syncType })
}

/** Backfill null sync schedules for existing eSIMs. Idempotent.
 *
 *  SAFETY: only rows that have NEVER failed (retryCount === 0) are seeded. A
 *  null schedule on a row with retryCount > 0 is the canonical
 *  "retry exhausted / stopped" marker and must NEVER be resurrected here —
 *  otherwise a STOP disposes nothing and the provider keeps getting called.
 */
export async function backfillEsimSyncSchedules(): Promise<void> {
  const now = new Date()
  // Null-schedule non-terminal eSIMs in active-ish / pending-ish states become
  // eligible REGARDLESS of age, BUT only when the row never failed a sync.
  await prisma.eSIM.updateMany({
    where: { statusNextSyncAt: null, statusSyncRetryCount: 0, status: { in: ['PENDING', 'PENDING_ACTIVATION', 'PROCESSING', 'PROVISIONING', 'RESERVED'] } },
    data: { statusNextSyncAt: new Date(now.getTime() + 60000) },
  }).catch(() => {})
  await prisma.eSIM.updateMany({
    where: { statusNextSyncAt: null, statusSyncRetryCount: 0, status: { in: ['ACTIVE', 'INSTALLED', 'INSTALLING'] } },
    data: { statusNextSyncAt: new Date(now.getTime() + 3600000) },
  }).catch(() => {})
  await prisma.eSIM.updateMany({
    where: { usageNextSyncAt: null, usageSyncRetryCount: 0, status: { in: ['ACTIVE', 'INSTALLED'] }, dataTotalMB: null },
    data: { usageNextSyncAt: new Date(now.getTime() + 3600000) },
  }).catch(() => {})
  // DEPLETED rows that never started usage polling are re-seeded on a
  // conservative cadence so a genuine top-up restores them automatically.
  await prisma.eSIM.updateMany({
    where: { usageNextSyncAt: null, usageSyncRetryCount: 0, status: 'DEPLETED' },
    data: { usageNextSyncAt: new Date(now.getTime() + 24 * 3600000) },
  }).catch(() => {})
  await prisma.eSIM.updateMany({
    where: { status: { in: ['FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'] }, statusNextSyncAt: { not: null } },
    data: { statusNextSyncAt: null, usageNextSyncAt: null },
  }).catch(() => {})
}

export async function executeStatusSynchronization(batchSize = 20): Promise<{ processed: number; updated: number; failed: number; skipped: number }> {
  const now = new Date()
  // Null-schedule backfill runs as part of the NATURAL ESIM_STATUS_SYNC job
  // lifecycle (worker loop AND the HTTP process-jobs route both reach this
  // handler). Without this, historical null-schedule rows could remain stranded
  // whenever the HTTP cron route is not invoked. Idempotent, age-independent,
  // provider-neutral, and never touches wallet/order/provider-attempt state.
  await backfillEsimSyncSchedules()

  const esims = await prisma.eSIM.findMany({
    where: {
      statusNextSyncAt: { lte: now },
      status: { notIn: ['FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'] },
    },
    include: { purchase: { select: { package: { select: { providerId: true } } } } },
    take: batchSize,
    orderBy: { statusSyncRetryCount: 'asc' },
  })

  let updated = 0; let failed = 0; let skipped = 0

  for (const esim of esims) {
    if (!await claimEsimForSync(esim.id, 'statusNextSyncAt')) continue

    // Pre-dispatch STOP guard: a row whose retry budget is already exhausted is
    // terminated WITHOUT a provider request (stopRetrying is enforced by both
    // persistence — nextSyncAt=null — and eligibility, never just a log line).
    if (shouldStopRetrying(esim.statusSyncRetryCount)) {
      console.log(`[ESIM_STATUS_SYNC_STOPPED] providerId=${esim.purchase?.package?.providerId ?? '?'} esimId=${esim.id} retryCount=${esim.statusSyncRetryCount}`)
      await prisma.eSIM.update({ where: { id: esim.id }, data: { statusNextSyncAt: null, lastStatusSyncAt: new Date() } })
      // One durable operational signal per provider+eSIM+sync type (deduplicated);
      // never a provider call at this guard.
      emitSyncExhaustedAlert(esim.purchase?.package?.providerId, 'status', esim.id, esim.iccid)
      skipped++
      continue
    }

    const providerId = esim.purchase?.package?.providerId
    if (!providerId) { skipped++; continue }

    const provider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!provider || !['ACTIVE', 'DEGRADED', 'TESTING'].includes(provider.status)) { skipped++; continue }

    const connectorName = provider.adapterStrategy || provider.type || 'UNKNOWN'

    try {
      const connector = await getConnector(provider.id)
      if (!connector) { skipped++; continue }

      // Capability gate: only call connectors that declare status lookup support.
      if (!capabilitySupported(connector, 'statusLookup')) {
        console.log(`[ESIM_STATUS_SYNC_SKIP] providerId=${providerId} connector=${connectorName} esimId=${esim.id} reason=STATUS_CAPABILITY_NOT_SUPPORTED`)
        // Stop polling unsupported providers instead of counting endless failures.
        await prisma.eSIM.update({ where: { id: esim.id }, data: { statusNextSyncAt: null, statusSyncRetryCount: 0 } })
        skipped++
        continue
      }

      // SAFE provider-neutral identifier — never a local OneSIM database id.
      const lookup = resolveStatusLookup(connector, esim)
      if (!lookup.ok) {
        console.log(`[ESIM_STATUS_SYNC_SKIP] providerId=${providerId} connector=${connectorName} esimId=${esim.id} reason=${lookup.skipReason}`)
        skipped++
        continue
      }

      const result = await connector.getStatus(lookup.identifier)

      if (result.success && result.data) {
        const providerStatus = result.data.status
        // Forward verified connector evidence (network attach / device install)
        // so the lifecycle engine promotes ACTIVE/INSTALLED identically to the
        // single-sync path — no duplicated normalization logic. A connector-
        // confirmed authoritative activation timestamp (e.g. iBASIS) counts as
        // activation history.
        const connectorActivatedAt = result.data.activatedAt ? new Date(result.data.activatedAt) : undefined
        const lifecycle = deriveEsimLifecycleStatus({
          providerNormalizedStatus: providerStatus,
          currentStatus: esim.status,
          dataUsedMB: esim.dataUsedMB || 0,
          activatedAt: connectorActivatedAt || (esim as any).activatedAt || null,
          providerInstalledSignal: result.data.evidence?.deviceInstalled,
          providerNetworkAttachedSignal: result.data.evidence?.networkAttached,
        })
        const newStatus = lifecycle.status
        const statusRaw = (result.data as any).rawMetadata && typeof (result.data as any).rawMetadata === 'object'
          ? (result.data as any).rawMetadata as Record<string, unknown>
          : {}
        const updateData: any = {
          status: newStatus,
          providerStatus: (result.data as any).providerStatus || providerStatus || null,
          lastStatusSyncAt: new Date(),
          statusNextSyncAt: getStatusNextSync(newStatus, 0),
          statusSyncRetryCount: 0,
          // Sanitized evidence audit trail — MERGE (never overwrite existing
          // keys such as a persisted usage association id).
          providerResponse: {
            ...((esim as any).providerResponse && typeof (esim as any).providerResponse === 'object' ? (esim as any).providerResponse : {}),
            ...statusRaw,
            evidence: lifecycle.reason,
            evidenceObservedAt: new Date().toISOString(),
          },
        }
        if (lifecycle.setActivatedAt && !(esim as any).activatedAt) {
          updateData.activatedAt = connectorActivatedAt || new Date()
          updateData.activationDetectedAt = new Date()
        } else if (connectorActivatedAt && !(esim as any).activatedAt && (newStatus === 'ACTIVE' || newStatus === 'INSTALLED')) {
          updateData.activatedAt = connectorActivatedAt
          updateData.activationDetectedAt = new Date()
        }
        // Usage polling handoff: prove ACTIVE/INSTALLED + usageLookup support →
        // seed usageNextSyncAt if it was never scheduled. Provider-neutral.
        if ((newStatus === 'ACTIVE' || newStatus === 'INSTALLED') && (esim as any).usageNextSyncAt == null) {
          if (connector.capabilities?.usageLookup === true) {
            updateData.usageNextSyncAt = getUsageNextSync(newStatus, 0)
          }
        }
        await prisma.eSIM.update({ where: { id: esim.id }, data: updateData })
        // Authoritative success closes this eSIM's STATUS exhaustion only (when
        // it had previously been in retry — otherwise there is nothing to close).
        if (esim.statusSyncRetryCount > 0) resolveSyncExhaustedAlert(providerId, 'status', esim.id)
        updated++
      } else {
        const errCode = result.error?.code || 'UNKNOWN'
        const disp = nextStatusSyncDisposition(esim.statusSyncRetryCount, errCode)
        console.log(`[ESIM_STATUS_SYNC_FAILURE] providerId=${providerId} connector=${connectorName} iccid=${maskIccid(esim.iccid)} errorCode=${errCode} retryCount=${disp.nextRetryCount} stopRetrying=${disp.stop}`)
        if (disp.stop) emitSyncExhaustedAlert(providerId, 'status', esim.id, esim.iccid)
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: {
            statusSyncRetryCount: { increment: 1 },
            lastStatusSyncAt: new Date(),
            statusNextSyncAt: disp.nextSyncAt, // null ⇒ stopped, never selected again
          },
        })
        failed++
      }
    } catch (e: any) {
      const disp = nextStatusSyncDisposition(esim.statusSyncRetryCount, 'THROWN')
      console.log(`[ESIM_STATUS_SYNC_FAILURE] providerId=${providerId} connector=${connectorName} iccid=${maskIccid(esim.iccid)} errorCode=THROWN retryCount=${disp.nextRetryCount} stopRetrying=${disp.stop}`)
      if (disp.stop) emitSyncExhaustedAlert(providerId, 'status', esim.id, esim.iccid)
      await prisma.eSIM.update({ where: { id: esim.id }, data: { statusSyncRetryCount: { increment: 1 }, lastStatusSyncAt: new Date(), statusNextSyncAt: disp.nextSyncAt } })
      failed++
    }
  }

  console.log(`[ESIM_STATUS_SYNC] processed=${esims.length} updated=${updated} failed=${failed} skipped=${skipped}`)
  return { processed: esims.length, updated, failed, skipped }
}

export async function executeUsageSynchronization(batchSize = 20): Promise<{ processed: number; updated: number; failed: number; skipped: number }> {
  const now = new Date()
  // DEPLETED is scheduler-eligible so a genuine top-up/replenishment can be
  // detected and the line restored to ACTIVE automatically (conservative 24 h
  // cadence, see sync-policy getUsageBaseInterval). PENDING_ACTIVATION remains
  // excluded — no scheduling until the line is provisioned/active.
  const esims = await prisma.eSIM.findMany({
    where: {
      usageNextSyncAt: { lte: now },
      status: { in: ['ACTIVE', 'INSTALLED', 'SUSPENDED', 'DEPLETED'] },
    },
    include: { purchase: { select: { package: { select: { providerId: true, providerPlanId: true, providerPackageId: true } } } } },
    take: batchSize,
    orderBy: { usageSyncRetryCount: 'asc' },
  })

  let updated = 0; let failed = 0; let skipped = 0

  for (const esim of esims) {
    if (!await claimEsimForSync(esim.id, 'usageNextSyncAt')) continue

    // Pre-dispatch STOP guard (usage): exhausted rows are terminated without a
    // provider request. A stop is an attempt metadata change — it must never
    // make the eSIM appear freshly usage-synced.
    if (shouldStopRetrying(esim.usageSyncRetryCount)) {
      console.log(`[ESIM_USAGE_SYNC_STOPPED] providerId=${esim.purchase?.package?.providerId ?? '?'} esimId=${esim.id} retryCount=${esim.usageSyncRetryCount}`)
      await prisma.eSIM.update({ where: { id: esim.id }, data: { usageNextSyncAt: null } })
      // Usage exhaustion is covered by the same deduplicated operational alert,
      // scoped to (provider, eSIM, usage) so it never merges with status.
      emitSyncExhaustedAlert(esim.purchase?.package?.providerId, 'usage', esim.id, esim.iccid)
      skipped++
      continue
    }

    const providerId = esim.purchase?.package?.providerId
    if (!providerId) { skipped++; continue }

    const provider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!provider) { skipped++; continue }

    const connectorName = provider.adapterStrategy || provider.type || 'UNKNOWN'

    try {
      const connector = await getConnector(provider.id)
      if (!connector) { skipped++; continue }

      // Capability gate: only call connectors that declare usage lookup support.
      if (!capabilitySupported(connector, 'usageLookup')) {
        console.log(`[ESIM_USAGE_SYNC_SKIP] providerId=${providerId} connector=${connectorName} esimId=${esim.id} reason=USAGE_CAPABILITY_NOT_SUPPORTED`)
        // Stop polling unsupported providers instead of counting endless failures.
        await prisma.eSIM.update({ where: { id: esim.id }, data: { usageNextSyncAt: null, usageSyncRetryCount: 0 } })
        skipped++
        continue
      }

      // SAFE provider-neutral identifier — never a local OneSIM database id.
      // Package identity is included so providers that match package↔eSIM
      // associations (e.g. US-Matrix) resolve them deterministically.
      const lookup = resolveUsageLookup(connector, {
        ...esim,
        providerPackageId: esim.purchase?.package?.providerPackageId ?? undefined,
        providerPlanId: esim.purchase?.package?.providerPlanId ?? undefined,
      } as SyncLookupEsim)
      if (!lookup.ok) {
        console.log(`[ESIM_USAGE_SYNC_SKIP] providerId=${providerId} connector=${connectorName} esimId=${esim.id} reason=${lookup.skipReason}`)
        skipped++
        continue
      }

      const result = await connector.getUsage(lookup.identifier as any)

      if (result.success && result.data) {
        const data = result.data as any
        // Normalize WITHOUT inventing zero: finite numbers are preserved; a
        // missing used/total stays UNKNOWN (undefined) and is never written as 0.
        const dataUsedMB = typeof data.dataUsedMB === 'number' && Number.isFinite(data.dataUsedMB) ? data.dataUsedMB : undefined
        const dataTotalMB = typeof data.dataTotalMB === 'number' && Number.isFinite(data.dataTotalMB) ? data.dataTotalMB : undefined
        const dataRemainingMB = normalizeDataRemainingMB(data.dataRemainingMB)
        // Canonical provider-neutral depletion decision — the SAME engine as the
        // single/manual path (syncESIMUsage). Terminal states (EXPIRED/FAILED/
        // CANCELLED/REFUNDED) are never rewritten; missing/invalid remaining
        // never implies depletion; DEPLETED is restored only by remaining > 0.
        const depletion = deriveDepletionStatus(esim.status, {
          dataRemainingMB,
          snapshotValid: true,
          providerExhausted: isProviderExhaustedStatus(data.status ?? data.providerStatus),
        })
        // Canonical PENDING → ACTIVE promotion from authoritative usage evidence
        // (identical to syncESIMUsage and the USAGE_UPDATED webhook). Zero used,
        // missing or invalid usage are never activation evidence.
        const activation = deriveUsageActivation({
          currentStatus: esim.status,
          dataUsedMB: dataUsedMB == null ? undefined : Number(dataUsedMB),
          activatedAt: esim.activatedAt ?? null,
        })
        // DEPLETED (depletion) takes precedence over usage-activation when the
        // snapshot reports exhausted remaining data; otherwise a pending line
        // with real usage promotes to ACTIVE.
        const effectiveStatus = depletion || (activation.status !== esim.status ? activation.status : esim.status)
        const mergedProviderResponse = mergeProviderPackageEsimId(esim.providerResponse, data.providerPackageEsimId)
        const updateData: any = {
          ...(dataUsedMB !== undefined && esim.dataUsedMB !== dataUsedMB ? { dataUsedMB: Math.round(dataUsedMB) } : {}),
          ...(dataTotalMB !== undefined && esim.dataTotalMB !== dataTotalMB ? { dataTotalMB: Math.round(dataTotalMB) } : {}),
          ...(dataRemainingMB !== null && esim.dataRemainingMB !== dataRemainingMB ? { dataRemainingMB: Math.round(dataRemainingMB) } : {}),
          // Only a successful authoritative fetch advances this timestamp.
          lastUsageSyncAt: new Date(),
          usageNextSyncAt: getUsageNextSync(effectiveStatus, 0),
          usageSyncRetryCount: 0,
        }
        if (effectiveStatus !== esim.status) updateData.status = effectiveStatus
        // Activation timestamps are set only through the canonical engine flag.
        if (effectiveStatus === 'ACTIVE' && activation.setActivatedAt && !esim.activatedAt) {
          updateData.activatedAt = new Date()
          updateData.activationDetectedAt = new Date()
        }
        if ((data as any).expiresAt) updateData.expiresAt = new Date((data as any).expiresAt)
        if (data.status && esim.providerStatus !== String(data.status)) updateData.providerStatus = String(data.status)
        if (mergedProviderResponse) updateData.providerResponse = mergedProviderResponse
        await prisma.eSIM.update({ where: { id: esim.id }, data: updateData })
        // Persist an authoritative usage history record (shared shape with
        // syncESIMUsage); a record is only created when a real value exists, and
        // alerts cannot break the execution path.
        if (dataUsedMB != null || dataTotalMB != null || dataRemainingMB != null) {
          await prisma.usageRecord.create({
            data: {
              esimId: esim.id,
              dataUsedMB: dataUsedMB ?? 0,
              dataTotalMB: dataTotalMB ?? null,
              dataRemainingMB,
              timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
            },
          }).catch(() => {})
        }
        // Authoritative usage success closes this eSIM's USAGE exhaustion only.
        if (esim.usageSyncRetryCount > 0) resolveSyncExhaustedAlert(providerId, 'usage', esim.id)
        updated++
      } else if (isUsageLookupSkip(result.error?.code)) {
        // No safe usage identifier (no/ambiguous association) → clean skip,
        // keep the normal polling cadence (never a retryable failure).
        console.log(`[ESIM_USAGE_SYNC_SKIP] providerId=${providerId} connector=${connectorName} esimId=${esim.id} reason=${result.error?.code}`)
        await prisma.eSIM.update({ where: { id: esim.id }, data: { usageNextSyncAt: getUsageNextSync(esim.status, 0), usageSyncRetryCount: 0 } })
        skipped++
      } else {
        const disp = nextUsageSyncDisposition(esim.usageSyncRetryCount)
        console.log(`[ESIM_USAGE_SYNC_FAILURE] providerId=${providerId} connector=${connectorName} iccid=${maskIccid(esim.iccid)} errorCode=${result.error?.code || 'UNKNOWN'} retryCount=${disp.nextRetryCount} stopRetrying=${disp.stop}`)
        if (disp.stop) emitSyncExhaustedAlert(providerId, 'usage', esim.id, esim.iccid)
        // A failure must never advance the successful-sync timestamp.
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: {
            usageSyncRetryCount: { increment: 1 },
            usageNextSyncAt: disp.nextSyncAt,
          },
        })
        failed++
      }
    } catch (e: any) {
      const disp = nextUsageSyncDisposition(esim.usageSyncRetryCount)
      console.log(`[ESIM_USAGE_SYNC_FAILURE] providerId=${providerId} connector=${connectorName} iccid=${maskIccid(esim.iccid)} errorCode=THROWN retryCount=${disp.nextRetryCount} stopRetrying=${disp.stop}`)
      if (disp.stop) emitSyncExhaustedAlert(providerId, 'usage', esim.id, esim.iccid)
      // A failure must never advance the successful-sync timestamp.
      await prisma.eSIM.update({ where: { id: esim.id }, data: { usageSyncRetryCount: { increment: 1 }, usageNextSyncAt: disp.nextSyncAt } })
      failed++
    }
  }

  console.log(`[ESIM_USAGE_SYNC] processed=${esims.length} updated=${updated} failed=${failed} skipped=${skipped}`)
  return { processed: esims.length, updated, failed, skipped }
}
