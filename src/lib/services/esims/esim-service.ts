import { prisma } from '@/lib/prisma'
import { getAdapterForProvider } from '@/lib/providers/adapter-manager'
import { createTimelineEvent } from '@/lib/services/orders/order-state-machine'
import type { StatusLookupIdentifier } from '@/lib/providers/connectors/connector-interface'
import { buildChoiceStatusLookup, hasChoiceIdentifier, extractChoiceImsiVersion } from './choice-lookup'
import { deriveEsimLifecycleStatus } from './lifecycle-status'

export { buildChoiceStatusLookup, extractChoiceImsiVersion } from './choice-lookup'
export type { StatusLookupIdentifier } from '@/lib/providers/connectors/connector-interface'

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

export interface SuspendResumeResult {
  success: boolean
  status?: string
  providerStatus?: string
  error?: string
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
  const connectorStatus = result.data?.status || providerStatus

  const lifecycle = deriveEsimLifecycleStatus({
    providerNormalizedStatus: connectorStatus,
    currentStatus: esim.status,
    dataUsedMB: esim.dataUsedMB || 0,
    activatedAt: esim.activatedAt,
  })

  const oneSimStatus = lifecycle.status
  const shouldSetActivatedAt = lifecycle.setActivatedAt

  await prisma.eSIM.update({
    where: { id: esimId },
    data: {
      providerStatus,
      status: oneSimStatus,
      lastStatusSyncAt: new Date(),
      lastSyncAt: new Date(),
      ...(result.data?.rawMetadata ? { providerResponse: result.data.rawMetadata as any } : {}),
      ...(shouldSetActivatedAt ? { activatedAt: new Date() } : {}),
    },
  })

  // Timeline event for status change
  if (shouldSetActivatedAt) {
    await createTimelineEvent(esim.purchaseId, { eventType: 'ESIM_ACTIVATED', message: `eSIM ${esim.iccid.slice(-8)} activated — ${lifecycle.reason}` })
  }
  await createTimelineEvent(esim.purchaseId, { eventType: 'STATUS_REFRESHED', message: `eSIM ${esim.iccid.slice(-8)}: ${oneSimStatus}` })

  return { success: true, activated: shouldSetActivatedAt, status: oneSimStatus, providerStatus }
}

export async function refreshEsimUsage(esimId: string): Promise<{ success: boolean; data?: UsageData; error?: string }> {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: true } } },
  })
  if (!esim) return { success: false, error: 'eSIM not found' }

  const providerId = esim.purchase.package.providerId
  if (!providerId) return { success: false, error: 'No linked provider' }

  const { isCapabilityExposedToPortal } = await import('@/lib/providers/capabilities/exposure')
  if (!await isCapabilityExposedToPortal(providerId, 'USAGE' as any)) {
    return { success: false, error: 'capability_not_available' }
  }

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
      return { success: false, error: 'No Choice usage identifier (ICCID/IMSI/imsi_version) available' }
    }
  } else {
    if (!esim.iccid) return { success: false, error: 'eSIM has no ICCID' }
    identifier = esim.iccid
  }

  const result = await adapter.getUsage(identifier)
  if (!result.success) return { success: false, error: result.error?.message || 'Usage fetch failed' }

  const usageData = (result.data || {}) as Record<string, any>
  const dataUsedMB = usageData.dataUsedMB ?? 0
  const dataTotalMB = usageData.dataTotalMB ?? undefined
  const dataRemainingMB = usageData.dataRemainingMB ?? undefined
  const expiresAt = usageData.expiresAt ? new Date(usageData.expiresAt) : undefined

  // DB columns are Int; keep fractional values in the normalized result and round only for persistence.
  const persistedUsedMB = Number.isFinite(dataUsedMB) ? Math.round(dataUsedMB) : 0
  const persistedTotalMB = dataTotalMB !== undefined ? Math.round(dataTotalMB) : undefined
  const persistedRemainingMB = dataRemainingMB !== undefined ? Math.round(dataRemainingMB) : undefined

  // Store usage record
  await prisma.usageRecord.create({
    data: {
      esimId,
      dataUsedMB: persistedUsedMB,
      dataTotalMB: persistedTotalMB ?? null,
      dataRemainingMB: persistedRemainingMB ?? null,
      timestamp: usageData.timestamp ? new Date(usageData.timestamp) : new Date(),
      ...(usageData.rawMetadata ? { rawData: usageData.rawMetadata as any } : {}),
    },
  })

  // Update eSIM usage snapshot — detect first positive usage as device activation
  const hadNoUsage = (esim.dataUsedMB || 0) <= 0
  const nowHasUsage = persistedUsedMB > 0
  const firstActivation = hadNoUsage && nowHasUsage && !esim.activatedAt
  const shouldPromoteToActive = hadNoUsage && nowHasUsage && (esim.status === 'PENDING_ACTIVATION' || esim.status === 'PENDING')

  await prisma.eSIM.update({
    where: { id: esimId },
    data: {
      dataUsedMB: persistedUsedMB,
      ...(persistedTotalMB !== undefined ? { dataTotalMB: persistedTotalMB } : {}),
      ...(persistedRemainingMB !== undefined ? { dataRemainingMB: persistedRemainingMB } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(usageData.rawMetadata ? { providerResponse: usageData.rawMetadata as any } : {}),
      lastUsageAt: new Date(),
      lastUsageSyncAt: new Date(),
      lastSyncAt: new Date(),
      ...(firstActivation ? { activatedAt: new Date() } : {}),
      ...(shouldPromoteToActive ? { status: 'ACTIVE' } : {}),
    },
  })

  if (firstActivation) {
    await createTimelineEvent(esim.purchaseId, { eventType: 'ESIM_ACTIVATED', message: `eSIM ${esim.iccid.slice(-8)} activated — first usage detected (${persistedUsedMB}MB)` })
  }
  await createTimelineEvent(esim.purchaseId, { eventType: 'USAGE_REFRESHED', message: `Usage synced: ${dataUsedMB}MB used` })

  const percentageUsed = usageData.percentageUsed ?? (dataTotalMB !== undefined && dataTotalMB > 0 ? Math.round((dataUsedMB / dataTotalMB) * 100) : undefined)

  return {
    success: true,
    data: { dataUsedMB, dataTotalMB, dataRemainingMB, percentageUsed, expiresAt: expiresAt || esim.expiresAt || undefined, status: shouldPromoteToActive ? 'ACTIVE' : esim.status },
  }
}

