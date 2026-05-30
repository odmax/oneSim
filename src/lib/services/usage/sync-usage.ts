import { prisma } from '@/lib/prisma'
import { getAdapterForProvider } from '@/lib/providers/adapter-manager'

export interface SyncUsageResult {
  success: boolean
  dataUsedMB?: number
  dataTotalMB?: number
  dataRemainingMB?: number
  status?: string
  error?: string
}

export async function syncESIMUsage(esimId: string): Promise<SyncUsageResult> {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: {
      purchase: {
        include: {
          package: true,
        },
      },
    },
  })

  if (!esim) return { success: false, error: 'eSIM not found' }
  if (!esim.iccid) return { success: false, error: 'eSIM has no ICCID' }

  const providerId = esim.purchase.package.providerId
  if (!providerId) return { success: false, error: 'No provider configured' }

  const adapter = await getAdapterForProvider(providerId)
  if (!adapter) return { success: false, error: 'Provider adapter unavailable' }

  try {
    const usageResult = await adapter.getUsage(esim.iccid)

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

export async function batchSyncUsage(businessId?: string): Promise<{ synced: number; failed: number }> {
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
  let failed = 0

  for (const esim of esims) {
    const result = await syncESIMUsage(esim.id)
    if (result.success) synced++
    else failed++
  }

  return { synced, failed }
}