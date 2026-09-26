import { prisma } from '@/lib/prisma'
import { capabilitySupported, resolveUsageLookup, buildProviderConnector, mergeProviderPackageEsimId, isUsageLookupSkip, type SyncLookupEsim } from '@/lib/services/esims/sync-lookup'
import { deriveDepletionStatus, deriveUsageActivation, isProviderExhaustedStatus } from '@/lib/services/esims/lifecycle-status'
import { getUsageNextSync } from '@/lib/services/jobs/sync-policy'

/**
 * Canonicalize a provider-reported remaining-data value:
 *  - null/undefined/NaN/Infinity -> null (unknown, never DEPLETED);
 *  - any finite number is floored at 0 (a negative reported balance is treated
 *    as exhausted and is never persisted as a negative value).
 */
export function normalizeDataRemainingMB(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, n)
}

export interface SyncUsageResult {
  success: boolean
  dataUsedMB?: number
  dataTotalMB?: number
  dataRemainingMB?: number
  status?: string
  error?: string
  skipped?: boolean
  skipReason?: string
}

/**
 * Canonical single-eSIM usage sync (also used by manual Refresh Usage and the
 * recurring batch).
 *
 * Provider-neutral:
 *   - capability gate: only calls connectors that declare usageLookup
 *     (AIRHUB/IBASIS/US-Matrix → clean skip, never a failure).
 *   - identifier safety: connector.resolveUsageLookup(esim) → safe fallback
 *     (provider reference → ICCID). A local OneSIM id is never sent.
 *   - normalized persistence into UsageRecord + eSIM columns.
 */
