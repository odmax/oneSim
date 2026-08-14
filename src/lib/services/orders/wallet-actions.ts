import { prisma } from '@/lib/prisma'
import { createTimelineEvent } from './order-state-machine'

/**
 * Billing reference for a wallet ledger entry.
 * Exactly one of orderId (purchase) / topUpId (top-up) is set — they are never
 * both populated, so purchase and top-up money movement can never collide.
 */
export type BillingRef = { orderId: string } | { topUpId: string }

function billingTarget(ref: BillingRef): string {
  return 'orderId' in ref ? `order ${ref.orderId}` : `top-up ${ref.topUpId}`
}

function billingKey(ref: BillingRef): { orderId?: string; topUpId?: string } {
  return 'orderId' in ref ? { orderId: ref.orderId } : { topUpId: ref.topUpId }
}

// ─────────────────────────────────────────────
// Shared core (reference-agnostic)
// ─────────────────────────────────────────────

/**
 * Reserve wallet funds for a billing reference.
 * Deducts from business.walletBalance and creates a RESERVE ledger entry keyed by
 * the reference. If the reference already has a RESERVE entry, returns success.
 * The balance check and decrement run in one conditional update (atomic).
 */
async function reserveCore(client: any, ref: BillingRef, businessId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  const existing = await client.walletTransaction.findFirst({
    where: { ...billingKey(ref), type: 'WALLET_RESERVE' },
  })
  if (existing) return { success: true }

  const business = await client.business.findUnique({ where: { id: businessId }, select: { walletBalance: true } })
  if (!business) return { success: false, error: 'Business not found' }

  const updated = await client.business.updateMany({
    where: { id: businessId, walletBalance: { gte: amount } },
    data: { walletBalance: { decrement: amount } },
  })
  if (updated.count === 0) {
    const balance = Number(business.walletBalance)
    return { success: false, error: `Insufficient wallet balance. Required: ${amount}, Available: ${balance}` }
  }

  await client.walletTransaction.create({
    data: { businessId, ...billingKey(ref), amount: -amount, type: 'WALLET_RESERVE', description: `Reserved ${amount} for ${billingTarget(ref)}` },
  })
  return { success: true }
}

/**
 * Capture reserved funds, capped at a CUMULATIVE total for the reference.
 * Each call captures only the delta (amount − alreadyCaptured) and never exceeds
 * the reservation. Idempotent — repeated calls with the same target are no-ops.
 */
async function captureUpToCore(client: any, ref: BillingRef, businessId: string, amount: number): Promise<{ success: boolean; error?: string; alreadyCaptured?: boolean }> {
  const reserve = await client.walletTransaction.findFirst({
    where: { ...billingKey(ref), type: 'WALLET_RESERVE' },
  })
  if (!reserve) return { success: false, error: 'No reservation found. Reserve wallet funds first.' }

  const captures = await client.walletTransaction.findMany({
    where: { ...billingKey(ref), type: 'WALLET_CAPTURE' },
    select: { amount: true },
  })
  const alreadyCaptured = captures.reduce((s: number, c: any) => s + Math.abs(Number(c.amount || 0)), 0)
  if (alreadyCaptured >= amount) return { success: true, alreadyCaptured: true }

  const reserved = Math.abs(Number(reserve.amount || 0))
  const delta = Math.min(amount - alreadyCaptured, Math.max(0, reserved - alreadyCaptured))
  if (delta <= 0) return { success: true, alreadyCaptured: true }

  await client.walletTransaction.create({
    data: { businessId, ...billingKey(ref), amount: delta, type: 'WALLET_CAPTURE', description: `Captured ${delta} for ${billingTarget(ref)}` },
  })
  return { success: true }
}

/**
 * Release reserved funds up to a cumulative total.
 * Returns to the wallet only the un-captured remainder
 * (reserved − captured − alreadyReleased − refunds), exactly once.
 */
