import { prisma } from '@/lib/prisma'
import { getAdapterForProvider } from '@/lib/providers/adapter-manager'

export interface SyncStatusResult {
  success: boolean
  statusChanged?: boolean
  newStatus?: string
  activated?: boolean
  error?: string
}

function detectStatus(providerStatus: string | null | undefined, dataUsedMB: number | undefined | null): { status: string; activated: boolean } {
  const ps = (providerStatus || '').toLowerCase()
  if (ps === 'in use' || ps === 'active' || ps === 'activated' || ps === 'completed' || (dataUsedMB != null && dataUsedMB > 0)) {
    return { status: 'ACTIVE', activated: true }
  }
  if (ps === 'expired' || ps === 'suspended' || ps === 'deactivated') {
    return { status: ps === 'expired' ? 'EXPIRED' : ps === 'suspended' ? 'SUSPENDED' : 'INACTIVE', activated: false }
  }
  if (ps === 'failed' || ps === 'error') {
    return { status: 'FAILED', activated: false }
  }
  return { status: 'PENDING_ACTIVATION', activated: false }
}

export async function syncESIMStatus(esimId: string): Promise<SyncStatusResult> {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: {
      purchase: { include: { package: true } },
      usageRecords: { orderBy: { timestamp: 'desc' }, take: 1 },
    },
  })
  if (!esim) return { success: false, error: 'eSIM not found' }

  const providerId = esim.purchase.package.providerId
  if (!providerId) return { success: false, error: 'No provider configured' }

  const adapter = await getAdapterForProvider(providerId)
  if (!adapter) return { success: false, error: 'Provider adapter unavailable' }

  let providerStatus: string | undefined
  let dataUsedMB = esim.dataUsedMB || 0
  let dataTotalMB: number | undefined = esim.dataTotalMB || undefined
  let dataRemainingMB: number | undefined = esim.dataRemainingMB || undefined
  let expiresAt: Date | undefined = esim.expiresAt || undefined
  let lastUsageAt: Date | undefined = esim.lastUsageAt || undefined

  try {
    const statusResult = await adapter.getActivationStatus(esim.providerActivationId || esim.iccid)
    if (statusResult.success && statusResult.data) {
      providerStatus = statusResult.data.status
    }
  } catch { }

  try {
    const usageResult = await adapter.getUsage(esim.iccid)
    if (usageResult.success && usageResult.data) {
      const d = usageResult.data
      dataUsedMB = d.dataUsedMB ?? dataUsedMB
      if (d.timestamp) lastUsageAt = new Date(d.timestamp)
      if ((d as any).dataTotalMB !== undefined) dataTotalMB = (d as any).dataTotalMB
      if ((d as any).dataRemainingMB !== undefined) dataRemainingMB = (d as any).dataRemainingMB
    }
  } catch { }

  const { status: newStatus, activated } = detectStatus(providerStatus, dataUsedMB)

  const updateData: any = {
    providerStatus: providerStatus || esim.providerStatus,
    lastSyncAt: new Date(),
    lastStatusSyncAt: new Date(),
  }

  if (dataUsedMB !== undefined) updateData.dataUsedMB = dataUsedMB
  if (dataTotalMB !== undefined) updateData.dataTotalMB = dataTotalMB
  if (dataRemainingMB !== undefined) updateData.dataRemainingMB = dataRemainingMB
  if (lastUsageAt) updateData.lastUsageAt = lastUsageAt

  if (newStatus !== esim.status) {
    updateData.status = newStatus
  }

  if (activated && !esim.activatedAt) {
    updateData.activatedAt = new Date()
    updateData.activationDetectedAt = new Date()
  }

  if (expiresAt) updateData.expiresAt = expiresAt

  await prisma.eSIM.update({ where: { id: esimId }, data: updateData })

  // Create usage record if we have data
  if (dataUsedMB != null && dataUsedMB > 0) {
    const lastRecord = esim.usageRecords[0]
    if (!lastRecord || lastRecord.dataUsedMB !== dataUsedMB) {
      await prisma.usageRecord.create({
        data: {
          esimId,
          dataUsedMB,
          dataTotalMB: dataTotalMB || null,
          dataRemainingMB: dataRemainingMB || null,
          timestamp: lastUsageAt || new Date(),
        },
      })
    }
  }

  return {
    success: true,
    statusChanged: newStatus !== esim.status,
    newStatus,
    activated: activated && !esim.activatedAt,
  }
}

export async function batchSyncPendingEsims(): Promise<{ checked: number; activated: number; failed: number }> {
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

  for (const esim of esims) {
    checked++
    const result = await syncESIMStatus(esim.id)
    if (result.success) {
      if (result.activated) activated++
    } else {
      failed++
    }
  }

  return { checked, activated, failed }
}