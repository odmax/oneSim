import { prisma } from '@/lib/prisma'
import { getAdapterForProvider } from '@/lib/providers/adapter-manager'
import { createTimelineEvent } from '@/lib/services/orders/order-state-machine'
import { captureReservedFunds, releaseReservedFunds, reserveWalletFunds } from '@/lib/services/orders/wallet-actions'
import type { StatusLookupIdentifier } from '@/lib/providers/connectors/connector-interface'

export interface UsageData {
  dataUsedMB: number
  dataTotalMB?: number
  dataRemainingMB?: number
  percentageUsed?: number
  expiresAt?: Date
  status?: string
}

export interface RefreshStatusResult {
  success: boolean
  activated?: boolean
  status?: string
  providerStatus?: string
  error?: string
}

/** Best-effort extraction of the Choice `imsi_version` from persisted provider metadata. */
export function extractChoiceImsiVersion(providerResponse: any): string | number | undefined {
  if (!providerResponse || typeof providerResponse !== 'object') return undefined
  const candidates = [
    providerResponse.imsi_version,
    providerResponse.imsiVersion,
    providerResponse.package?.imsi_version,
    providerResponse.package?.imsiVersion,
    providerResponse.data?.imsi_version,
    providerResponse.data?.package?.imsi_version,
    providerResponse.response?.package?.imsi_version,
  ]
  for (const candidate of candidates) {
    if (candidate != null && String(candidate).trim() !== '') return candidate
  }
  return undefined
}

/**
 * Build the Choice status identifier with priority ICCID → IMSI → imsi_version.
 * Never falls back to a local OneSIM identifier (esim.id / purchase id).
 */
export function buildChoiceStatusLookup(esim: {
  iccid?: string | null
  imsi?: string | null
  providerResponse?: any
  status?: string | null
}): StatusLookupIdentifier {
  const lookup: StatusLookupIdentifier = {}
  const iccid = esim.iccid && String(esim.iccid).trim() ? String(esim.iccid).trim() : ''
  const imsi = esim.imsi && String(esim.imsi).trim() ? String(esim.imsi).trim() : ''
  const imsiVersion = extractChoiceImsiVersion(esim.providerResponse)

  if (iccid) lookup.iccid = iccid
  else if (imsi) lookup.imsi = imsi
  else if (imsiVersion != null) lookup.imsiVersion = imsiVersion

  if (esim.status && String(esim.status).trim()) lookup.currentStatus = String(esim.status).trim()
  return lookup
}

function hasChoiceIdentifier(lookup: StatusLookupIdentifier): boolean {
  return Boolean(
    (lookup.iccid && String(lookup.iccid).trim()) ||
    (lookup.imsi && String(lookup.imsi).trim()) ||
    (lookup.imsiVersion != null && String(lookup.imsiVersion).trim() !== ''),
  )
}

export async function refreshEsimStatus(esimId: string): Promise<RefreshStatusResult> {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: true } } },
  })
  if (!esim) return { success: false, error: 'eSIM not found' }

  const providerId = esim.purchase.package.providerId
  if (!providerId) return { success: false, error: 'No linked provider' }

  const adapter = await getAdapterForProvider(providerId)
  if (!adapter) return { success: false, error: 'Provider adapter unavailable' }

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { code: true },
  })
  const isChoice = provider?.code?.toUpperCase() === 'CHOICE'

  let identifier: string | StatusLookupIdentifier
  if (isChoice) {
    identifier = buildChoiceStatusLookup(esim)
    if (!hasChoiceIdentifier(identifier)) {
      return { success: false, error: 'No Choice status identifier (ICCID/IMSI/imsi_version) available' }
    }
  } else {
    identifier = esim.providerActivationId || esim.id
  }

  const result = await adapter.getActivationStatus(identifier)
  if (!result.success) return { success: false, error: result.error?.message || 'Provider status check failed' }

  const providerStatus = result.data?.rawStatus || result.data?.status || 'UNKNOWN'
  const oneSimStatus = mapProviderStatus(result.data?.status || providerStatus)
  const wasActivated = oneSimStatus === 'ACTIVE' && esim.status !== 'ACTIVE'

  await prisma.eSIM.update({
    where: { id: esimId },
    data: {
      providerStatus,
      status: oneSimStatus,
      lastStatusSyncAt: new Date(),
      lastSyncAt: new Date(),
      ...(result.data?.rawMetadata ? { providerResponse: result.data.rawMetadata as any } : {}),
      ...(wasActivated ? { activatedAt: new Date(), activationDetectedAt: new Date() } : {}),
    },
  })

  // Timeline event for status change
  if (wasActivated) {
    await createTimelineEvent(esim.purchaseId, { eventType: 'ESIM_ACTIVATED', message: `eSIM ${esim.iccid.slice(-8)} activated on device` })
  }
  await createTimelineEvent(esim.purchaseId, { eventType: 'STATUS_REFRESHED', message: `eSIM ${esim.iccid.slice(-8)}: ${oneSimStatus}` })

  return { success: true, activated: wasActivated, status: oneSimStatus, providerStatus }
}

