import { prisma } from '@/lib/prisma'
import { createTimelineEvent } from './order-state-machine'

/**
 * Reserve wallet funds for an order.
 * Deducts from business.walletBalance and creates a RESERVE ledger entry.
 * If order already has a RESERVE entry, returns success (idempotent).
 */
export async function reserveWalletFunds(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  try {
    // Check for existing reserve (idempotent)
    const existing = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_RESERVE' },
    })
    if (existing) return { success: true }

    const business = await prisma.business.findUnique({ where: { id: businessId } })
    if (!business) return { success: false, error: 'Business not found' }

    const balance = Number(business.walletBalance)
    if (balance < amount) return { success: false, error: `Insufficient wallet balance. Required: ${amount}, Available: ${balance}` }

    await prisma.$transaction([
      prisma.business.update({
        where: { id: businessId },
        data: { walletBalance: { decrement: amount } },
      }),
      prisma.walletTransaction.create({
        data: { businessId, orderId, amount: -amount, type: 'WALLET_RESERVE', description: `Reserved ${amount} for order ${orderId}` },
      }),
    ])

    await createTimelineEvent(orderId, { eventType: 'WALLET_RESERVED', message: `Wallet reserved: ${amount}` })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message || 'Reservation failed' }
  }
}

/**
 * Capture reserved funds (confirm the charge after provider success).
 * Creates a CAPTURE entry. Only allowed if RESERVE exists.
 */
export async function captureReservedFunds(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  try {
    const existing = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_RESERVE' },
    })
    if (!existing) return { success: false, error: 'No reservation found. Reserve wallet funds first.' }

    const captured = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_CAPTURE' },
    })
    if (captured) return { success: true } // Already captured

    await prisma.walletTransaction.create({
      data: { businessId, orderId, amount, type: 'WALLET_CAPTURE', description: `Captured ${amount} for order ${orderId}` },
    })

    await createTimelineEvent(orderId, { eventType: 'WALLET_CAPTURED', message: `Wallet captured: ${amount}` })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message || 'Capture failed' }
  }
}

/**
 * Release reserved funds (on provider failure).
 * Refunds the reserved amount back to wallet balance.
 */
export async function releaseReservedFunds(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  try {
    const reserve = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_RESERVE' },
    })
    if (!reserve) return { success: true } // No reservation to release

    const released = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_RELEASE' },
    })
    if (released) return { success: true } // Already released

    await prisma.$transaction([
      prisma.business.update({
        where: { id: businessId },
        data: { walletBalance: { increment: amount } },
      }),
      prisma.walletTransaction.create({
        data: { businessId, orderId, amount, type: 'WALLET_RELEASE', description: `Released ${amount} for order ${orderId}` },
      }),
    ])

    await createTimelineEvent(orderId, { eventType: 'WALLET_RELEASED', message: `Wallet released: ${amount}` })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message || 'Release failed' }
  }
}

/**
 * Refund captured funds (post-fulfillment refund).
 */
export async function refundCapturedFunds(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  try {
    const captured = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_CAPTURE' },
    })
    if (!captured) return { success: false, error: 'No captured funds to refund. Capture wallet first.' }

    const refunded = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_REFUND' },
    })
    if (refunded) return { success: true }

    await prisma.$transaction([
      prisma.business.update({
        where: { id: businessId },
        data: { walletBalance: { increment: amount } },
      }),
      prisma.walletTransaction.create({
        data: { businessId, orderId, amount, type: 'WALLET_REFUND', description: `Refunded ${amount} for order ${orderId}` },
      }),
    ])

    await createTimelineEvent(orderId, { eventType: 'WALLET_REFUNDED', message: `Wallet refunded: ${amount}` })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message || 'Refund failed' }
  }
}
