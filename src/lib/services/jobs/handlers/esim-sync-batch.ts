import { prisma } from '@/lib/prisma'
import { getStatusNextSync, getUsageNextSync, shouldStopRetrying } from '../sync-policy'
import type { IProviderConnector } from '@/lib/providers/connectors/connector-interface'

async function getConnector(providerId: string): Promise<IProviderConnector | null> {
  const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
  return buildConnectorFromProvider(providerId) as any
}

export async function executeStatusSynchronization(batchSize = 20): Promise<{ processed: number; updated: number; failed: number; skipped: number }> {
  const now = new Date()
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
    const providerId = esim.purchase?.package?.providerId
    if (!providerId) { skipped++; continue }

    const provider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!provider || !['ACTIVE', 'DEGRADED', 'TESTING'].includes(provider.status)) { skipped++; continue }

    try {
      const connector = await getConnector(provider.id)
      if (!connector) { skipped++; continue }

      const result = await connector.getStatus(esim.iccid || esim.id)

      if (result.success && result.data) {
        const newStatus = result.data.status
        // Guard: never regress ACTIVE → PENDING
        if (esim.status === 'ACTIVE' && (newStatus === 'PENDING' || newStatus === 'PENDING_ACTIVATION' || newStatus === 'PROCESSING')) {
          await prisma.eSIM.update({ where: { id: esim.id }, data: { statusNextSyncAt: getStatusNextSync(esim.status, 0), statusSyncRetryCount: { increment: 1 } } })
          failed++; continue
        }
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: {
            status: newStatus,
            providerStatus: (result.data as any).providerStatus || null,
            lastStatusSyncAt: new Date(),
            statusNextSyncAt: getStatusNextSync(newStatus, 0),
            statusSyncRetryCount: 0,
          },
        })
        updated++
      } else {
        const errCode = result.error?.code || ''
        const stop = shouldStopRetrying(esim.statusSyncRetryCount + 1, errCode)
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: {
            statusSyncRetryCount: { increment: 1 },
            ...(stop ? { statusNextSyncAt: null } : { statusNextSyncAt: getStatusNextSync(esim.status, esim.statusSyncRetryCount + 1) }),
          },
        })
        failed++
      }
    } catch {
      await prisma.eSIM.update({ where: { id: esim.id }, data: { statusSyncRetryCount: { increment: 1 }, statusNextSyncAt: getStatusNextSync(esim.status, esim.statusSyncRetryCount + 1) } })
      failed++
    }
  }

  console.log(`[ESIM_STATUS_SYNC] processed=${esims.length} updated=${updated} failed=${failed} skipped=${skipped}`)
  return { processed: esims.length, updated, failed, skipped }
}

export async function executeUsageSynchronization(batchSize = 20): Promise<{ processed: number; updated: number; failed: number; skipped: number }> {
  const now = new Date()
  const esims = await prisma.eSIM.findMany({
    where: {
      usageNextSyncAt: { lte: now },
      status: { in: ['ACTIVE', 'INSTALLED', 'SUSPENDED'] },
    },
    include: { purchase: { select: { package: { select: { providerId: true } } } } },
    take: batchSize,
    orderBy: { usageSyncRetryCount: 'asc' },
  })

  let updated = 0; let failed = 0; let skipped = 0

  for (const esim of esims) {
    const providerId = esim.purchase?.package?.providerId
    if (!providerId) { skipped++; continue }

    const provider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!provider) { skipped++; continue }

    const caps = (provider.enabledCapabilities || []) as string[]
    if (!caps.includes('USAGE')) { skipped++; continue }

    try {
      const connector = await getConnector(provider.id)
      if (!connector) { skipped++; continue }

      const result = await connector.getUsage(esim.iccid || esim.id)

      if (result.success && result.data) {
        const data = result.data as any
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: {
            dataUsedMB: Math.round(data.dataUsedMB || 0),
            dataRemainingMB: data.dataRemainingMB != null ? Math.round(data.dataRemainingMB) : undefined,
            dataTotalMB: data.dataTotalMB != null ? Math.round(data.dataTotalMB) : undefined,
            lastUsageSyncAt: new Date(),
            usageNextSyncAt: getUsageNextSync(esim.status, 0),
            usageSyncRetryCount: 0,
          },
        })
        updated++
      } else {
        const stop = shouldStopRetrying(esim.usageSyncRetryCount + 1)
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: {
            usageSyncRetryCount: { increment: 1 },
            ...(stop ? { usageNextSyncAt: null } : { usageNextSyncAt: getUsageNextSync(esim.status, esim.usageSyncRetryCount + 1) }),
          },
        })
        failed++
      }
    } catch {
      await prisma.eSIM.update({ where: { id: esim.id }, data: { usageSyncRetryCount: { increment: 1 }, usageNextSyncAt: getUsageNextSync(esim.status, esim.usageSyncRetryCount + 1) } })
      failed++
    }
  }

  console.log(`[ESIM_USAGE_SYNC] processed=${esims.length} updated=${updated} failed=${failed} skipped=${skipped}`)
  return { processed: esims.length, updated, failed, skipped }
}