export async function refreshEsimUsage(esimId: string): Promise<{ success: boolean; data?: UsageData; error?: string }> {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: true } } },
  })
  if (!esim) return { success: false, error: 'eSIM not found' }

  const providerId = esim.purchase.package.providerId
  if (!providerId) return { success: false, error: 'No linked provider' }

  const adapter = await getAdapterForProvider(providerId)
  if (!adapter) return { success: false, error: 'Provider adapter unavailable' }

  const result = await adapter.getUsage(esim.iccid)
  if (!result.success) return { success: false, error: result.error?.message || 'Usage fetch failed' }

  const rawData = (result.data || {}) as Record<string, any>
  const dataUsedMB = rawData.dataUsedMB ?? 0
  const dataTotalMB = rawData.dataTotalMB ?? undefined
  const dataRemainingMB = rawData.dataRemainingMB ?? undefined

  // Store usage record
  await prisma.usageRecord.create({
    data: {
      esimId,
      dataUsedMB,
      dataTotalMB: dataTotalMB ?? null,
      dataRemainingMB: dataRemainingMB ?? null,
      timestamp: rawData.timestamp ? new Date(rawData.timestamp) : new Date(),
    },
  })

  // Update eSIM usage snapshot
  await prisma.eSIM.update({
    where: { id: esimId },
    data: {
      dataUsedMB,
      dataTotalMB: dataTotalMB ?? undefined,
      dataRemainingMB: dataRemainingMB ?? undefined,
      lastUsageAt: new Date(),
      lastUsageSyncAt: new Date(),
      lastSyncAt: new Date(),
    },
  })

  await createTimelineEvent(esim.purchaseId, { eventType: 'USAGE_REFRESHED', message: `Usage synced: ${dataUsedMB}MB used` })

  const percentageUsed = dataTotalMB && dataTotalMB > 0 ? Math.round((dataUsedMB / dataTotalMB) * 100) : undefined

  return {
    success: true,
    data: { dataUsedMB, dataTotalMB, dataRemainingMB, percentageUsed, expiresAt: esim.expiresAt || undefined, status: esim.status },
  }
}