export async function syncESIMUsage(esimId: string): Promise<SyncUsageResult> {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: {
      purchase: {
        include: { package: true },
      },
    },
  })

  if (!esim) return { success: false, error: 'eSIM not found' }

  const providerId = esim.purchase?.package?.providerId
  if (!providerId) return { success: true, skipped: true, skipReason: 'PROVIDER_NOT_CONFIGURED' }

  const connector = await buildProviderConnector(providerId)
  if (!connector) return { success: true, skipped: true, skipReason: 'PROVIDER_NOT_CONFIGURED' }

  // Capability gate — unsupported providers skip cleanly.
  if (!capabilitySupported(connector, 'usageLookup')) {
    return { success: true, skipped: true, skipReason: 'CAPABILITY_NOT_SUPPORTED' }
  }

  // Safe provider-neutral identifier (never a local OneSIM id). The connector
  // resolver also receives the provider-owned package identity so providers
  // that need to match package↔eSIM associations (e.g. US-Matrix mobile-detail)
  // can resolve them deterministically.
  const lookup = resolveUsageLookup(connector, {
    ...esim,
    providerPackageId: esim.purchase?.package?.providerPackageId ?? undefined,
    providerPlanId: esim.purchase?.package?.providerPlanId ?? undefined,
  } as SyncLookupEsim)
  if (!lookup.ok) {
    return { success: true, skipped: true, skipReason: lookup.skipReason }
  }

  try {
    const usageResult = await connector.getUsage(lookup.identifier)

    if (usageResult.success && usageResult.data) {
      const d = usageResult.data
      const dataUsedMB = d.dataUsedMB
      const dataTotalMB = (d as any).dataTotalMB
      // Never persist negative remaining data; normalize before persistence AND
      // depletion derivation.
      const dataRemainingMB = normalizeDataRemainingMB((d as any).dataRemainingMB)
      const providerStatusRaw = (d as any).status ? String((d as any).status) : undefined

      // Canonical provider-neutral DEPLETED decision (single source of truth).
      // A successful connector getUsage call is authoritative; an explicit
      // provider status that means exhausted data also counts.
      const depletion = deriveDepletionStatus(esim.status, {
        dataRemainingMB,
        snapshotValid: true,
        providerExhausted: isProviderExhaustedStatus(providerStatusRaw ?? (d as any).providerStatus),
      })

      // Canonical PENDING → ACTIVE promotion from authoritative usage evidence
      // (same helper as the scheduled batch and USAGE_UPDATED webhook). A
      // positive used value is activation evidence; zero/missing/stale is not.
      const activation = deriveUsageActivation({
        currentStatus: esim.status,
        dataUsedMB: dataUsedMB == null ? undefined : Number(dataUsedMB),
        activatedAt: esim.activatedAt ?? null,
      })

      // Precedence: DEPLETED (from `depletion`) wins over usage-activation when
      // a snapshot reports exhausted remaining data; otherwise a pending line
      // with real usage promotes to ACTIVE.
      const targetStatus = depletion || (activation.status !== esim.status ? activation.status : esim.status)

      await prisma.$transaction(async (tx) => {
        // A history record is created only when at least one authoritative value
        // was returned; a missing used value stays unknown (never fabricated as 0).
        if (dataUsedMB != null || dataTotalMB != null || dataRemainingMB != null) {
          await tx.usageRecord.create({
            data: {
              esimId,
              dataUsedMB: dataUsedMB ?? 0,
              dataTotalMB: dataTotalMB ?? null,
              dataRemainingMB,
              timestamp: d.timestamp ? new Date(d.timestamp) : new Date(),
            },
          })
        }

        const updateData: any = { lastSyncAt: new Date(), lastUsageSyncAt: new Date() }
        // A successful manual/authoritative refresh restores the retry budget
        // (mirrors the status sync reset) so a row that had been STOPPED by
        // retry exhaustion becomes scheduler-eligible again — otherwise the
        // batch STOP guard (shouldStopRetrying) would immediately re-stop it.
        updateData.usageSyncRetryCount = 0
        if (dataUsedMB !== undefined && esim.dataUsedMB !== dataUsedMB) updateData.dataUsedMB = dataUsedMB
        if (dataTotalMB !== undefined && esim.dataTotalMB !== dataTotalMB) updateData.dataTotalMB = dataTotalMB
        // Only a finite, normalized remaining value is persisted (never negative);
        // unknown (null/NaN/Infinity) leaves the last known value untouched.
        if (dataRemainingMB !== null && esim.dataRemainingMB !== dataRemainingMB) updateData.dataRemainingMB = dataRemainingMB
        if ((d as any).expiresAt) updateData.expiresAt = new Date((d as any).expiresAt)

        // Preserve the ORIGINAL provider lifecycle status separately (never
        // rewritten to DEPLETED). DEPLETED is our customer-visible derivation.
        if (providerStatusRaw && esim.providerStatus !== providerStatusRaw) updateData.providerStatus = providerStatusRaw

        // Customer-visible status only changes via the canonical decision;
        // idempotent: no write when the status already matches. Canonical
        // activation timestamps are set only through the engine flag.
        if (targetStatus !== esim.status) updateData.status = targetStatus
        if (targetStatus === 'ACTIVE' && activation.setActivatedAt && !esim.activatedAt) {
          updateData.activatedAt = new Date()
          updateData.activationDetectedAt = new Date()
        }

        // Keep the recurring scheduler on the canonical cadence (DEPLETED gets a
        // conservative 24 h recheck) after every authoritative result.
        updateData.usageNextSyncAt = getUsageNextSync(targetStatus, 0)

        // Persist a provider-discovered package↔eSIM association id
        // (providerResponse.packageEsimId) WITHOUT overwriting existing keys, so
        // subsequent usage syncs use the fast path (no re-discovery).
        const mergedProviderResponse = mergeProviderPackageEsimId(esim.providerResponse, (d as any).providerPackageEsimId)
        if (mergedProviderResponse) updateData.providerResponse = mergedProviderResponse

        await tx.eSIM.update({
          where: { id: esimId },
          data: updateData,
        })
      })

      return {
        success: true,
        dataUsedMB,
        dataTotalMB,
        dataRemainingMB: dataRemainingMB ?? undefined,
        status: targetStatus,
      }
    }

    // No safe usage identifier (no/ambiguous association) → clean skip, never a
    // retryable failure.
    if (isUsageLookupSkip(usageResult.error?.code)) {
      return { success: true, skipped: true, skipReason: usageResult.error!.code }
    }

    return { success: false, error: usageResult.error?.message || 'Usage fetch failed' }
  } catch (error: any) {
    return { success: false, error: `Usage sync error: ${error.message || 'Unknown'}` }
  }
}

export async function batchSyncUsage(businessId?: string): Promise<{ synced: number; skipped: number; failed: number }> {
  const where: any = {
    iccid: { not: null },
  }
  if (businessId) {
    where.purchase = { businessId }
  }

  const esims = await prisma.eSIM.findMany({
    where,
    include: {
      purchase: {
        include: { package: true },
      },
    },
    take: 50,
  })

  let synced = 0
  let skipped = 0
  let failed = 0

  for (const esim of esims) {
    const result = await syncESIMUsage(esim.id)
    if (result.success) {
      if (result.skipped) skipped++
      else synced++
    } else {
      failed++
    }
  }

  return { synced, skipped, failed }
}
