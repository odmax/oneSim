import { prisma } from '@/lib/prisma'
import { capabilitySupported, resolveUsageLookup, buildProviderConnector } from '@/lib/services/esims/sync-lookup'

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

  // Safe provider-neutral identifier (never a local OneSIM id).
  const lookup = resolveUsageLookup(connector, esim)
  if (!lookup.ok) {
    return { success: true, skipped: true, skipReason: lookup.skipReason }
  }

  try {
    const usageResult = await connector.getUsage(lookup.identifier)

    if (usageResult.success && usageResult.data) {
      const d = usageResult.data
      const dataUsedMB = d.dataUsedMB

      await prisma.$transaction(async (tx) => {
        await tx.usageRecord.create({
          data: {
            esimId,
            dataUsedMB,
            dataTotalMB: (d as any).dataTotalMB || null,
            dataRemainingMB: (d as any).dataRemainingMB || null,
            timestamp: d.timestamp ? new Date(d.timestamp) : new Date(),
          },
        })

        const updateData: any = { lastSyncAt: new Date(), lastUsageSyncAt: new Date() }
        if (dataUsedMB !== undefined) updateData.dataUsedMB = dataUsedMB
        if ((d as any).dataTotalMB !== undefined) updateData.dataTotalMB = (d as any).dataTotalMB
        if ((d as any).dataRemainingMB !== undefined) updateData.dataRemainingMB = (d as any).dataRemainingMB
        if ((d as any).expiresAt) updateData.expiresAt = new Date((d as any).expiresAt)

        await tx.eSIM.update({
          where: { id: esimId },
          data: updateData,
        })
      })

      return {
        success: true,
        dataUsedMB,
        dataTotalMB: (d as any).dataTotalMB,
        dataRemainingMB: (d as any).dataRemainingMB,
      }
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
