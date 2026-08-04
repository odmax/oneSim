'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { resumeProviderFinalization } from '@/lib/services/orders/fulfillment'
import { reconcileProviderOrder } from '@/lib/services/orders/reconciliation'
import { recoverOrder } from '@/lib/services/orders/recovery'
import { releaseInventoryReservation } from '@/lib/services/orders/inventory-reservation'
import { createTimelineEvent, transitionOrder } from '@/lib/services/orders/order-state-machine'
import { processProviderWebhookEvent } from '@/lib/services/webhooks/provider-webhook-processor'

type ActionResult = { success: boolean; action: string; title: string; message: string; orderStatus?: string; severity?: string }

async function requireAdmin(): Promise<string> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')
  return session.user.id
}

function writeAudit(userId: string, orderId: string, action: string, message: string) {
  return prisma.auditLog.create({
    data: { userId, action, entity: 'Purchase', entityId: orderId, details: JSON.stringify({ action, message, timestamp: new Date().toISOString() }) },
  }).catch(() => {})
}

function getId(formData: FormData | string): string {
  return typeof formData === 'string' ? formData : (formData as FormData).get('orderId') as string
}

export async function adminResumeFinalization(formData: FormData | string): Promise<ActionResult> {
  const userId = await requireAdmin()
  const orderId = getId(formData)
  const result = await resumeProviderFinalization(orderId)
  await createTimelineEvent(orderId, { eventType: 'ADMIN_LOCAL_FINALIZATION_REQUESTED', message: 'Admin resumed local finalization' })
  await writeAudit(userId, orderId, 'ADMIN_RESUME_FINALIZATION', result.success ? 'Completed' : result.error || 'Failed')
  revalidatePath(`/admin/operations/orders/${orderId}`)
  return result.success
    ? { success: true, action: 'RESUME_LOCAL_FINALIZATION', title: 'Local finalization completed', message: 'Local finalization completed.', orderStatus: result.orderStatus }
    : { success: false, action: 'RESUME_LOCAL_FINALIZATION', title: 'Local finalization failed', message: result.error || 'Failed' }
}

export async function adminStartReconciliation(formData: FormData | string): Promise<ActionResult> {
  const userId = await requireAdmin()
  const orderId = getId(formData)
  const result = await reconcileProviderOrder(orderId)
  await createTimelineEvent(orderId, { eventType: 'ADMIN_RECONCILIATION_REQUESTED', message: 'Admin requested reconciliation' })
  await writeAudit(userId, orderId, 'ADMIN_RECONCILIATION', result.outcome || 'Started')
  revalidatePath(`/admin/operations/orders/${orderId}`)
  const messages: Record<string, string> = {
    FOUND_SUCCESS: 'Provider confirmed success — order finalized.',
    FOUND_FAILURE: 'Reconciliation confirmed provider failure.',
    STILL_PENDING: 'Provider still processing — keep waiting.',
    NOT_FOUND: 'Provider not reachable — will retry.',
    UNSUPPORTED: 'Provider does not support automated reconciliation. Manual review required.',
  }
  return { success: result.outcome === 'FOUND_SUCCESS', action: 'RECONCILE', title: messages[result.outcome || ''] || 'Reconciliation started', message: result.message, orderStatus: result.status || undefined }
}

export async function adminSafeRedispatch(formData: FormData | string): Promise<ActionResult> {
  const userId = await requireAdmin()
  const orderId = getId(formData)
  const recovery = await recoverOrder(orderId)
  await createTimelineEvent(orderId, { eventType: 'ADMIN_SAFE_REDISPATCH_REQUESTED', message: 'Admin initiated safe redispatch' })
  await writeAudit(userId, orderId, 'ADMIN_SAFE_REDISPATCH', recovery.action + ': ' + (recovery.message || ''))
  revalidatePath(`/admin/operations/orders/${orderId}`)
  return { success: recovery.success, action: recovery.success ? 'SAFE_REDISPATCH' : 'REDISPATCH_FAILED', title: recovery.success ? 'Safe provider redispatch started' : 'Redispatch failed', message: recovery.message || 'Redispatch attempted', orderStatus: recovery.status }
}