export async function topUpEsimWithWallet(esimId: string, businessId: string, userId: string, topUpPackageId: string, quantity: number = 1): Promise<{ success: boolean; topUpId?: string; error?: string }> {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { business: true, package: true } } },
  })
  if (!esim) return { success: false, error: 'eSIM not found' }
  if (esim.purchase.businessId !== businessId) return { success: false, error: 'eSIM does not belong to this business' }

  const allowed = ['ACTIVE', 'PENDING_ACTIVATION', 'PENDING']
  if (!allowed.includes(esim.status)) return { success: false, error: 'eSIM status does not allow top-up' }

  const topUpPkg = await prisma.eSIMPackage.findUnique({ where: { id: topUpPackageId } })
  if (!topUpPkg || !topUpPkg.isActive) return { success: false, error: 'Top-up package not found' }

  const productType = topUpPkg.productType || 'NEW_ESIM'
  if (productType !== 'TOP_UP' && productType !== 'BOTH') return { success: false, error: 'Package is not a top-up package' }

  const providerId = topUpPkg.providerId || esim.purchase.package.providerId
  if (!providerId) return { success: false, error: 'No provider configured' }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider || !provider.supportsTopUp) return { success: false, error: 'Provider does not support top-up' }

  const amount = parseFloat(topUpPkg.priceUSD.toString()) * quantity

  // Reserve wallet
  const reserve = await reserveWalletFunds(esim.purchaseId, businessId, amount)
  if (!reserve.success) return { success: false, error: reserve.error || 'Wallet reserve failed' }

  const orderId = esim.purchaseId

  // Call provider
  const adapter = await getAdapterForProvider(providerId)
  if (!adapter) {
    await releaseReservedFunds(orderId, businessId, amount)
    return { success: false, error: 'Provider adapter unavailable' }
  }

  const providerResult = await adapter.topUpESIM({
    iccid: esim.iccid,
    imsi: esim.imsi,
    planId: topUpPkg.providerPlanId || topUpPkg.id,
    sku: topUpPkg.sku || topUpPkg.packageCode || undefined,
    packageName: topUpPkg.displayName || topUpPkg.name,
    quantity,
  })

  if (!providerResult.success) {
    await releaseReservedFunds(orderId, businessId, amount)
    await createTimelineEvent(orderId, { eventType: 'TOPUP_FAILED', message: providerResult.error?.message || 'Provider top-up failed' })
    return { success: false, error: providerResult.error?.message || 'Provider top-up failed' }
  }

  const topUpData = providerResult.data!
  const dataAddedMB = topUpData.dataAddedMB ?? (topUpPkg.dataGB ? topUpPkg.dataGB * 1024 : undefined)
  const validityDaysAdded = topUpData.validityDaysAdded ?? topUpPkg.validityDays ?? undefined

  // Create top-up record and update eSIM
  try {
    await prisma.$transaction(async (tx) => {
      const topUp = await tx.eSIMTopUp.create({
        data: {
          businessId, esimId, packageId: topUpPackageId, providerId,
          providerReference: topUpData.providerReference || null,
          amount, currency: topUpPkg.currency || 'USD', status: 'COMPLETED',
          dataAddedMB: dataAddedMB || null, validityDaysAdded: validityDaysAdded || null,
          providerResponse: topUpData as any, completedAt: new Date(),
        },
      })

      const updateData: any = {}
      if (validityDaysAdded && esim.expiresAt) {
        updateData.expiresAt = new Date(esim.expiresAt.getTime() + validityDaysAdded * 24 * 60 * 60 * 1000)
      } else if (validityDaysAdded) {
        updateData.expiresAt = new Date(Date.now() + validityDaysAdded * 24 * 60 * 60 * 1000)
      }
      if (topUpData.newDataTotalMB) updateData.dataTotalMB = topUpData.newDataTotalMB
      if (topUpData.newDataRemainingMB) updateData.dataRemainingMB = topUpData.newDataRemainingMB

      if (Object.keys(updateData).length > 0) {
        await tx.eSIM.update({ where: { id: esimId }, data: updateData })
      }

      return topUp
    })

    // Capture wallet
    await captureReservedFunds(orderId, businessId, amount)
    await createTimelineEvent(orderId, { eventType: 'TOPUP_COMPLETED', message: `Top-up: ${topUpPkg.displayName || topUpPkg.name} (${esim.iccid.slice(-8)})` })

    return { success: true }
  } catch (e: any) {
    await releaseReservedFunds(orderId, businessId, amount)
    await createTimelineEvent(orderId, { eventType: 'TOPUP_FAILED', message: e.message || 'Transaction failed' })
    return { success: false, error: e.message || 'Transaction failed' }
  }
}

export async function markExpiredESIMs(): Promise<number> {
  const result = await prisma.eSIM.updateMany({
    where: { expiresAt: { lte: new Date() }, status: { notIn: ['EXPIRED', 'FAILED', 'CANCELLED'] } },
    data: { status: 'EXPIRED' },
  })
  return result.count
}

export async function refreshAllActiveStatuses(): Promise<{ refreshed: number; errors: number }> {
  const active = await prisma.eSIM.findMany({
    where: { status: { in: ['ACTIVE', 'PENDING_ACTIVATION', 'PENDING'] } },
    include: { purchase: { include: { package: true } } },
    take: 50,
  })

  let refreshed = 0
  let errors = 0

  for (const esim of active) {
    const r = await refreshEsimStatus(esim.id).catch(() => ({ success: false, error: 'Error' }))
    if (r.success) refreshed++
    else errors++
  }

  return { refreshed, errors }
}

export async function refreshAllUsage(): Promise<{ refreshed: number; errors: number }> {
  const active = await prisma.eSIM.findMany({
    where: { status: { in: ['ACTIVE', 'PENDING_ACTIVATION'] } },
    take: 50,
  })

  let refreshed = 0
  let errors = 0

  for (const esim of active) {
    const r = await refreshEsimUsage(esim.id).catch(() => ({ success: false, error: 'Error' }))
    if (r.success) refreshed++
    else errors++
  }

  return { refreshed, errors }
}

function mapProviderStatus(providerStatus: string): string {
  const upper = providerStatus.toUpperCase()
  if (['ACTIVE', 'ENABLED', 'INSTALLED', 'ACTIVATED'].includes(upper)) return 'ACTIVE'
  if (['PENDING', 'PENDING_ACTIVATION'].includes(upper)) return 'PENDING_ACTIVATION'
  if (['EXPIRED', 'EXPIRING'].includes(upper)) return 'EXPIRED'
  if (['FAILED', 'ERROR', 'REJECTED'].includes(upper)) return 'FAILED'
  if (['CANCELLED', 'CANCELED', 'CANCELLED_BY_USER', 'DELETED'].includes(upper)) return 'CANCELLED'
  if (['SUSPENDED', 'DISABLED'].includes(upper)) return 'SUSPENDED'
  return 'PENDING_ACTIVATION'
}
