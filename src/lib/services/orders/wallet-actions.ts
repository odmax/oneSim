import { prisma } from '@/lib/prisma'
import { createTimelineEvent } from './order-state-machine'

/**
 * Reserve wallet funds for an order.
 * Deducts from business.walletBalance and creates a RESERVE ledger entry.
 * If order already has a RESERVE entry, returns success (idempotent).
 */
export async function reserveWalletFunds(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  try {
    // Atomic reserve: the balance check and the decrement run inside one
    // transaction with a conditional update, closing the read-then-write race
    // that could let concurrent purchases overdraw the wallet.
    const result = await prisma.$transaction(async (tx) => {
      // Idempotency: an existing reserve means this order already holds the funds.
      const existing = await tx.walletTransaction.findFirst({
        where: { orderId, type: 'WALLET_RESERVE' },
      })
      if (existing) return { success: true }

      const business = await tx.business.findUnique({ where: { id: businessId }, select: { walletBalance: true } })
      if (!business) return { success: false, error: 'Business not found' }

      const updated = await tx.business.updateMany({
        where: { id: businessId, walletBalance: { gte: amount } },
        data: { walletBalance: { decrement: amount } },
      })
      if (updated.count === 0) {
        const balance = Number(business.walletBalance)
        return { success: false, error: `Insufficient wallet balance. Required: ${amount}, Available: ${balance}` }
      }

      await tx.walletTransaction.create({
        data: { businessId, orderId, amount: -amount, type: 'WALLET_RESERVE', description: `Reserved ${amount} for order ${orderId}` },
      })
      return { success: true }
    })

    if (!result.success) return result

    await createTimelineEvent(orderId, { eventType: 'WALLET_RESERVED', message: `Wallet reserved: ${amount}` })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message || 'Reservation failed' }
  }
}

/**
 * Capture reserved funds (confirm the charge after provider success).
 * Creates a CAPTURE entry. Only allowed if RESERVE exists.
 * Idempotent — returns success if already captured.
 */
export async function captureReservedFunds(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; alreadyCaptured?: boolean }> {
  try {
    const existing = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_RESERVE' },
    })
    if (!existing) return { success: false, error: 'No reservation found. Reserve wallet funds first.' }

    const captured = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_CAPTURE' },
    })
    if (captured) return { success: true, alreadyCaptured: true }

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
 * Release reserved funds (on provider rejection/failure).
 * Refunds the reserved amount back to wallet balance.
 *
 * Guards (Task 7):
 * - Does NOT release if WALLET_CAPTURE already exists (funds already collected)
 * - Does NOT release if WALLET_REFUND exists
 * - Does NOT release if WALLET_RELEASE already exists (idempotent)
 * - Does NOT release if provider fulfillment evidence exists on the order
 */
export async function releaseReservedFunds(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; blocked?: boolean }> {
  try {
    // Guard: already released
    const released = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_RELEASE' },
    })
    if (released) return { success: true }

    // Guard: funds already captured — cannot release
    const captured = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_CAPTURE' },
    })
    if (captured) return { success: false, error: 'Funds already captured — cannot release', blocked: true }

    // Guard: refund already processed
    const refunded = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_REFUND' },
    })
    if (refunded) return { success: false, error: 'Funds already refunded — cannot release', blocked: true }

    // Guard: provider fulfillment evidence exists — do not auto-release
    const order = await prisma.eSIMPurchase.findUnique({
      where: { id: orderId },
      select: { providerFulfillId: true, providerReservationId: true },
    })
    if (order?.providerFulfillId || order?.providerReservationId) {
      return { success: false, error: 'Provider fulfillment evidence exists — manual reconciliation required before release', blocked: true }
    }

    const reserve = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_RESERVE' },
    })
    if (!reserve) return { success: true } // No reservation to release

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