export async function adminRetryCallback(formData: FormData | string): Promise<ActionResult> {
  const userId = await requireAdmin()
  const deliveryId = typeof formData === 'string' ? formData : (formData as FormData).get('deliveryId') as string
  const orderId = (formData as FormData).get('orderId') as string
  await prisma.orderCallbackDelivery.update({ where: { id: deliveryId }, data: { status: 'PENDING', nextAttemptAt: new Date(), lastAttemptAt: null, attemptCount: 0 } })
  await createTimelineEvent(orderId, { eventType: 'ADMIN_CALLBACK_RETRY_REQUESTED', message: 'Admin requeued callback delivery' })
  await writeAudit(userId, orderId, 'ADMIN_RETRY_CALLBACK', `Delivery ${deliveryId} requeued`)
  revalidatePath(`/admin/operations/orders/${orderId}`)
  return { success: true, action: 'CALLBACK_RETRY', title: 'Callback queued for retry', message: 'Callback delivery has been requeued.' }
}

export async function adminCancelCallback(formData: FormData): Promise<ActionResult> {
  const userId = await requireAdmin()
  const deliveryId = formData.get('deliveryId') as string
  const orderId = formData.get('orderId') as string
  await prisma.orderCallbackDelivery.update({ where: { id: deliveryId }, data: { status: 'CANCELLED' } })
  await createTimelineEvent(orderId, { eventType: 'ADMIN_CALLBACK_CANCELLED', message: 'Admin cancelled callback delivery' })
  await writeAudit(userId, orderId, 'ADMIN_CANCEL_CALLBACK', `Delivery ${deliveryId} cancelled`)
  revalidatePath(`/admin/operations/orders/${orderId}`)
  return { success: true, action: 'CALLBACK_CANCELLED', title: 'Callback cancelled', message: 'Callback delivery has been cancelled.' }
}

export async function adminRequeueWebhook(formData: FormData): Promise<ActionResult> {
  const userId = await requireAdmin()
  const eventId = formData.get('eventId') as string
  const orderId = formData.get('orderId') as string
  const result = await processProviderWebhookEvent(eventId)
  await createTimelineEvent(orderId, { eventType: 'ADMIN_WEBHOOK_REPROCESS_REQUESTED', message: 'Admin reprocessed webhook' })
  await writeAudit(userId, orderId, 'ADMIN_REQUEUE_WEBHOOK', result.success ? 'Reprocessed' : 'Failed')
  revalidatePath(`/admin/operations/orders/${orderId}`)
  return result.success
    ? { success: true, action: 'WEBHOOK_REQUEUED', title: 'Provider webhook reprocessed', message: 'Webhook was reprocessed successfully.' }
    : { success: false, action: 'WEBHOOK_FAILED', title: 'Webhook reprocessing failed', message: result.error || 'Failed' }
}

export async function adminReleaseInventory(formData: FormData): Promise<ActionResult> {
  const userId = await requireAdmin()
  const reservationId = formData.get('reservationId') as string
  const orderId = formData.get('orderId') as string
  const result = await releaseInventoryReservation({ reservationId, reason: 'Admin release' })
  await createTimelineEvent(orderId, { eventType: 'ADMIN_INVENTORY_RELEASE_REQUESTED', message: 'Admin released inventory reservation' })
  await writeAudit(userId, orderId, 'ADMIN_RELEASE_INVENTORY', result.success ? 'Released' : 'Blocked')
  revalidatePath(`/admin/operations/orders/${orderId}`)
  return result.success
    ? { success: true, action: 'INVENTORY_RELEASED', title: 'Inventory reservation released', message: 'Local inventory reservation released.' }
    : { success: false, action: 'INVENTORY_BLOCKED', title: 'Inventory release blocked', message: result.error || 'Cannot release — provider evidence exists' }
}

export async function adminMarkReviewed(formData: FormData): Promise<ActionResult> {
  const userId = await requireAdmin()
  const orderId = formData.get('orderId') as string
  const note = (formData.get('note') as string) || undefined
  await createTimelineEvent(orderId, { eventType: 'OPERATIONS_INCIDENT_REVIEWED', message: note || 'Incident marked as reviewed by admin' })
  await writeAudit(userId, orderId, 'OPERATIONS_INCIDENT_REVIEWED', note || 'Reviewed')
  revalidatePath(`/admin/operations/orders/${orderId}`)
  return { success: true, action: 'REVIEWED', title: 'Incident marked as reviewed', message: 'Incident has been acknowledged.' }
}