/**
 * Shared suspend/resume flow. For Choice the identifier is resolved via
 * `buildChoiceStatusLookup` (ICCID → IMSI → imsi_version, never a local id) and
 * the provider is called through the adapter; for other providers the raw ICCID
 * is forwarded. Success persists the new status + provider status + sync
 * timestamps and sanitized metadata; failure preserves the stored status,
 * providerStatus, and success-sync timestamps.
 */
async function runEsimLifecycle(action: 'SUSPEND' | 'RESUME', esimId: string): Promise<SuspendResumeResult> {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: true } } },
  })
  if (!esim) return { success: false, error: 'eSIM not found' }

  const providerId = esim.purchase.package.providerId
  if (!providerId) return { success: false, error: 'No linked provider' }

  const { isCapabilityExposedToPortal } = await import('@/lib/providers/capabilities/exposure')
  const cap = action === 'SUSPEND' ? 'SUSPEND' as any : 'RESUME' as any
  if (!await isCapabilityExposedToPortal(providerId, cap)) {
    return { success: false, error: 'capability_not_available' }
  }

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
      return { success: false, error: `No Choice ${action.toLowerCase()} identifier (ICCID/IMSI/imsi_version) available` }
    }
  } else {
    if (!esim.iccid) return { success: false, error: 'eSIM has no ICCID' }
    identifier = esim.iccid
  }

  const result = action === 'SUSPEND' ? await adapter.suspendESIM(identifier) : await adapter.resumeESIM(identifier)
  if (!result.success) {
    await createTimelineEvent(esim.purchaseId, {
      eventType: action === 'SUSPEND' ? 'ESIM_SUSPEND_FAILED' : 'ESIM_RESUME_FAILED',
      message: result.error?.message || `Provider ${action.toLowerCase()} failed`,
    })
    return { success: false, error: result.error?.message || `${action === 'SUSPEND' ? 'Suspend' : 'Resume'} failed` }
  }

  const desiredStatus = action === 'SUSPEND' ? 'SUSPENDED' : 'ACTIVE'
  const providerStatus = result.data?.providerStatus || (action === 'SUSPEND' ? 'suspended' : 'active')

  await prisma.eSIM.update({
    where: { id: esimId },
    data: {
      status: desiredStatus,
      providerStatus,
      lastStatusSyncAt: new Date(),
      lastSyncAt: new Date(),
      ...(result.data?.rawMetadata ? { providerResponse: result.data.rawMetadata as any } : {}),
    },
  })

  await createTimelineEvent(esim.purchaseId, {
    eventType: action === 'SUSPEND' ? 'ESIM_SUSPENDED' : 'ESIM_RESUMED',
    message: `eSIM ${esim.iccid ? esim.iccid.slice(-8) : esim.id} ${action === 'SUSPEND' ? 'suspended' : 'resumed'}`,
  })

  return { success: true, status: desiredStatus, providerStatus }
}

export async function suspendEsim(esimId: string): Promise<SuspendResumeResult> {
  return runEsimLifecycle('SUSPEND', esimId)
}

export async function resumeEsim(esimId: string): Promise<SuspendResumeResult> {
  return runEsimLifecycle('RESUME', esimId)
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

  // Check Portal exposure
  const { isCapabilityExposedToPortal } = await import('@/lib/providers/capabilities/exposure')
  if (!await isCapabilityExposedToPortal(providerId, 'TOP_UP' as any)) {
    return { success: false, error: 'capability_not_available' }
  }

  // Delegate to the unified billing engine — one implementation for portal + API.
  // The core snapshots an immutable quote, reserves wallet funds keyed by the
  // top-up itself, dispatches the provider, and captures/releases exactly once
  // (F1: top-ups are never free; F2: retries never double-charge).
  const { createTopUpOrder } = await import('@/lib/services/orders/top-up-order')
  const result = await createTopUpOrder({
    businessId,
    userId,
    esimId,
    topUpPackageId,
    quantity,
  })

  return {
    success: result.success,
    topUpId: result.topUpId,
    error: result.error,
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
