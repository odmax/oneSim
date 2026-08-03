'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { revalidatePath } from 'next/cache'
import { transitionOrder, createTimelineEvent } from '@/lib/services/orders/order-state-machine'
import { releaseReservedFunds, refundCapturedFunds } from '@/lib/services/orders/wallet-actions'
import { recoverOrder } from '@/lib/services/orders/recovery'

export async function retryFailedOrder(orderId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const recovery = await recoverOrder(orderId)
  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath('/admin/orders')
  return {
    success: recovery.success,
    action: recovery.action,
    message: recovery.message || formatRecoveryMessage(recovery),
    status: recovery.status,
    retryCount: recovery.retryCount,
  }
}

function formatRecoveryMessage(r: { action: string; message?: string }): string {
  switch (r.action) {
    case 'RESUME_LOCAL_FINALIZATION': return 'Local finalization resumed.'
    case 'POLL_PROVIDER': return 'Provider status checked; order is still processing.'
    case 'REDISPATCH_PROVIDER': return 'Provider request retried.'
    case 'RECONCILIATION_REQUIRED': return 'Order requires reconciliation.'
    case 'NOT_RETRYABLE': return 'Order is not retryable.'
    case 'ALREADY_COMPLETE': return 'Order is already complete.'
    default: return r.message || 'Recovery attempted.'
  }
}

export async function cancelOrder(orderId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    include: { business: true },
  })
  if (!order) throw new Error('Order not found')

  const cancellableStates = ['CREATED', 'PAYMENT_RESERVED', 'PENDING_PROVIDER', 'FAILED', 'RESERVED']
  if (!cancellableStates.includes(order.status)) {
    throw new Error(`Cannot cancel order in ${order.status} state`)
  }

  // Release reserved funds
  const amount = Number(order.totalAmount)
  await releaseReservedFunds(orderId, order.businessId, amount)

  const result = await transitionOrder(orderId, 'CANCELLED')
  if (!result.success) throw new Error(result.error)

  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: { failureReason: 'Cancelled by admin' },
  })

  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath('/admin/orders')
  return { success: true, message: 'Order cancelled. Funds released.' }
}

export async function refundOrder(orderId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    include: { business: true },
  })
  if (!order) throw new Error('Order not found')

  const refundableStates = ['CANCELLED', 'FAILED', 'EXPIRED']
  if (!refundableStates.includes(order.status)) {
    throw new Error(`Cannot refund order in ${order.status} state. Must be CANCELLED, FAILED, or EXPIRED.`)
  }

  const amount = Number(order.totalAmount)
  const result = await refundCapturedFunds(orderId, order.businessId, amount)
  if (!result.success) {
    // If no capture found, try release instead
    await releaseReservedFunds(orderId, order.businessId, amount)
  }

  await transitionOrder(orderId, 'REFUNDED')

  await createTimelineEvent(orderId, {
    eventType: 'REFUND_COMPLETED',
    message: `Refunded ${amount} for order ${orderId}`,
    createdById: session.user.id,
  })

  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath('/admin/orders')
  return { success: true, message: `Refunded ${amount}. Order marked as REFUNDED.` }
}
