'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { resumeProviderFinalization } from '@/lib/services/orders/fulfillment'
import { reconcileProviderOrder } from '@/lib/services/orders/reconciliation'
import { recoverOrder } from '@/lib/services/orders/recovery'
import { releaseInventoryReservation } from '@/lib/services/orders/inventory-reservation'
import { createTimelineEvent } from '@/lib/services/orders/order-state-machine'
import { processProviderWebhookEvent } from '@/lib/services/webhooks/provider-webhook-processor'

type ActionResult = {
  success: boolean
  action: string
  message: string
  orderStatus?: string
  nextRetryAt?: string
  auditId?: string
}

async function requireRole(allowed: string[]): Promise<{ userId: string; role: string }> {
  const session = await getServerSession(authOptions)
  if (!session || !allowed.includes(session.user.role)) throw new Error('Unauthorized')
  return { userId: session.user.id, role: session.user.role }
}

const LOCK_TTL = parseInt(process.env.ORDER_OPERATION_LOCK_TTL_SECONDS || '120', 10)
const ACTIONS_ENABLED = process.env.ADMIN_OPERATIONS_ACTIONS_ENABLED === 'true'

async function acquireLock(orderId: string): Promise<boolean> {
  try {
    const now = new Date()
    const until = new Date(now.getTime() + LOCK_TTL * 1000)
    await prisma.systemJobLock.upsert({
      where: { jobName: `order-operation:${orderId}` },
      create: { jobName: `order-operation:${orderId}`, lockedAt: now, lockedUntil: until, owner: `act-${process.pid}` },
      update: { lockedAt: now, lockedUntil: until, owner: `act-${process.pid}` },
    })
    return true
  } catch { return false }
}

async function releaseLock(orderId: string) {
  await prisma.systemJobLock.delete({ where: { jobName: `order-operation:${orderId}` } }).catch(() => {})
}

async function checkEnabled(): Promise<void> {
  if (!ACTIONS_ENABLED) throw new Error('Operations actions are disabled')
}

function blocked(message: string): ActionResult {
  return { success: false, action: 'NOT_ALLOWED', message }
}

function lockedResult(): ActionResult {
  return { success: false, action: 'LOCKED', message: 'Another operation is processing this order.' }
}

function writeAudit(userId: string, orderId: string, a: string, m: string): string {
  const id = `audit-${Date.now()}`
  prisma.auditLog.create({ data: { userId, action: a, entity: 'Purchase', entityId: orderId, details: JSON.stringify({ action: a, message: m }) } }).catch(() => {})
  return id
}

// ─────────────────────────────────────────────
// 9 Safe Operations
// ─────────────────────────────────────────────

export async function adminResumeFinalization(formData: FormData | string): Promise<ActionResult> {
  const { userId } = await requireRole(['SUPER_ADMIN', 'INTERNAL_ADMIN'])
  await checkEnabled()
  const orderId = typeof formData === 'string' ? formData : (formData as FormData).get('orderId') as string
  if (!(await acquireLock(orderId))) return lockedResult()
  try {
    const result = await resumeProviderFinalization(orderId)
    await createTimelineEvent(orderId, { eventType: 'ADMIN_LOCAL_FINALIZATION_REQUESTED', message: 'Admin resumed local finalization' })
    const auditId = writeAudit(userId, orderId, 'ADMIN_RESUME_FINALIZATION', result.success ? 'Completed' : result.error || 'Failed')
    revalidatePath(`/admin/operations/orders/${orderId}`)
    return result.success
      ? { success: true, action: 'LOCAL_FINALIZATION_RESUMED', message: 'Local finalization completed.', orderStatus: result.orderStatus, auditId }
      : { success: false, action: 'FAILED', message: result.error || 'Failed', auditId }
  } finally { releaseLock(orderId) }
}

