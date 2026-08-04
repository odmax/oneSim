import { prisma } from '@/lib/prisma'
import { enqueueOrderCallback } from './callback-delivery'

// ─────────────────────────────────────────────
// Event Registry (Task 3)
// ─────────────────────────────────────────────

export const ORDER_LIFECYCLE_EVENTS = {
  CREATED: 'order.created' as const,
  PROCESSING: 'order.processing' as const,
  PARTIALLY_FULFILLED: 'order.partially_fulfilled' as const,
  FULFILLED: 'order.fulfilled' as const,
  RECONCILIATION_REQUIRED: 'order.reconciliation_required' as const,
  FAILOVER_STARTED: 'order.failover_started' as const,
  FAILED: 'order.failed' as const,
  CANCELLED: 'order.cancelled' as const,
  REFUNDED: 'order.refunded' as const,
} as const

// ─────────────────────────────────────────────
// Central Publisher (Tasks 2, 4, 5)
// ─────────────────────────────────────────────

export interface PublishEventInput {
  orderId: string
  eventType: string
  metadata?: Record<string, any>
  transitionKey?: string
  version?: number
}

/**
 * Publish an authoritative order lifecycle event.
 * Creates callback delivery + in-app notification + timeline event.
 * Deduplicates by transitionKey or eventId.
 * Never makes the outbound HTTP request inline.
 */
export async function publishOrderLifecycleEvent(input: PublishEventInput): Promise<void> {
  const { orderId, eventType, metadata = {}, transitionKey, version = 1 } = input

  const eventKey = transitionKey || `${orderId}:${eventType}:v${version}`

  // Deduplication: check callback delivery eventId
  const deliveryEventId = `cb:${eventKey}`
  const alreadySent = await prisma.orderCallbackDelivery.findUnique({
    where: { eventId: deliveryEventId },
    select: { id: true },
  })
  if (alreadySent) return // Already published

  // Load order with safe fields
  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    select: {
      id: true, businessId: true, status: true, callbackUrl: true,
      quantity: true, fulfilledQuantity: true, failedQuantity: true,
      totalAmount: true, quotedTotalAmount: true, quotedUnitPrice: true,
      quotedCurrency: true, packageCurrency: true, packageUnitPrice: true,
      capturedAmount: true, releasedAmount: true,
      createdAt: true, updatedAt: true, fulfillmentCompletedAt: true,
    },
  })
  if (!order) return

  // Build safe payload (Task 5)
  const unitPrice = Number(order.quotedUnitPrice ?? order.packageUnitPrice ?? 0)
  const totalAmount = Number(order.quotedTotalAmount ?? order.totalAmount ?? 0)
  const currency = order.quotedCurrency || order.packageCurrency || 'USD'
  const fulfilledQty = order.fulfilledQuantity ?? 0
  const failedQty = order.failedQuantity ?? 0
  const remainingQty = Math.max(0, (order.quantity ?? 0) - fulfilledQty - failedQty)

  const payload = {
    id: deliveryEventId,
    type: eventType,
    createdAt: new Date().toISOString(),
    businessId: order.businessId,
    data: {
      orderId: order.id,
      status: order.status,
      quantity: order.quantity,
      fulfilledQuantity: fulfilledQty,
      failedQuantity: failedQty,
      remainingQuantity: remainingQty,
      unitPrice: unitPrice.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
      capturedAmount: order.capturedAmount ? Number(order.capturedAmount).toFixed(2) : undefined,
      releasedAmount: order.releasedAmount ? Number(order.releasedAmount).toFixed(2) : undefined,
      currency,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      fulfillmentCompletedAt: order.fulfillmentCompletedAt?.toISOString() || undefined,
      ...metadata,
    },
  }

  // Enqueue callback delivery (async, non-blocking)
  enqueueOrderCallback({
    orderId: order.id,
    businessId: order.businessId,
    eventType: eventType as any,
    data: payload.data,
    version,
  }).catch(() => { /* non-blocking */ })

  // Create timeline event
  prisma.orderTimelineEvent.create({
    data: {
      orderId: order.id,
      eventType: eventType === ORDER_LIFECYCLE_EVENTS.FULFILLED ? 'CALLBACK_CREATED' : `CALLBACK_${eventType.toUpperCase().replace(/\./g, '_')}`,
      message: `${eventType}: ${payload.data.quantity ?? '?'} qty`,
    },
  }).then(() => {}, () => {})
}
