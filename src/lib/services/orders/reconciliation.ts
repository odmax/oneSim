import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { createTimelineEvent, transitionOrder } from './order-state-machine'
import { completeProviderFinalization } from './fulfillment'
import { releaseReservedFunds } from './wallet-actions'
import { failOrder } from './order-state-machine'
import { publishOrderLifecycleEvent, ORDER_LIFECYCLE_EVENTS } from './lifecycle-publisher'

// ─────────────────────────────────────────────
// Reconciliation outcome types
// ─────────────────────────────────────────────

export type ReconciliationOutcome =
  | 'FOUND_SUCCESS'
  | 'FOUND_FAILURE'
  | 'STILL_PENDING'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'

export interface ReconciliationResult {
  outcome: ReconciliationOutcome
  providerStatus?: string
  providerReference?: string
  message: string
}

// ─────────────────────────────────────────────
// Reconciliation retry delays (in ms)
// ─────────────────────────────────────────────

export const RECONCILIATION_RETRY_DELAYS = [
  60_000,       // 1 min
  300_000,      // 5 min
  900_000,      // 15 min
  1_800_000,    // 30 min
  3_600_000,    // 1 hour
  14_400_000,   // 4 hours
  86_400_000,   // 24 hours — final attempt, then allow redispatch
] as const

const REDISPATCH_AFTER_ATTEMPT = RECONCILIATION_RETRY_DELAYS.length // Attempt 8+

/**
 * Compute the next reconciliation retry delay based on the current attempt count.
 * After the final delay, redispatch is allowed.
 */
export function getReconciliationDelay(attempt: number): number {
  if (attempt < 1) return RECONCILIATION_RETRY_DELAYS[0]
  const idx = Math.min(attempt - 1, RECONCILIATION_RETRY_DELAYS.length - 1)
  return RECONCILIATION_RETRY_DELAYS[idx]
}

export function isRedispatchAllowed(attempt: number): boolean {
  return attempt >= REDISPATCH_AFTER_ATTEMPT
}

// ─────────────────────────────────────────────
// Reconciliation engine
// ─────────────────────────────────────────────

/**
 * Reconcile an order in PROVIDER_RECONCILIATION state by checking the provider's status.
 *
 * Five outcomes:
 *   FOUND_SUCCESS → resume local finalization (no second purchase)
 *   FOUND_FAILURE → mark FAILED + release wallet
 *   STILL_PENDING → keep reconciliation state, increase retry delay
 *   NOT_FOUND → retry; after final attempt, allow redispatch
 *   UNSUPPORTED → provider doesn't support reconciliation; keep in current state
 */
export async function reconcileProviderOrder(orderId: string): Promise<ReconciliationResult & { action?: string; status?: string }> {
  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    include: {
      provider: true,
      esims: { select: { id: true, iccid: true } },
      business: { select: { id: true } },
    },
  })
  if (!order) return { outcome: 'NOT_FOUND', message: 'Order not found' }

  if (order.status === 'FULFILLED') return { outcome: 'FOUND_SUCCESS', message: 'Already fulfilled' }

  // Track reconciliation attempt
  const reconAttempts = await prisma.providerAttempt.count({
    where: { orderId, source: 'RECONCILIATION' },
  })

  const attemptNum = reconAttempts + 1

  await createTimelineEvent(orderId, {
    eventType: attemptNum === 1 ? 'PROVIDER_RECONCILIATION_STARTED' : 'PROVIDER_RECONCILIATION_RETRY',
    message: `Reconciliation attempt #${attemptNum}`,
  })

  if (attemptNum === 1) {
    publishOrderLifecycleEvent({ orderId, eventType: ORDER_LIFECYCLE_EVENTS.RECONCILIATION_REQUIRED }).catch(() => {})
  }

  // Still pending within the retry window — keep waiting
  if (attemptNum < REDISPATCH_AFTER_ATTEMPT) {
    await persistReconciliationRetry(orderId, attemptNum)
  }

  // Try to reconcile via provider
  const result = await tryReconcileWithProvider(order)

  // Persist the attempt
  await prisma.providerAttempt.create({
    data: {
      orderId, providerId: order.providerId || '', attemptNumber: attemptNum,
      source: 'RECONCILIATION', status: result.outcome === 'FOUND_SUCCESS' ? 'SUCCEEDED' : result.outcome === 'FOUND_FAILURE' ? 'FAILED' : 'PROCESSING',
      providerReference: result.providerReference || null,
      errorMessage: result.outcome !== 'FOUND_SUCCESS' ? result.message : null,
      startedAt: new Date(), completedAt: new Date(),
    },
  })

  switch (result.outcome) {
    case 'FOUND_SUCCESS': {
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION_SUCCESS', message: result.message })
      // Resume local finalization
      const { completeProviderFinalization } = await import('./fulfillment')
      const existingIccids = order.esims.map(e => e.iccid)
      const iccids = existingIccids.length > 0 ? existingIccids : []
      if (iccids.length > 0) {
        await completeProviderFinalization({
          orderId, businessId: order.businessId, providerId: order.providerId || '',
          providerRef: result.providerReference || order.providerFulfillId || '',
          providerName: order.provider?.name || '', totalAmount: Number(order.totalAmount),
          providerResult: { iccids },
          userId: order.userId,
        })
      }
      return { ...result, action: 'FINALIZED', status: 'FULFILLED' }
    }

    case 'FOUND_FAILURE': {
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION_FAILED', message: result.message })
      await releaseReservedFunds(orderId, order.businessId, Number(order.totalAmount))
      await failOrder(orderId, `Provider confirmed failure: ${result.message}`)
      return { ...result, action: 'FAILED', status: 'FAILED' }
    }

    case 'STILL_PENDING': {
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION_TIMEOUT', message: result.message })
      // Keep in reconciliation with increased delay
      await transitionOrder(orderId, 'PROVIDER_RECONCILIATION')
      return { ...result, action: 'KEEP_WAITING', status: 'PROVIDER_RECONCILIATION' }
    }

    case 'NOT_FOUND': {
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION_TIMEOUT', message: result.message })
      if (isRedispatchAllowed(attemptNum)) {
        await createTimelineEvent(orderId, { eventType: 'REDISPATCH_ALLOWED', message: 'Max reconciliation attempts reached — redispatch allowed' })
      }
      return { ...result, action: isRedispatchAllowed(attemptNum) ? 'REDISPATCH_ALLOWED' : 'KEEP_WAITING', status: 'PROVIDER_RECONCILIATION' }
    }

    case 'UNSUPPORTED':
      return { ...result, action: 'UNSUPPORTED', status: order.status }
  }
}

