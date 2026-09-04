import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { createTimelineEvent, transitionOrder } from './order-state-machine'
import { completeProviderFinalization } from './fulfillment'
import { releaseReservedFundsUpTo } from './wallet-actions'
import { failOrder } from './order-state-machine'
import { publishOrderLifecycleEvent, ORDER_LIFECYCLE_EVENTS } from './lifecycle-publisher'
import { normalizeConnectorInstallData, type ProviderInstallData } from '@/lib/esim/installation-data'
import { resolveAuthoritativeProviderReference, hasProviderAcceptanceEvidence, loadOrderAttemptReferences } from './provider-reference'
import { allocateProviderAttemptNumber } from './provider-attempt-number'

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
  /** ICCIDs recovered from the provider status lookup (never fabricated). */
  iccids?: string[]
  /** Canonical install data recovered from the provider status lookup. */
  installData?: ProviderInstallData
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
// Reconciliation eligibility
// ─────────────────────────────────────────────

const TERMINAL_STATUSES = ['FULFILLED', 'REFUNDED', 'CANCELLED', 'FAILED']

/**
 * Provider-neutral predicate: should this order be automatically reconciled?
 * Used by discovery (provider-self-heal, recovery sweeper) to select eligible
 * PROVIDER_RECONCILIATION orders without duplicating selection logic.
 */