export async function adminPollProvider(formData: FormData | string): Promise<ActionResult> {
  const { userId } = await requireRole(['SUPER_ADMIN', 'INTERNAL_ADMIN', 'SUPPORT'])
  await checkEnabled()
  const orderId = typeof formData === 'string' ? formData : (formData as FormData).get('orderId') as string
  if (!(await acquireLock(orderId))) return lockedResult()
  try {
    const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId }, include: { provider: true } })
    if (!order) return blocked('Order not found')
    const ref = order.providerFulfillId || order.providerReservationId
    if (!ref) return blocked('No provider reference available for polling')

    const { reconcileProviderOrder } = await import('@/lib/services/orders/reconciliation')
    const result = await reconcileProviderOrder(orderId)
    await createTimelineEvent(orderId, { eventType: 'ADMIN_PROVIDER_POLL_TRIGGERED', message: result.message })
    const auditId = writeAudit(userId, orderId, 'ADMIN_PROVIDER_POLL_TRIGGERED', result.outcome || 'Polled')
    revalidatePath(`/admin/operations/orders/${orderId}`)

    const messages: Record<string, string> = {
      FOUND_SUCCESS: 'Provider fulfillment was confirmed and local finalization completed.',
      FOUND_FAILURE: 'The provider confirmed that the order failed.',
      STILL_PENDING: 'Provider is still processing this order.',
      NOT_FOUND: 'Provider response remains uncertain; reconciliation is required.',
      UNSUPPORTED: 'Provider does not support automated polling.',
    }
    return {
      success: result.outcome === 'FOUND_SUCCESS',
      action: result.outcome === 'FOUND_SUCCESS' ? 'PROVIDER_POLLED' : result.outcome === 'STILL_PENDING' ? 'PROVIDER_POLLED' : 'FAILED',
      message: messages[result.outcome || ''] || result.message,
      orderStatus: result.status || undefined, auditId,
    }
  } finally { releaseLock(orderId) }
}

export async function adminStartReconciliation(formData: FormData | string): Promise<ActionResult> {
  const { userId } = await requireRole(['SUPER_ADMIN', 'INTERNAL_ADMIN', 'SUPPORT'])
  await checkEnabled()
  const orderId = typeof formData === 'string' ? formData : (formData as FormData).get('orderId') as string
  if (!(await acquireLock(orderId))) return lockedResult()
  try {
    const result = await (await import('@/lib/services/orders/reconciliation')).reconcileProviderOrder(orderId)
    await createTimelineEvent(orderId, { eventType: 'ADMIN_RECONCILIATION_REQUESTED', message: 'Admin requested reconciliation' })
    const auditId = writeAudit(userId, orderId, 'ADMIN_RECONCILIATION', result.outcome || 'Started')
    revalidatePath(`/admin/operations/orders/${orderId}`)
    return {
      success: result.outcome === 'FOUND_SUCCESS', action: 'RECONCILIATION_STARTED',
      message: result.outcome === 'FOUND_SUCCESS' ? 'Provider confirmed success — order finalized.' : result.message,
      orderStatus: result.status || undefined, auditId,
    }
  } finally { releaseLock(orderId) }
}

export async function adminSafeRedispatch(formData: FormData | string): Promise<ActionResult> {
  const { userId } = await requireRole(['SUPER_ADMIN'])
  await checkEnabled()
  if (process.env.ADMIN_SAFE_REDISPATCH_ENABLED !== 'true') return blocked('Safe redispatch is currently disabled')
  const orderId = typeof formData === 'string' ? formData : (formData as FormData).get('orderId') as string
  if (!(await acquireLock(orderId))) return lockedResult()
  try {
    const recovery = await recoverOrder(orderId)
    await createTimelineEvent(orderId, { eventType: 'ADMIN_SAFE_REDISPATCH_REQUESTED', message: 'Admin initiated safe redispatch' })
    const auditId = writeAudit(userId, orderId, 'ADMIN_SAFE_REDISPATCH', recovery.action + ': ' + (recovery.message || ''))
    revalidatePath(`/admin/operations/orders/${orderId}`)
    return { success: recovery.success, action: recovery.success ? 'PROVIDER_REDISPATCHED' : 'FAILED', message: recovery.message || 'Redispatch attempted', orderStatus: recovery.status, auditId }
  } finally { releaseLock(orderId) }
}

export async function adminRetryCallback(formData: FormData | string): Promise<ActionResult> {
  const { userId } = await requireRole(['SUPER_ADMIN', 'INTERNAL_ADMIN', 'SUPPORT'])
  await checkEnabled()
  const deliveryId = typeof formData === 'string' ? formData : (formData as FormData).get('deliveryId') as string
  const orderId = (formData as FormData).get('orderId') as string
  if (!(await acquireLock(orderId))) return lockedResult()
  try {
    await prisma.orderCallbackDelivery.update({ where: { id: deliveryId }, data: { status: 'PENDING', nextAttemptAt: new Date(), lastAttemptAt: null, attemptCount: 0 } })
    await createTimelineEvent(orderId, { eventType: 'ADMIN_CALLBACK_RETRY_REQUESTED', message: 'Admin requeued callback delivery' })
    const auditId = writeAudit(userId, orderId, 'ADMIN_RETRY_CALLBACK', `Delivery ${deliveryId} requeued`)
    revalidatePath(`/admin/operations/orders/${orderId}`)
    return { success: true, action: 'CALLBACK_REQUEUED', message: 'Callback delivery has been requeued.', auditId }
  } finally { releaseLock(orderId) }
}

