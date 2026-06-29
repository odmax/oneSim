'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { revalidatePath } from 'next/cache'
import { transitionOrder, createTimelineEvent } from '@/lib/services/orders/order-state-machine'
import { releaseReservedFunds, refundCapturedFunds } from '@/lib/services/orders/wallet-actions'

export async function retryFailedOrder(orderId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    include: { business: true, provider: true },
  })
  if (!order) throw new Error('Order not found')
  if (order.status !== 'FAILED') throw new Error('Only FAILED orders can be retried')
  if (order.retryCount >= order.maxRetries) throw new Error('Max retries reached')

  // Release any reserved funds first (they might still be held)
  const reserveAmount = Number(order.totalAmount)
  await releaseReservedFunds(orderId, order.businessId, reserveAmount)

  // Reset order for retry
  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: {
      retryCount: { increment: 1 },
      lastRetryAt: new Date(),
      retryReason: 'Manual retry',
      failureReason: null,
      providerErrorCode: null,
      providerErrorMessage: null,
    },
  })

  await createTimelineEvent(orderId, {
    eventType: 'RETRY_INITIATED',
    message: `Retry #${order.retryCount + 1}/${order.maxRetries} initiated`,
    createdById: session.user.id,
  })

  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath('/admin/orders')
  return { success: true, message: `Retry #${order.retryCount + 1} initiated. Funds released.` }
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