export function isReconciliationEligible(order: {
  status: string
  retryCount: number
  maxRetries: number
  nextRetryAt?: Date | null
}): boolean {
  if (order.status !== 'PROVIDER_RECONCILIATION') return false
  if (order.retryCount >= order.maxRetries) return false
  if (TERMINAL_STATUSES.includes(order.status)) return false
  if (order.nextRetryAt && order.nextRetryAt.getTime() > Date.now()) return false
  return true
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

  // Recover the authoritative provider-owned reference BEFORE any provider call:
  // durable order evidence first, else the best matching ProviderAttempt reference.
  const attempts = await loadOrderAttemptReferences(orderId)
  const authoritativeRef = await resolveAuthoritativeProviderReference(order, attempts)

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

  // Provider acceptance evidence: if the order has a durable provider reference
  // (order-level or from an attempt), reconciliation exhaustion must NEVER
  // authorize a second purchase — the existing provider transaction is real.
  const acceptanceEvidence = hasProviderAcceptanceEvidence(order, attempts)

  // Try to reconcile via provider
  const result = await tryReconcileWithProvider(order, authoritativeRef)

  // Persist the attempt. Retry scheduling (attemptNum) is counted per
  // reconciliation pass; the persisted attemptNumber is globally monotonic
  // PER ORDER across all sources so it can never collide with a PURCHASE row.
  await prisma.providerAttempt.create({
    data: {
      orderId, providerId: order.providerId || '', attemptNumber: await allocateProviderAttemptNumber(orderId),
      source: 'RECONCILIATION', status: result.outcome === 'FOUND_SUCCESS' ? 'SUCCEEDED' : result.outcome === 'FOUND_FAILURE' ? 'FAILED' : 'PROCESSING',
      providerReference: result.providerReference || authoritativeRef || null,
      errorMessage: result.outcome !== 'FOUND_SUCCESS' ? result.message : null,
      startedAt: new Date(), completedAt: new Date(),
    },
  })

  switch (result.outcome) {
    case 'FOUND_SUCCESS': {
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION_SUCCESS', message: result.message })
      const existingIccids = order.esims.map((e: any) => e.iccid).filter(Boolean)
      const recoveredIccids = (result.iccids || []).filter(Boolean)
      const iccids = [...new Set([...existingIccids, ...recoveredIccids])]
      const installData = result.installData || {}

      // Canonical finalizer is ICCID-backed: wallet capture and FULFILLED are
      // only legal once real eSIM records exist. A provider status carrying
      // install/activation data but ZERO ICCIDs must NEVER be treated as
      // locally finalizable (fail closed, wallet held, no redispatch). An ICCID
      // is never fabricated from activationCode/order id/matching id.
      const hasFulfillmentIdentity = iccids.length > 0
      if (!hasFulfillmentIdentity) {
        await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION_TIMEOUT', message: 'Provider reports success but returned no ICCID identity to finalize' })
        if (acceptanceEvidence && isRedispatchAllowed(attemptNum)) {
          await createTimelineEvent(orderId, { eventType: 'REDISPATCH_BLOCKED', message: 'Provider acceptance evidence exists but no ICCID identity — no redispatch; existing provider transaction must be resolved' })
        }
        await transitionOrder(orderId, 'PROVIDER_RECONCILIATION')
        return { ...result, outcome: 'STILL_PENDING', action: 'KEEP_WAITING', status: 'PROVIDER_RECONCILIATION', message: 'Provider reports success but no ICCID identity was returned' }
      }

      const ref = result.providerReference || order.providerFulfillId || ''
      const finalResult = await completeProviderFinalization({
        orderId, businessId: order.businessId, providerId: order.providerId || '',
        providerRef: ref,
        providerName: order.provider?.name || '', totalAmount: Number(order.totalAmount),
        providerResult: { iccids, ...installData },
        userId: order.userId,
      })

      if (finalResult && finalResult.success === false) {
        await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION_TIMEOUT', message: finalResult.error || 'Finalization incomplete' })
        await transitionOrder(orderId, 'PROVIDER_RECONCILIATION')
        return { ...result, outcome: 'STILL_PENDING', action: 'KEEP_WAITING', status: 'PROVIDER_RECONCILIATION', message: finalResult.error || 'Finalization incomplete' }
      }
      return { ...result, action: 'FINALIZED', status: 'FULFILLED' }
    }

    case 'FOUND_FAILURE': {
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION_FAILED', message: result.message })
      // Release ONLY the un-captured remainder. For partially fulfilled orders the
      // captured units stay charged; for untouched orders the full reservation returns.
      await releaseReservedFundsUpTo(orderId, order.businessId, Number(order.totalAmount))
      await failOrder(orderId, `Provider confirmed failure: ${result.message}`)
      return { ...result, action: 'FAILED', status: 'FAILED' }
    }

    case 'STILL_PENDING': {
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION_TIMEOUT', message: result.message })
      if (acceptanceEvidence && isRedispatchAllowed(attemptNum)) {
        await createTimelineEvent(orderId, { eventType: 'REDISPATCH_BLOCKED', message: 'Provider acceptance evidence exists — no redispatch even after reconciliation exhaustion; existing provider transaction must be resolved' })
      }
      // Keep in reconciliation with increased delay
      await transitionOrder(orderId, 'PROVIDER_RECONCILIATION')
      return { ...result, action: 'KEEP_WAITING', status: 'PROVIDER_RECONCILIATION' }
    }

    case 'NOT_FOUND': {
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION_TIMEOUT', message: result.message })
      // REDISPATCH SAFETY: only a reconciliation with NO provider acceptance
      // evidence may eventually authorize a controlled redispatch. When durable
      // provider reference evidence exists, exhaustion keeps the order in
      // reconciliation — a second purchase must not be created to resolve it.
      const redispatch = !acceptanceEvidence && isRedispatchAllowed(attemptNum)
      if (redispatch) {
        await createTimelineEvent(orderId, { eventType: 'REDISPATCH_ALLOWED', message: 'Max reconciliation attempts reached — redispatch allowed' })
      } else if (acceptanceEvidence) {
        await createTimelineEvent(orderId, { eventType: 'REDISPATCH_BLOCKED', message: 'Provider acceptance evidence exists — no redispatch; existing provider transaction must be resolved' })
      }
      return { ...result, action: redispatch ? 'REDISPATCH_ALLOWED' : 'KEEP_WAITING', status: 'PROVIDER_RECONCILIATION' }
    }

    case 'UNSUPPORTED':
      return { ...result, action: 'UNSUPPORTED', status: order.status }
  }
}

// ─────────────────────────────────────────────
// Provider reconciliation attempt
// ─────────────────────────────────────────────