async function releaseUpToCore(client: any, ref: BillingRef, businessId: string, amount: number): Promise<{ success: boolean; error?: string; released?: number }> {
  const reserve = await client.walletTransaction.findFirst({
    where: { ...billingKey(ref), type: 'WALLET_RESERVE' },
  })
  if (!reserve) return { success: true, released: 0 }

  const reserved = Math.abs(Number(reserve.amount || 0))
  const [captures, releases, refunds] = await Promise.all([
    client.walletTransaction.findMany({ where: { ...billingKey(ref), type: 'WALLET_CAPTURE' }, select: { amount: true } }),
    client.walletTransaction.findMany({ where: { ...billingKey(ref), type: 'WALLET_RELEASE' }, select: { amount: true } }),
    client.walletTransaction.findMany({ where: { ...billingKey(ref), type: 'WALLET_REFUND' }, select: { amount: true } }),
  ])
  const captured = captures.reduce((s: number, c: any) => s + Math.abs(Number(c.amount || 0)), 0)
  const alreadyReleased = releases.reduce((s: number, c: any) => s + Math.abs(Number(c.amount || 0)), 0) +
    refunds.reduce((s: number, c: any) => s + Math.abs(Number(c.amount || 0)), 0)

  const available = Math.max(0, reserved - captured - alreadyReleased)
  const delta = Math.min(Math.max(0, amount - alreadyReleased), available)
  if (delta <= 0) return { success: true, released: 0 }

  await client.$transaction([
    client.business.update({
      where: { id: businessId },
      data: { walletBalance: { increment: delta } },
    }),
    client.walletTransaction.create({
      data: { businessId, ...billingKey(ref), amount: delta, type: 'WALLET_RELEASE', description: `Released ${delta} for ${billingTarget(ref)}` },
    }),
  ])
  return { success: true, released: delta }
}

async function refundCore(client: any, ref: BillingRef, businessId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  const captured = await client.walletTransaction.findFirst({
    where: { ...billingKey(ref), type: 'WALLET_CAPTURE' },
  })
  if (!captured) return { success: false, error: 'No captured funds to refund. Capture wallet first.' }

  const refunded = await client.walletTransaction.findFirst({
    where: { ...billingKey(ref), type: 'WALLET_REFUND' },
  })
  if (refunded) return { success: true }

  await client.$transaction([
    client.business.update({
      where: { id: businessId },
      data: { walletBalance: { increment: amount } },
    }),
    client.walletTransaction.create({
      data: { businessId, ...billingKey(ref), amount, type: 'WALLET_REFUND', description: `Refunded ${amount} for ${billingTarget(ref)}` },
    }),
  ])
  return { success: true }
}

// ─────────────────────────────────────────────
// PURCHASE wallet lifecycle (keyed by orderId → ESIMPurchase.id)
// ─────────────────────────────────────────────

/**
 * Reserve wallet funds for a purchase order.
 * Deducts from business.walletBalance and creates a RESERVE ledger entry.
 * If the order already has a RESERVE entry, returns success (idempotent).
 */
export async function reserveWalletFunds(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await prisma.$transaction((tx) => reserveCore(tx, { orderId }, businessId, amount))
    if (!result.success) return result
    await createTimelineEvent(orderId, { eventType: 'WALLET_RESERVED', message: `Wallet reserved: ${amount}` })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message || 'Reservation failed' }
  }
}

/**
 * Capture reserved funds for a purchase (confirm the charge after provider success).
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
 * Capture reserved purchase funds up to a cumulative total (partial-fulfillment aware).
 * Never captures more than the reservation; idempotent per target amount.
 */
export async function captureReservedFundsUpTo(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; alreadyCaptured?: boolean }> {
  try {
    const result = await prisma.$transaction((tx) => captureUpToCore(tx, { orderId }, businessId, amount))
    if (!result.success) return result
    await createTimelineEvent(orderId, { eventType: 'WALLET_CAPTURED', message: `Wallet captured: ${amount}` })
    return { success: true, alreadyCaptured: result.alreadyCaptured }
  } catch (e: any) {
    return { success: false, error: e.message || 'Capture failed' }
  }
}

/** Tx-aware purchase capture variant for callers that need capture atomic with their own transaction. */
export function captureReservedFundsUpToInTx(client: any, orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; alreadyCaptured?: boolean }> {
  return captureUpToCore(client, { orderId }, businessId, amount)
}