export async function adminCancelCallback(formData: FormData): Promise<ActionResult> {
  const { userId } = await requireRole(['SUPER_ADMIN', 'INTERNAL_ADMIN'])
  await checkEnabled()
  const deliveryId = formData.get('deliveryId') as string
  const orderId = formData.get('orderId') as string
  if (!(await acquireLock(orderId))) return lockedResult()
  try {
    await prisma.orderCallbackDelivery.update({ where: { id: deliveryId }, data: { status: 'CANCELLED' } })
    await createTimelineEvent(orderId, { eventType: 'ADMIN_CALLBACK_CANCELLED', message: 'Admin cancelled callback delivery' })
    const auditId = writeAudit(userId, orderId, 'ADMIN_CANCEL_CALLBACK', `Delivery ${deliveryId} cancelled`)
    revalidatePath(`/admin/operations/orders/${orderId}`)
    return { success: true, action: 'CALLBACK_CANCELLED', message: 'Callback delivery has been cancelled.', auditId }
  } finally { releaseLock(orderId) }
}

export async function adminRequeueWebhook(formData: FormData): Promise<ActionResult> {
  const { userId } = await requireRole(['SUPER_ADMIN', 'INTERNAL_ADMIN', 'SUPPORT'])
  await checkEnabled()
  const eventId = formData.get('eventId') as string
  const orderId = formData.get('orderId') as string
  if (!(await acquireLock(orderId))) return lockedResult()
  try {
    const result = await processProviderWebhookEvent(eventId)
    await createTimelineEvent(orderId, { eventType: 'ADMIN_WEBHOOK_REPROCESS_REQUESTED', message: 'Admin reprocessed webhook' })
    const auditId = writeAudit(userId, orderId, 'ADMIN_REQUEUE_WEBHOOK', result.success ? 'Reprocessed' : 'Failed')
    revalidatePath(`/admin/operations/orders/${orderId}`)
    return { success: result.success, action: result.success ? 'WEBHOOK_REPROCESSED' : 'FAILED', message: result.success ? 'Webhook was reprocessed successfully.' : result.error || 'Failed', auditId }
  } finally { releaseLock(orderId) }
}

export async function adminReleaseInventory(formData: FormData): Promise<ActionResult> {
  const { userId } = await requireRole(['SUPER_ADMIN', 'INTERNAL_ADMIN'])
  await checkEnabled()
  const reservationId = formData.get('reservationId') as string
  const orderId = formData.get('orderId') as string
  if (!(await acquireLock(orderId))) return lockedResult()
  try {
    const result = await releaseInventoryReservation({ reservationId, reason: 'Admin release' })
    await createTimelineEvent(orderId, { eventType: 'ADMIN_INVENTORY_RELEASE_REQUESTED', message: 'Admin released inventory reservation' })
    const auditId = writeAudit(userId, orderId, 'ADMIN_RELEASE_INVENTORY', result.success ? 'Released' : 'Blocked')
    revalidatePath(`/admin/operations/orders/${orderId}`)
    return result.success
      ? { success: true, action: 'INVENTORY_RELEASED', message: 'Local inventory reservation released.', auditId }
      : { success: false, action: 'NOT_ALLOWED', message: result.error || 'Cannot release — provider evidence exists', auditId }
  } finally { releaseLock(orderId) }
}

export async function adminAcknowledgeIncident(formData: FormData): Promise<ActionResult> {
  const { userId } = await requireRole(['SUPER_ADMIN', 'INTERNAL_ADMIN', 'SUPPORT', 'FINANCE'])
  const orderId = formData.get('orderId') as string
  const note = (formData.get('note') as string) || undefined
  await createTimelineEvent(orderId, { eventType: 'OPERATIONS_INCIDENT_REVIEWED', message: note || 'Incident marked as reviewed by admin' })
  const auditId = writeAudit(userId, orderId, 'OPERATIONS_INCIDENT_REVIEWED', note || 'Reviewed')
  revalidatePath(`/admin/operations/orders/${orderId}`)
  return { success: true, action: 'INCIDENT_ACKNOWLEDGED', message: 'Incident has been acknowledged.', auditId }
}