// ─────────────────────────────────────────────
// Provider reconciliation attempt
// ─────────────────────────────────────────────

async function tryReconcileWithProvider(order: any): Promise<ReconciliationResult> {
  if (!order.providerId) return { outcome: 'UNSUPPORTED', message: 'No provider linked' }

  try {
    const adapter = await getAdapterForType(order.provider.type, {
      apiBaseUrl: order.provider.apiBaseUrl,
      apiToken: order.provider.apiToken,
      providerId: order.provider.id,
      environment: order.provider.environment,
      authUrl: order.provider.authUrl,
    })

    const ref = order.providerFulfillId || order.providerReservationId
    const existingIccids = order.esims.map((e: any) => e.iccid).filter(Boolean)

    // Strategy 1: Poll by provider reference
    if (ref && typeof (adapter as any).getActivationStatus === 'function') {
      try {
        const statusResult = await (adapter as any).getActivationStatus(ref)
        if (statusResult.success && statusResult.data) {
          const status = (statusResult.data.status || '').toUpperCase()
          if (['ACTIVE', 'FULFILLED', 'COMPLETED', 'INSTALLED'].includes(status)) {
            return { outcome: 'FOUND_SUCCESS', message: `Provider confirms success — status: ${status}`, providerReference: ref }
          }
          if (['FAILED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(status)) {
            return { outcome: 'FOUND_FAILURE', message: `Provider confirms failure — status: ${status}`, providerReference: ref }
          }
          if (['PENDING', 'PROCESSING', 'QUEUED', 'RESERVED'].includes(status)) {
            return { outcome: 'STILL_PENDING', message: `Provider still processing — status: ${status}`, providerReference: ref }
          }
        }
      } catch { /* fall through to next strategy */ }
    }

    // Strategy 2: Search by ICCID (if we have any local ICCIDs)
    if (existingIccids.length > 0 && typeof (adapter as any).getActivationStatus === 'function') {
      for (const iccid of existingIccids) {
        try {
          const statusResult = await (adapter as any).getActivationStatus(iccid)
          if (statusResult.success && statusResult.data) {
            return { outcome: 'FOUND_SUCCESS', message: `Provider found ICCID — status confirmed`, providerReference: iccid }
          }
        } catch { continue }
      }
    }

    return { outcome: 'STILL_PENDING', message: 'Provider query returned no terminal status' }
  } catch (e: any) {
    const msg = (e.message || '').toLowerCase()
    if (msg.includes('timeout') || msg.includes('network') || msg.includes('503') || msg.includes('502') || msg.includes('504')) {
      return { outcome: 'STILL_PENDING', message: `Provider unreachable: ${e.message?.slice(0, 100)}` }
    }
    return { outcome: 'NOT_FOUND', message: `Provider lookup failed: ${e.message?.slice(0, 100)}` }
  }
}

// ─────────────────────────────────────────────
// Persistence helpers
// ─────────────────────────────────────────────

async function persistReconciliationRetry(orderId: string, attempt: number) {
  const delay = getReconciliationDelay(attempt)
  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: {
      retryCount: attempt,
      lastRetryAt: new Date(),
      nextRetryAt: new Date(Date.now() + delay),
      retryReason: `Reconciliation attempt #${attempt} — next check in ${Math.round(delay / 60000)}min`,
    },
  })
}