/**
 * Release reserved purchase funds (on provider rejection/failure).
 * Refunds the reserved amount back to wallet balance.
 *
 * Guards:
 * - Does NOT release if WALLET_CAPTURE already exists (funds already collected)
 * - Does NOT release if WALLET_REFUND exists
 * - Does NOT release if WALLET_RELEASE already exists (idempotent)
 * - Does NOT release if provider fulfillment evidence exists on the order
 */
export async function releaseReservedFunds(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; blocked?: boolean }> {
  try {
    const released = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_RELEASE' },
    })
    if (released) return { success: true }

    const captured = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_CAPTURE' },
    })
    if (captured) return { success: false, error: 'Funds already captured — cannot release', blocked: true }

    const refunded = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'WALLET_REFUND' },
    })
    if (refunded) return { success: false, error: 'Funds already refunded — cannot release', blocked: true }

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
    if (!reserve) return { success: true }

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
 * Release reserved purchase funds up to a cumulative total — partial-fulfillment aware.
 * Never releases more than `reserved − captured − alreadyReleased`, so the sum of
 * (captured + released) can never exceed the reservation. Idempotent per target.
 */
export async function releaseReservedFundsUpTo(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; released?: number }> {
  try {
    return await releaseUpToCore(prisma, { orderId }, businessId, amount)
  } catch (e: any) {
    return { success: false, error: e.message || 'Release failed' }
  }
}

/** Refund captured purchase funds (post-fulfillment refund). */
export async function refundCapturedFunds(orderId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  try {
    return await refundCore(prisma, { orderId }, businessId, amount)
  } catch (e: any) {
    return { success: false, error: e.message || 'Refund failed' }
  }
}

// ─────────────────────────────────────────────
// TOP-UP wallet lifecycle (keyed by topUpId → ESIMTopUp.id)
// ─────────────────────────────────────────────
//
// Top-ups are their own billing identity (F1): reserve/capture/release are keyed
// by topUpId and can never short-circuit or collide with the purchase ledger.
// No provider-evidence purchase guard applies — the top-up state machine decides
// when a release is safe (definite provider failure only).

/**
 * Reserve wallet funds for a top-up.
 * Deducts from business.walletBalance, keyed by the top-up id. Idempotent.
 */
export async function reserveTopUpFunds(topUpId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  try {
    return await prisma.$transaction((tx) => reserveCore(tx, { topUpId }, businessId, amount))
  } catch (e: any) {
    return { success: false, error: e.message || 'Reservation failed' }
  }
}

/**
 * Capture reserved top-up funds up to a cumulative total.
 * Same cumulative/idempotent semantics as the purchase variant.
 */
export async function captureTopUpFundsUpTo(topUpId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; alreadyCaptured?: boolean }> {
  try {
    const result = await prisma.$transaction((tx) => captureUpToCore(tx, { topUpId }, businessId, amount))
    if (!result.success) return result
    return { success: true, alreadyCaptured: result.alreadyCaptured }
  } catch (e: any) {
    return { success: false, error: e.message || 'Capture failed' }
  }
}

/** Tx-aware top-up capture variant for callers that capture inside their own transaction. */
export function captureTopUpFundsUpToInTx(client: any, topUpId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; alreadyCaptured?: boolean }> {
  return captureUpToCore(client, { topUpId }, businessId, amount)
}

/**
 * Release reserved top-up funds (definite provider failure).
 * Returns only the un-captured remainder to the wallet, exactly once.
 */
export async function releaseTopUpFundsUpTo(topUpId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; released?: number }> {
  try {
    return await releaseUpToCore(prisma, { topUpId }, businessId, amount)
  } catch (e: any) {
    return { success: false, error: e.message || 'Release failed' }
  }
}

/** Tx-aware top-up release variant for callers that release inside their own transaction. */
export function releaseTopUpFundsUpToInTx(client: any, topUpId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string; released?: number }> {
  return releaseUpToCore(client, { topUpId }, businessId, amount)
}

/** Refund captured top-up funds (post-capture top-up refund). */
export async function refundTopUpFunds(topUpId: string, businessId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  try {
    return await refundCore(prisma, { topUpId }, businessId, amount)
  } catch (e: any) {
    return { success: false, error: e.message || 'Refund failed' }
  }
}
