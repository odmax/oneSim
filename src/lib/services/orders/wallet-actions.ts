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
 * Internal tx-aware capture that caps the TOTAL captured for an order at `amount`.
 * Used for partial fulfillment where units arrive in batches: each call captures
 * only the delta (amount − alreadyCaptured), never exceeding the reservation.
 * Idempotent — repeated calls with the same `amount` are no-ops.
 */
async function captureReservedFundsUpToInternal(client: any, orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; alreadyCaptured?: boolean }> {
  const reserve = await client.walletTransaction.findFirst({
    where: { orderId, type: 'WALLET_RESERVE' },
  })
  if (!reserve) return { success: false, error: 'No reservation found. Reserve wallet funds first.' }

  const captures = await client.walletTransaction.findMany({
    where: { orderId, type: 'WALLET_CAPTURE' },
    select: { amount: true },
  })
  const alreadyCaptured = captures.reduce((s: number, c: any) => s + Math.abs(Number(c.amount || 0)), 0)
  if (alreadyCaptured >= amount) return { success: true, alreadyCaptured: true }

  const reserved = Math.abs(Number(reserve.amount || 0))
  const delta = Math.min(amount - alreadyCaptured, Math.max(0, reserved - alreadyCaptured))
  if (delta <= 0) return { success: true, alreadyCaptured: true }

  await client.walletTransaction.create({
    data: { businessId, orderId, amount: delta, type: 'WALLET_CAPTURE', description: `Captured ${delta} for order ${orderId}` },
  })
  return { success: true }
}

/**
 * Capture reserved funds up to a cumulative total (partial-fulfillment aware).
 * Never captures more than the reservation; idempotent per target amount.
 */
export async function captureReservedFundsUpTo(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; alreadyCaptured?: boolean }> {
  try {
    const result = await prisma.$transaction((tx) => captureReservedFundsUpToInternal(tx, orderId, businessId, amount))
    if (!result.success) return result

    await createTimelineEvent(orderId, { eventType: 'WALLET_CAPTURED', message: `Wallet captured: ${amount}` })
    return { success: true, alreadyCaptured: result.alreadyCaptured }
  } catch (e: any) {
    return { success: false, error: e.message || 'Capture failed' }
  }
}

/** Tx-aware variant for callers that need capture atomic with their own transaction. */
export function captureReservedFundsUpToInTx(client: any, orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; alreadyCaptured?: boolean }> {
  return captureReservedFundsUpToInternal(client, orderId, businessId, amount)
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
 * Release reserved funds up to a cumulative total — partial-fulfillment aware.
 *
 * Used when an order is partially fulfilled: captured units stay charged while the
 * un-captured remainder of the reservation is returned to the wallet exactly once.
 * Never releases more than `reserved − captured − alreadyReleased`, so the sum of
 * (captured + released) can never exceed the reservation. Idempotent per target.
 */
export async function releaseReservedFundsUpTo(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; released?: number }> {
  try {
    const reserve = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_RESERVE' },
    })
    if (!reserve) return { success: true, released: 0 }

    const reserved = Math.abs(Number(reserve.amount || 0))
    const [captures, releases, refunds] = await Promise.all([
      prisma.walletTransaction.findMany({ where: { orderId, type: 'WALLET_CAPTURE' }, select: { amount: true } }),
      prisma.walletTransaction.findMany({ where: { orderId, type: 'WALLET_RELEASE' }, select: { amount: true } }),
      prisma.walletTransaction.findMany({ where: { orderId, type: 'WALLET_REFUND' }, select: { amount: true } }),
    ])
    const captured = captures.reduce((s, c) => s + Math.abs(Number(c.amount || 0)), 0)
    const alreadyReleased = releases.reduce((s, c) => s + Math.abs(Number(c.amount || 0)), 0) +
      refunds.reduce((s, c) => s + Math.abs(Number(c.amount || 0)), 0)

    const available = Math.max(0, reserved - captured - alreadyReleased)
    const delta = Math.min(Math.max(0, amount - alreadyReleased), available)
    if (delta <= 0) return { success: true, released: 0 }

    await prisma.$transaction([
      prisma.business.update({
        where: { id: businessId },
        data: { walletBalance: { increment: delta } },
      }),
      prisma.walletTransaction.create({
        data: { businessId, orderId, amount: delta, type: 'WALLET_RELEASE', description: `Released ${delta} for order ${orderId}` },
      }),
    ])

    await createTimelineEvent(orderId, { eventType: 'WALLET_RELEASED', message: `Wallet released: ${delta}` })
    return { success: true, released: delta }
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
