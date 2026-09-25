import { prisma } from '@/lib/prisma'
import { releaseReservedFunds } from '@/lib/services/orders/wallet-actions'
import { failOrder, createTimelineEvent } from '@/lib/services/orders/order-state-machine'
import { completeProviderFinalization, type ProviderFulfillmentResult } from '@/lib/services/orders/fulfillment'

export async function completeProviderOperation(params: {
  orderId: string
  businessId: string
  providerId: string
  providerRef: string
  providerName: string
  totalAmount: number
  iccids: string[]
  userId?: string
  validityDays?: number
  packageSnapshot?: any
  packageName?: string
  packageDataGB?: number
  packageValidityDays?: number
  qrCodeUrl?: string | null
  qrCode?: string | null
  activationCode?: string | null
  smdpAddress?: string | null
  matchingId?: string | null
  rawMetadata?: any
  /** The real connector result status/raw status when the provider supplied
   *  one. NEVER a fabricated ACTIVE and NEVER inferred from oneSIM's canonical
   *  status. When absent, a truthful internal fallback `PROVISIONED` is
   *  persisted so the raw provider-status column never lies. */
  providerStatus?: string | null
}) {
  const { orderId, businessId, providerId, providerRef, providerName, totalAmount, iccids, userId, packageSnapshot, packageName, packageDataGB, packageValidityDays, validityDays, qrCodeUrl, qrCode, activationCode, smdpAddress, matchingId, rawMetadata, providerStatus } = params

  const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId } })
  if (!order) return { success: false, error: 'Order not found' }
  if (order.status === 'FULFILLED') return { success: true, alreadyDone: true }

  // Truthful raw provider status: the connector's real result when supplied,
  // otherwise the internal `PROVISIONED` marker. Never a fabricated ACTIVE.
  const rawProviderStatus = providerStatus && String(providerStatus).trim() ? String(providerStatus).trim() : 'PROVISIONED'

  const providerResult: ProviderFulfillmentResult = {
    iccids,
    providerFulfillId: providerRef,
    providerStatus: rawProviderStatus,
    ...(qrCodeUrl ? { qrCodeUrl } : {}),
    ...(qrCode ? { qrCode } : {}),
    ...(activationCode ? { activationCode } : {}),
    ...(smdpAddress ? { smdpAddress } : {}),
    ...(matchingId ? { matchingId } : {}),
    ...(rawMetadata ? { rawMetadata } : {}),
  }

  const result = await completeProviderFinalization({
    orderId, businessId, providerId, providerRef, providerName, totalAmount,
    providerResult, userId, packageSnapshot, packageName, packageDataGB, packageValidityDays, validityDays,
  })

  if (result.success) return { success: true }
  if (result.recoveryRequired) return { success: false, error: result.error || 'Recovery required', recoveryRequired: true }
  return { success: false, error: result.error || 'Finalization failed' }
}

export async function failProviderOperation(params: {
  orderId: string
  businessId: string
  providerId: string
  providerRef: string
  totalAmount: number
  reason: string
  userId?: string
}) {
  const { orderId, businessId, providerId, providerRef, totalAmount, reason, userId } = params

  const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId } })
  if (!order) return { success: false, error: 'Order not found' }
  if (order.status === 'FULFILLED') return { success: true, alreadyDone: true }

  // Check if provider fulfillment evidence exists — if so, do NOT release
  if (order.providerFulfillId || order.providerReservationId) {
    await createTimelineEvent(orderId, { eventType: 'LOCAL_FINALIZATION_FAILED', message: `Cannot fail — provider fulfilled (${order.providerFulfillId || order.providerReservationId})` })
    return { success: false, error: 'Provider already fulfilled — manual reconciliation required', blockedByFulfillment: true }
  }

  // The provider has explicitly reported a terminal failure (polled
  // FAILED/REJECTED/CANCELLED/EXPIRED) — release is provably safe.
  const releaseResult = await releaseReservedFunds(orderId, businessId || order.businessId, totalAmount || Number(order.totalAmount), { confirmedFailure: true })
  if (!releaseResult.success && !releaseResult.blocked) {
    return { success: false, error: releaseResult.error }
  }
  if (releaseResult.blocked) {
    await createTimelineEvent(orderId, { eventType: 'LOCAL_FINALIZATION_FAILED', message: `Cannot release funds — ${releaseResult.error}` })
    return { success: false, error: releaseResult.error, blockedByFulfillment: true }
  }

  await failOrder(orderId, reason)
  await prisma.auditLog.create({
    data: { userId: userId || order.userId || '', action: 'PROVIDER_JOB_FAILED', entity: 'Purchase', entityId: orderId, details: JSON.stringify({ providerId, providerRef, reason }) },
  }).catch(() => {})

  return { success: true }
}
