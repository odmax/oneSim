import { prisma } from '@/lib/prisma'
import { createTimelineEvent } from './order-state-machine'

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type InventoryCheckResult =
  | 'AVAILABLE'
  | 'INSUFFICIENT_STOCK'
  | 'UNSUPPORTED'
  | 'UNKNOWN'
  | 'ERROR'

export interface InventoryCheckResponse {
  result: InventoryCheckResult
  availableQuantity?: number
  providerReference?: string
  message: string
}

export type ReservationStatus =
  | 'PENDING'
  | 'RESERVED'
  | 'PARTIALLY_FULFILLED'
  | 'FULFILLED'
  | 'RELEASED'
  | 'EXPIRED'
  | 'FAILED'
  | 'RECONCILIATION_REQUIRED'

// ─────────────────────────────────────────────
// Stock check (Task 3)
// ─────────────────────────────────────────────

/**
 * Check provider inventory via connector where supported.
 * UNSUPPORTED = proceed normally (no stock check available).
 * INSUFFICIENT = block order.
 */
export async function checkProviderInventory(params: {
  providerId: string
  packageId?: string
  quantity: number
}): Promise<InventoryCheckResponse> {
  const { providerId, quantity } = params
  try {
    const provider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!provider) return { result: 'UNKNOWN', message: 'Provider not found' }

    // Only AirHub, iBASIS support stock checks currently
    const supportedTypes = ['AIRHUB', 'IBASIS']
    if (!supportedTypes.includes(provider.type)) {
      return { result: 'UNSUPPORTED', message: 'Provider does not support inventory checks' }
    }

    // For providers without explicit stock count, mark unsupported
    return { result: 'UNSUPPORTED', message: 'Stock check not implemented for this provider' }
  } catch {
    return { result: 'ERROR', message: 'Inventory check failed' }
  }
}

// ─────────────────────────────────────────────
// Local reservation (Tasks 5-6)
// ─────────────────────────────────────────────

const RESERVATION_TTL_MINUTES =
  parseInt(process.env.INVENTORY_RESERVATION_TTL_MINUTES || '15', 10)

/**
 * Create a local inventory reservation before wallet reserve and provider dispatch.
 * reservationKey = `${orderId}:${providerId}:${attempt}` ensures one active reservation per order+provider attempt.
 */
export async function createInventoryReservation(params: {
  orderId: string
  providerId: string
  quantity: number
  attempt?: number
}): Promise<{ success: boolean; reservationId?: string; error?: string; duplicate?: boolean }> {
  const { orderId, providerId, quantity, attempt = 1 } = params

  const key = `${orderId}:${providerId}:${attempt}`
  const existing = await prisma.providerInventoryReservation.findUnique({
    where: { reservationKey: key },
  })
  if (existing) {
    return { success: true, reservationId: existing.id, duplicate: true } as any
  }

  try {
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000)
    const reservation = await prisma.providerInventoryReservation.create({
      data: {
        providerId, orderId, reservationKey: key,
        requestedQuantity: quantity, reservedQuantity: quantity,
        status: 'RESERVED', expiresAt,
      },
    })

    if (orderId) {
      await createTimelineEvent(orderId, {
        eventType: 'INVENTORY_RESERVED',
        message: `Reserved ${quantity} units for provider ${providerId}`,
      })
    }

    return { success: true, reservationId: reservation.id } as any
  } catch (e: any) {
    if (e.code === 'P2002' || /unique.*reservationKey/i.test(e.message || '')) {
      const dup = await prisma.providerInventoryReservation.findUnique({
        where: { reservationKey: key },
      })
      if (dup) return { success: true, reservationId: dup.id, duplicate: true } as any
    }
    return { success: false, error: e.message }
  }
}

/**
 * Mark reservation as fulfilled (converts reserved→fulfilled quantity).
 */