async function tryReconcileWithProvider(order: any, authoritativeRef: string | null): Promise<ReconciliationResult> {
  if (!order.providerId) return { outcome: 'UNSUPPORTED', message: 'No provider linked' }

  try {
    const adapter = await getAdapterForType(order.provider.type, {
      apiBaseUrl: order.provider.apiBaseUrl,
      apiToken: order.provider.apiToken,
      providerId: order.provider.id,
      environment: order.provider.environment,
      authUrl: order.provider.authUrl,
    })

    const refParam = authoritativeRef
    const existingIccids = order.esims.map((e: any) => e.iccid).filter(Boolean)

    // Strategy 1: Poll by the authoritative provider-owned reference (order-level
    // evidence or the best matching ProviderAttempt reference). Local OneSIM ids
    // are never used; only refParam is sent upstream.
    if (refParam && typeof (adapter as any).getActivationStatus === 'function') {
      try {
        const statusResult = await (adapter as any).getActivationStatus(refParam)
        if (statusResult.success && statusResult.data) {
          const status = (statusResult.data.status || '').toUpperCase()
          const returnedIccids: string[] = [
            ...((statusResult.data.iccids || []).filter((v: any) => v != null && String(v).trim() !== '').map(String)),
            ...(statusResult.data.iccid ? [String(statusResult.data.iccid)] : []),
          ]
          const installData = normalizeConnectorInstallData(statusResult.data)

          if (['ACTIVE', 'FULFILLED', 'COMPLETED', 'INSTALLED'].includes(status)) {
            return {
              outcome: 'FOUND_SUCCESS',
              message: `Provider confirms success — status: ${status}`,
              providerReference: refParam,
              providerStatus: status,
              iccids: returnedIccids,
              installData,
            }
          }
          if (['FAILED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(status)) {
            return { outcome: 'FOUND_FAILURE', message: `Provider confirms failure — status: ${status}`, providerReference: refParam, providerStatus: status }
          }
          if (['PENDING', 'PROCESSING', 'QUEUED', 'RESERVED'].includes(status)) {
            return { outcome: 'STILL_PENDING', message: `Provider still processing — status: ${status}`, providerReference: refParam, providerStatus: status }
          }
        } else if (statusResult && statusResult.success === false) {
          // Preserve the REAL lookup error. If the order carries a durable
          // provider reference, "cannot confirm" is STILL_PENDING (wallet held,
          // never redispatch). Only genuinely evidence-less orders may reach
          // NOT_FOUND/controlled redispatch.
          const code = String(statusResult.error?.code || 'UNKNOWN')
          const transient = ['TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'HTTP_50', 'HTTP_5']
            .some((c) => code.startsWith(c))
          return refParam
            ? { outcome: 'STILL_PENDING', message: `Provider status query failed (${code}) — reference preserved`, providerReference: refParam }
            : { outcome: transient ? 'STILL_PENDING' : 'NOT_FOUND', message: `Provider status query failed (${code})` }
        }
      } catch { /* fall through to next strategy */ }
    }

    // Strategy 2: Search by ICCID — ONLY when no authoritative reference exists
    // (providers whose status endpoint is keyed by ICCID).
    if (!refParam && existingIccids.length > 0 && typeof (adapter as any).getActivationStatus === 'function') {
      for (const iccid of existingIccids) {
        try {
          const statusResult = await (adapter as any).getActivationStatus(iccid)
          if (statusResult.success && statusResult.data) {
            return { outcome: 'FOUND_SUCCESS', message: `Provider found ICCID — status confirmed`, providerReference: iccid, iccids: [iccid], installData: normalizeConnectorInstallData(statusResult.data) }
          }
        } catch { continue }
      }
    }

    // Strategy 3: Connector-specific read-only reconciliation (e.g. Choice
    // bundle_code search). The connector's reconcileAmbiguousPurchase is
    // provider-owned and NEVER repeats the activation POST.
    try {
      const connector = await buildConnectorFromProvider(order.providerId).catch(() => null)
      if (connector && typeof (connector as any).reconcileAmbiguousPurchase === 'function') {
        const recResult = await (connector as any).reconcileAmbiguousPurchase({
          orderId: order.id,
          planId: order.package?.providerPlanId || '',
          quantity: order.quantity || 1,
          attemptedAt: order.createdAt?.toISOString() || '',
        })
        if (recResult?.success && recResult.data?.resolved && recResult.data?.iccid) {
          return { outcome: 'FOUND_SUCCESS', message: `Connector reconciliation resolved — ICCID: ${recResult.data.iccid}`, providerReference: recResult.data.iccid, iccids: [recResult.data.iccid] }
        }
        if (recResult?.success && recResult.data?.reason === 'confirmed-failed') {
          return { outcome: 'FOUND_FAILURE', message: 'Connector confirmed provider failure via reconciliation' }
        }
      }
    } catch { /* connector reconciliation is best-effort */ }

    // No authoritative reference and no local ICCID fallback: there is nothing to
    // poll, so remain reconciling (STILL_PENDING) rather than fabricating a
    // "not found". Controlled redispatch for genuinely fresh, evidence-less
    // orders is owned by the recovery classifier, never invented here.
    return refParam
      ? { outcome: 'STILL_PENDING', message: 'Provider query returned no terminal status — reference preserved', providerReference: refParam }
      : { outcome: 'STILL_PENDING', message: 'Provider query returned no terminal status' }
  } catch (e: any) {
    const msg = (e.message || '').toLowerCase()
    if (msg.includes('timeout') || msg.includes('network') || msg.includes('503') || msg.includes('502') || msg.includes('504') || authoritativeRef) {
      return { outcome: 'STILL_PENDING', message: `Provider unreachable: ${e.message?.slice(0, 100)}`, providerReference: authoritativeRef || undefined }
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
