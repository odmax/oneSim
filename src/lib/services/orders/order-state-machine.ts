import { prisma } from '@/lib/prisma'

/**
 * Order state machine with valid transitions only.
 */
const ORDER_TRANSITIONS: Record<string, string[]> = {
  CREATED: ['PAYMENT_RESERVED', 'FAILED', 'CANCELLED'],
  PAYMENT_RESERVED: ['PENDING_PROVIDER', 'FAILED', 'CANCELLED'],
  PENDING_PROVIDER: ['PROVIDER_ACCEPTED', 'RESERVED', 'FAILED'],
  PROVIDER_ACCEPTED: ['RESERVED', 'FULFILLING', 'FAILED'],
  RESERVED: ['FULFILLING', 'FAILED', 'CANCELLED'],
  FULFILLING: ['FULFILLED', 'PARTIALLY_FULFILLED', 'FAILED'],
  PARTIALLY_FULFILLED: ['PARTIALLY_FULFILLED', 'FULFILLED', 'FAILED', 'CANCELLED', 'PROVIDER_RECONCILIATION'],
  FULFILLED: ['INSTALLING', 'ACTIVE', 'EXPIRED', 'CANCELLED'],
  INSTALLING: ['INSTALLED', 'FAILED'],
  INSTALLED: ['ACTIVE', 'EXPIRED'],
  ACTIVE: ['EXPIRED', 'CANCELLED'],
  EXPIRED: ['CANCELLED'],
  CANCELLED: ['REFUNDED'],
  FAILED: ['CANCELLED', 'REFUNDED', 'PROVIDER_RECONCILIATION'],
  PROVIDER_RECONCILIATION: ['FULFILLED', 'FAILED', 'PROVIDER_RECONCILIATION'],
  REFUNDED: [],
}

const ORDER_LABELS: Record<string, string> = {
  CREATED: 'Created', PAYMENT_RESERVED: 'Payment Reserved',
  PENDING_PROVIDER: 'Pending Provider', PROVIDER_ACCEPTED: 'Provider Accepted',
  RESERVED: 'Reserved', FULFILLING: 'Fulfilling', FULFILLED: 'Fulfilled',
  PARTIALLY_FULFILLED: 'Partially Fulfilled',
  INSTALLING: 'Installing', INSTALLED: 'Installed', ACTIVE: 'Active',
  EXPIRED: 'Expired', CANCELLED: 'Cancelled', FAILED: 'Failed', REFUNDED: 'Refunded',
  PROVIDER_RECONCILIATION: 'Provider Reconciliation',
}

export type OrderStatus = keyof typeof ORDER_TRANSITIONS

/**
 * Try to transition an order to a new status.
 * Returns success and error message on invalid transition.
 */
export async function transitionOrder(orderId: string, newStatus: OrderStatus, metadata?: Record<string, any>): Promise<{ success: boolean; error?: string }> {
  try {
    const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId } })
    if (!order) return { success: false, error: 'Order not found' }

    const current = order.status
    const allowed = ORDER_TRANSITIONS[current]
    if (!allowed || !allowed.includes(newStatus)) {
      return { success: false, error: `Cannot transition from ${current} to ${newStatus}` }
    }

    await prisma.eSIMPurchase.update({
      where: { id: orderId },
      data: {
        status: newStatus,
        previousStatus: current,
        statusChangedAt: new Date(),
        ...(newStatus === 'FAILED' ? { failureReason: metadata?.reason || undefined } : {}),
      },
    })

    await createTimelineEvent(orderId, {
      eventType: 'STATUS_CHANGE',
      oldStatus: current,
      newStatus,
      message: `${ORDER_LABELS[current] || current} → ${ORDER_LABELS[newStatus] || newStatus}`,
      metadata: metadata || undefined,
    })

    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message || 'Transition failed' }
  }
}

/**
 * Create a timeline event for an order.
 */
export async function createTimelineEvent(orderId: string, data: {
  eventType: string
  oldStatus?: string | null
  newStatus?: string | null
  message?: string
  metadata?: Record<string, any>
  createdById?: string
}) {
  try {
    await prisma.orderTimelineEvent.create({
      data: {
        orderId,
        eventType: data.eventType,
        oldStatus: data.oldStatus || null,
        newStatus: data.newStatus || null,
        message: data.message || null,
        metadata: data.metadata || undefined,
        createdById: data.createdById || null,
      },
    })
  } catch (e) {
    console.error('Failed to create timeline event (non-fatal):', e)
  }
}

/**
 * Mark an order as failed with provider error details.
 */
export async function failOrder(orderId: string, reason: string, providerError?: { code?: string; message?: string }) {
  const result = await transitionOrder(orderId, 'FAILED', { reason })
  if (!result.success) return result

  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: {
      failureReason: reason,
      providerErrorCode: providerError?.code || null,
      providerErrorMessage: providerError?.message || null,
    },
  })

  return { success: true }
}

export { ORDER_LABELS, ORDER_TRANSITIONS }