export async function fulfillInventoryReservation(params: {
  reservationId: string
  fulfilledQuantity: number
  providerReference?: string
}): Promise<{ success: boolean; remainingReserved: number }> {
  const { reservationId, fulfilledQuantity, providerReference } = params
  const res = await prisma.providerInventoryReservation.findUnique({ where: { id: reservationId } })
  if (!res) return { success: false, remainingReserved: 0 }

  const newFulfilled = Math.min(res.reservedQuantity, (res.fulfilledQuantity || 0) + fulfilledQuantity)
  const remainingReserved = Math.max(0, res.reservedQuantity - newFulfilled)
  const newStatus = newFulfilled > 0 && remainingReserved === 0 ? 'FULFILLED' as const
    : newFulfilled > 0 ? 'PARTIALLY_FULFILLED' as const
    : res.status as ReservationStatus

  await prisma.providerInventoryReservation.update({
    where: { id: reservationId },
    data: {
      fulfilledQuantity: newFulfilled,
      status: newStatus,
      fulfilledAt: newFulfilled >= res.reservedQuantity ? new Date() : undefined,
      providerReservationReference: providerReference || undefined,
    },
  })

  if (res.orderId) {
    await createTimelineEvent(res.orderId, {
      eventType: newStatus === 'FULFILLED' ? 'INVENTORY_FULFILLED' : 'INVENTORY_PARTIALLY_FULFILLED',
      message: `Inventory: ${newFulfilled}/${res.reservedQuantity} fulfilled`,
    })
  }

  return { success: true, remainingReserved }
}

/**
 * Release reservation (definite provider failure or local-only reservation expiry).
 * Does NOT release if provider reservation/fulfillment evidence exists.
 */
export async function releaseInventoryReservation(params: {
  reservationId: string
  releaseQuantity?: number
  reason: string
}): Promise<{ success: boolean; error?: string; blocked?: boolean }> {
  const { reservationId, reason, releaseQuantity } = params
  const res = await prisma.providerInventoryReservation.findUnique({ where: { id: reservationId } })
  if (!res) return { success: false, error: 'Reservation not found' }

  // Block release if provider fulfillment evidence exists
  if (res.providerReservationReference) {
    await prisma.providerInventoryReservation.update({
      where: { id: reservationId },
      data: { status: 'RECONCILIATION_REQUIRED' },
    })
    if (res.orderId) {
      await createTimelineEvent(res.orderId, {
        eventType: 'INVENTORY_RECONCILIATION_REQUIRED',
        message: 'Provider evidence exists — reconciliation required before release',
      })
    }
    return { success: false, blocked: true, error: 'Provider reservation evidence exists' }
  }

  const relQty = releaseQuantity || res.reservedQuantity
  const newReleased = Math.min(res.reservedQuantity, (res.releasedQuantity || 0) + relQty)
  const remaining = Math.max(0, res.reservedQuantity - (res.fulfilledQuantity || 0) - newReleased)
  const newStatus = remaining === 0 ? 'RELEASED' as const : 'PARTIALLY_FULFILLED' as const

  await prisma.providerInventoryReservation.update({
    where: { id: reservationId },
    data: { releasedQuantity: newReleased, status: newStatus, releasedAt: new Date() },
  })

  if (res.orderId) {
    await createTimelineEvent(res.orderId, {
      eventType: 'INVENTORY_RELEASED',
      message: `Inventory released: ${newReleased} units — ${reason}`,
    })
  }

  return { success: true }
}

/**
 * Sweep expired local-only reservations.
 */
export async function sweepExpiredReservations(): Promise<{
  scanned: number; expired: number; released: number; reconciliation: number
}> {
  const now = new Date()
  const expired = await prisma.providerInventoryReservation.findMany({
    where: {
      status: { in: ['RESERVED', 'PENDING', 'PARTIALLY_FULFILLED'] },
      expiresAt: { lt: now },
    },
    take: 100,
  })

  let released = 0
  let reconciliation = 0

  for (const res of expired) {
    if (res.providerReservationReference) {
      await prisma.providerInventoryReservation.update({
        where: { id: res.id },
        data: { status: 'RECONCILIATION_REQUIRED', expiresAt: new Date(Date.now() + 3600000) },
      })
      reconciliation++
    } else {
      await releaseInventoryReservation({
        reservationId: res.id,
        releaseQuantity: res.reservedQuantity - (res.fulfilledQuantity || 0),
        reason: 'Reservation expired',
      })
      released++
    }
  }

  return { scanned: expired.length, expired: expired.length, released, reconciliation }
}
