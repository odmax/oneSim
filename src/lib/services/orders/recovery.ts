import { prisma } from '@/lib/prisma'
import { createTimelineEvent } from './order-state-machine'
import { resumeProviderFinalization } from './fulfillment'
import { releaseReservedFunds } from './wallet-actions'
import { classifyRetry } from '@/lib/services/routing/provider-failover-engine'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { isProviderOperational } from '@/lib/providers/adapter-manager'
import { transitionOrder } from './order-state-machine'
import { reconcileProviderOrder } from './reconciliation'
import { resolvePackageBacking } from './package-backing-resolver'
import type { classifyRetry as ClassifyRetryFn } from '@/lib/services/routing/provider-failover-engine'

// ─────────────────────────────────────────────
// Recovery Classification (Task 2)
// ─────────────────────────────────────────────

export type RecoveryAction =
  | 'RESUME_LOCAL_FINALIZATION'
  | 'POLL_PROVIDER'
  | 'REDISPATCH_PROVIDER'
  | 'RECONCILIATION_REQUIRED'
  | 'NOT_RETRYABLE'
  | 'ALREADY_COMPLETE'

export interface RecoveryClassification {
  action: RecoveryAction
  reason: string
}

interface ClassificationInput {
  order: {
    id: string
    status: string
    providerFulfillId?: string | null
    providerReservationId?: string | null
    retryCount: number
    maxRetries: number
    providerId?: string | null
    businessId: string
    totalAmount: any
  }
  esims: Array<{ id: string; iccid: string }>
    walletReserved: boolean
    walletCaptured: boolean
    walletReleased?: boolean
  providerAttempts: Array<{
    id: string
    status: string
    source: string
    retryClassification?: string | null
    errorCode?: string | null
    providerReference?: string | null
  }>
  providerPollingSupported: boolean
}

const TERMINAL_ORDER_STATUSES = ['FULFILLED', 'REFUNDED']
const STALE_STATUSES = ['CANCELLED', 'EXPIRED']

/**
 * Classify what recovery action an order requires.
 * Returns one of six outcomes based on stored evidence.
 */
export function classifyOrderRecovery(input: ClassificationInput): RecoveryClassification {
  const { order, esims, walletReserved, walletCaptured, walletReleased, providerAttempts, providerPollingSupported } = input
  const status = order.status

  // Already complete
  if (status === 'FULFILLED' && walletCaptured && esims.length >= 1) {
    return { action: 'ALREADY_COMPLETE', reason: 'Order already fulfilled with eSIMs and captured wallet' }
  }

  // Terminal — do not retry
  if (STALE_STATUSES.includes(status)) {
    return { action: 'NOT_RETRYABLE', reason: `Order status is ${status} — terminal state` }
  }

  if (order.retryCount >= order.maxRetries) {
    return { action: 'NOT_RETRYABLE', reason: `Max retries reached (${order.retryCount}/${order.maxRetries})` }
  }

  // Provider fulfillment evidence exists → resume local finalization
  const hasFulfillEvidence = Boolean(order.providerFulfillId || order.providerReservationId)
  if (hasFulfillEvidence && status !== 'FULFILLED') {
    if (esims.length >= 1 && !walletCaptured) {
      return { action: 'RESUME_LOCAL_FINALIZATION', reason: 'Provider fulfilled — wallet capture pending' }
    }
    if (esims.length === 0) {
      return { action: 'RESUME_LOCAL_FINALIZATION', reason: 'Provider fulfilled — eSIM persistence pending' }
    }
  }

  // Check provider attempts for pending/processing
  const pendingAttempt = providerAttempts.find(a => a.status === 'PROCESSING' || a.status === 'STARTED')
  if (pendingAttempt?.providerReference && providerPollingSupported) {
    return { action: 'POLL_PROVIDER', reason: `Provider has pending/processing attempt — polling supported` }
  }

  // Check for definite pre-acceptance failure (redispatch)
  const lastAttempt = providerAttempts[0]
  const wasNonRetryable = lastAttempt?.retryClassification === 'NON_RETRYABLE'
  const isDefiniteFailure = lastAttempt && lastAttempt.status === 'FAILED' && !pendingAttempt && !hasFulfillEvidence

  // Uncertain outcomes (timeout/network errors) — must check BEFORE definite failure
  const uncertainPatterns = ['TIMEOUT', 'NETWORK_ERROR', 'GATEWAY_TIMEOUT', 'SERVICE_UNAVAILABLE', 'RATE_LIMITED']
  if (lastAttempt && uncertainPatterns.includes(lastAttempt.errorCode || '')) {
    return { action: 'RECONCILIATION_REQUIRED', reason: `Uncertain outcome — ${lastAttempt.errorCode} — manual reconciliation required` }
  }

  // Provider errors that are business rejections = NOT retryable
  const nonRetryableCodes = [
    'AUTH_FAILED', 'INVALID_PACKAGE', 'INSUFFICIENT_BALANCE', 'PROVIDER_FAILED',
    'VALIDATION_FAILED', 'INVALID_INPUT', 'DUPLICATE', 'NOT_SUPPORTED',
    'PROVIDER_NO_PURCHASE', 'CONFIG_INVALID', 'ORDER_CREATE_FAILED',
    'BUSINESS_NOT_FOUND', 'BUSINESS_SUSPENDED', 'PACKAGE_UNAVAILABLE',
    'PACKAGE_NOT_FOUND', 'NO_PROVIDER', 'OUT_OF_STOCK',
  ]
  if (lastAttempt && nonRetryableCodes.includes(lastAttempt.errorCode || '')) {
    return { action: 'NOT_RETRYABLE', reason: `Provider rejected with non-retryable error: ${lastAttempt.errorCode}` }
  }

  // Definite failure, retryable → redispatch — but only if funds are still held.
  // If the wallet already released/refunded, a fresh provider success could not
  // be captured; route to reconciliation instead of risking a free purchase.
  if (isDefiniteFailure && !wasNonRetryable && !hasFulfillEvidence) {
    if (walletReleased) {
      return { action: 'RECONCILIATION_REQUIRED', reason: 'Definite failure but funds were already released/refunded — manual reconciliation required' }
    }
    return { action: 'REDISPATCH_PROVIDER', reason: 'Definite pre-acceptance failure — safe to retry' }
  }

  // No attempts but order is stuck in a pre-fulfillment state
  if (providerAttempts.length === 0 && !hasFulfillEvidence) {
    // If the order was just created and still has wallet reserved, it's fresh
    if (['CREATED', 'PAYMENT_RESERVED', 'PENDING_PROVIDER'].includes(status) && walletReserved && !walletCaptured && !walletReleased) {
      return { action: 'REDISPATCH_PROVIDER', reason: 'Order created but no provider attempt recorded — retrying' }
    }
  }

  // Already in PROVIDER_RECONCILIATION — feed back through the reconciliation
  // engine (poll provider + connector-specific read-only search).
  if (status === 'PROVIDER_RECONCILIATION') {
    return { action: 'RECONCILIATION_REQUIRED', reason: 'Order in PROVIDER_RECONCILIATION — re-checking provider status' }
  }

  // Default: not retryable
  return { action: 'NOT_RETRYABLE', reason: 'Cannot classify recovery — insufficient data' }
}

// ─────────────────────────────────────────────
// Retry Backoff (Task 8)
// ─────────────────────────────────────────────

/**
 * Compute exponential backoff delay capped at 60 minutes.
 * Policy: attempt 1→1m, 2→5m, 3→15m, 4→30m, 5+→60m
 */
export function computeRetryBackoff(attempt: number): number {
  const delays = [60_000, 300_000, 900_000, 1_800_000, 3_600_000]
  if (attempt < 1) attempt = 1
  const idx = Math.min(attempt - 1, delays.length - 1)
  return delays[idx]
}

export function computeNextRetryAt(attempt: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + computeRetryBackoff(attempt))
}

// ─────────────────────────────────────────────
// Main Recovery Entry Point (Tasks 3-7)
// ─────────────────────────────────────────────

export interface RecoverOrderResult {
  success: boolean
  action: RecoveryAction
  status: string
  retryCount: number
  nextRetryAt?: Date
  message?: string
}

/**
 * Classify and execute the appropriate recovery action for an order.
 * Idempotent — safe to call multiple times.
 */
export async function recoverOrder(orderId: string): Promise<RecoverOrderResult> {
  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    include: {
      esims: { select: { id: true, iccid: true, status: true } },
      provider: { select: { id: true, code: true, type: true, supportsUsage: true, supportsSuspendResume: true } },
      business: { select: { id: true, walletBalance: true, status: true } },
    },
  })
  if (!order) return { success: false, action: 'NOT_RETRYABLE', status: 'UNKNOWN', retryCount: 0, message: 'Order not found' }

  // Already complete
  if (order.status === 'FULFILLED' || order.status === 'REFUNDED') {
    return { success: true, action: 'ALREADY_COMPLETE', status: order.status, retryCount: order.retryCount, message: `Order already ${order.status}` }
  }

  // Load wallet transaction state
  const [reserveTx, captureTx, releaseTx, refundTx] = await Promise.all([
    prisma.walletTransaction.findFirst({ where: { orderId, type: 'WALLET_RESERVE' } }),
    prisma.walletTransaction.findFirst({ where: { orderId, type: 'WALLET_CAPTURE' } }),
    prisma.walletTransaction.findFirst({ where: { orderId, type: 'WALLET_RELEASE' } }),
    prisma.walletTransaction.findFirst({ where: { orderId, type: 'WALLET_REFUND' } }),
  ])
  // Funds that already went back to the wallet — a later provider success must
  // never capture them again (free purchase), so redispatch is off the table.
  const walletReleased = Boolean(releaseTx || refundTx)

  // Load provider attempts
  const providerAttempts = await prisma.providerAttempt.findMany({
    where: { orderId },
    orderBy: { attemptNumber: 'desc' },
    select: { id: true, status: true, source: true, retryClassification: true, errorCode: true, providerReference: true },
  })

  // Provider polling support check
  const providerPollingSupported = order.providerId ? true : false

  const classification = classifyOrderRecovery({
    order: {
      id: order.id, status: order.status,
      providerFulfillId: order.providerFulfillId,
      providerReservationId: order.providerReservationId,
      retryCount: order.retryCount, maxRetries: order.maxRetries,
      providerId: order.providerId, businessId: order.businessId,
      totalAmount: order.totalAmount,
    },
    esims: order.esims.map(e => ({ id: e.id, iccid: e.iccid })),
    walletReserved: !!reserveTx,
    walletCaptured: !!captureTx,
    walletReleased,
    providerAttempts,
    providerPollingSupported,
  })

  await createTimelineEvent(orderId, { eventType: 'ORDER_RECOVERY_CLASSIFIED', message: `${classification.action}: ${classification.reason}` })

  switch (classification.action) {
    case 'RESUME_LOCAL_FINALIZATION': {
      await createTimelineEvent(orderId, { eventType: 'LOCAL_FINALIZATION_RETRY_STARTED', message: 'Resuming local finalization' })
      const result = await resumeProviderFinalization(orderId)
      if (result.success) {
        await persistRecoverySuccess(orderId, order.retryCount)
        await createTimelineEvent(orderId, { eventType: 'LOCAL_FINALIZATION_RETRY_SUCCEEDED', message: 'Local finalization resumed successfully' })
        return { success: true, action: 'RESUME_LOCAL_FINALIZATION', status: result.orderStatus, retryCount: order.retryCount, message: 'Local finalization resumed' }
      }
      await persistRecoveryFailure(orderId, order.retryCount, result.error || 'Local finalization failed')
      await createTimelineEvent(orderId, { eventType: 'LOCAL_FINALIZATION_RETRY_FAILED', message: result.error || 'Local finalization failed' })
      return { success: false, action: 'RESUME_LOCAL_FINALIZATION', status: order.status, retryCount: order.retryCount + 1, nextRetryAt: computeNextRetryAt(order.retryCount + 1), message: result.error || 'Local finalization failed' }
    }

    case 'POLL_PROVIDER': {
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_POLL_STARTED', message: 'Polling provider status' })
      const pollingResult = await pollProviderForOrder(order)
      if (pollingResult.fulfilled) {
        await createTimelineEvent(orderId, { eventType: 'PROVIDER_REDISPATCH_SUCCEEDED', message: 'Provider polled — fulfilled' })
        return { success: true, action: 'POLL_PROVIDER', status: pollingResult.status, retryCount: order.retryCount, message: 'Provider fulfillment confirmed via polling' }
      }
      if (pollingResult.stillProcessing) {
        await persistRecoveryRetry(orderId, order.retryCount, 'Provider still processing')
        await createTimelineEvent(orderId, { eventType: 'PROVIDER_STILL_PROCESSING', message: 'Provider still processing — will retry' })
        return { success: false, action: 'POLL_PROVIDER', status: order.status, retryCount: order.retryCount + 1, nextRetryAt: computeNextRetryAt(order.retryCount + 1), message: 'Provider still processing' }
      }
      // Uncertain or failed
      await persistRecoveryFailure(orderId, order.retryCount, pollingResult.error || 'Provider polling failed')
      return { success: false, action: 'RECONCILIATION_REQUIRED', status: order.status, retryCount: order.retryCount + 1, message: pollingResult.error || 'Provider polling uncertain' }
    }

    case 'REDISPATCH_PROVIDER': {
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_REDISPATCH_STARTED', message: 'Redispatching to provider' })
      const redispatchResult = await redispatchProvider(order)
      if (redispatchResult.success) {
        await persistRecoverySuccess(orderId, order.retryCount)
        await createTimelineEvent(orderId, { eventType: 'PROVIDER_REDISPATCH_SUCCEEDED', message: 'Provider redispatch succeeded' })
        return { success: true, action: 'REDISPATCH_PROVIDER', status: redispatchResult.status, retryCount: order.retryCount, message: 'Redispatch succeeded' }
      }
      await persistRecoveryFailure(orderId, order.retryCount, redispatchResult.error || 'Redispatch failed')
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_REDISPATCH_FAILED', message: redispatchResult.error || 'Redispatch failed' })
      return { success: false, action: redispatchResult.reconciliation ? 'RECONCILIATION_REQUIRED' : 'NOT_RETRYABLE', status: order.status, retryCount: order.retryCount + 1, nextRetryAt: computeNextRetryAt(order.retryCount + 1), message: redispatchResult.error || 'Redispatch failed' }
    }

    case 'RECONCILIATION_REQUIRED': {
      await transitionOrder(orderId, 'PROVIDER_RECONCILIATION')
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION_STARTED', message: classification.reason })
      const reconciliation = await reconcileProviderOrder(orderId)
      if (reconciliation.outcome === 'FOUND_SUCCESS' || reconciliation.outcome === 'FOUND_FAILURE') {
        return {
          success: reconciliation.outcome === 'FOUND_SUCCESS',
          action: reconciliation.outcome === 'FOUND_SUCCESS' ? 'RESUME_LOCAL_FINALIZATION' : 'NOT_RETRYABLE',
          status: reconciliation.status || order.status,
          retryCount: order.retryCount,
          message: reconciliation.message,
        }
      }
      await prisma.eSIMPurchase.update({
        where: { id: orderId },
        data: { retryReason: `RECONCILIATION_REQUIRED: ${classification.reason}`, failureReason: classification.reason, lastRetryAt: new Date() },
      })
      return { success: false, action: 'RECONCILIATION_REQUIRED', status: 'PROVIDER_RECONCILIATION', retryCount: order.retryCount, message: reconciliation.message }
    }

    case 'NOT_RETRYABLE': {
      await createTimelineEvent(orderId, { eventType: 'ORDER_RECOVERY_SKIPPED', message: classification.reason })
      return { success: false, action: 'NOT_RETRYABLE', status: order.status, retryCount: order.retryCount, message: classification.reason }
    }

    case 'ALREADY_COMPLETE':
      return { success: true, action: 'ALREADY_COMPLETE', status: order.status, retryCount: order.retryCount, message: 'Already complete' }

    default:
      return { success: false, action: 'NOT_RETRYABLE', status: order.status, retryCount: order.retryCount, message: 'Unknown classification' }
  }
}

// ─────────────────────────────────────────────
// Polling + Redispatch helpers
// ─────────────────────────────────────────────

async function pollProviderForOrder(order: any): Promise<{ fulfilled: boolean; stillProcessing: boolean; status: string; error?: string }> {
  try {
    if (!order.providerId) return { fulfilled: false, stillProcessing: false, status: order.status, error: 'No provider linked' }
    const provider = await prisma.provider.findUnique({ where: { id: order.providerId } })
    if (!provider || !isProviderOperational(provider.status)) return { fulfilled: false, stillProcessing: false, status: order.status, error: 'Provider unavailable' }

    const adapter = await getAdapterForType(provider.type, {
      apiBaseUrl: provider.apiBaseUrl, apiToken: provider.apiToken,
      providerId: provider.id, environment: provider.environment, authUrl: provider.authUrl,
    })

    const ref = order.providerFulfillId || order.providerReservationId
    if (!ref) return { fulfilled: false, stillProcessing: false, status: order.status, error: 'No provider reference for polling' }

    const result = await adapter.getActivationStatus(ref)
    if (!result.success) return { fulfilled: false, stillProcessing: false, status: order.status, error: result.error?.message || 'Status check failed' }

    const status = result.data?.status || ''
    const isTerminal = ['ACTIVE', 'FULFILLED', 'COMPLETED', 'INSTALLED'].includes(status.toUpperCase())
    const isPending = ['PENDING', 'PROCESSING', 'PENDING_ACTIVATION', 'RESERVED', 'QUEUED'].includes(status.toUpperCase())

    if (isTerminal) return { fulfilled: true, status: 'FULFILLED', stillProcessing: false }
    if (isPending) return { fulfilled: false, status: order.status, stillProcessing: true }

    return { fulfilled: false, stillProcessing: false, status: order.status, error: `Unknown polling status: ${status}` }
  } catch (e: any) {
    return { fulfilled: false, stillProcessing: false, status: order.status, error: e.message }
  }
}

async function redispatchProvider(order: any): Promise<{ success: boolean; status: string; reconciliation?: boolean; error?: string }> {
  try {
    if (!order.providerId) return { success: false, status: order.status, error: 'No provider linked' }
    const provider = await prisma.provider.findUnique({ where: { id: order.providerId } })
    if (!provider || !isProviderOperational(provider.status)) return { success: false, status: order.status, reconciliation: true, error: 'Provider unavailable' }

    const adapter = await getAdapterForType(provider.type, {
      apiBaseUrl: provider.apiBaseUrl, apiToken: provider.apiToken,
      providerId: provider.id, environment: provider.environment, authUrl: provider.authUrl,
    })

    const quantity = order.quantity || 1
    const subscriber = { email: '', first_name: 'Retry' }

    // Derive the EXTERNAL plan id for the target provider using the canonical
    // package-backing-resolver — never send the local retail packageId upstream.
    const retailPkg = order.packageId ? await prisma.eSIMPackage.findUnique({
      where: { id: order.packageId },
      select: { id: true, providerPackageId: true, providerId: true, providerPlanId: true },
    }) : null

    const backing = retailPkg ? await resolvePackageBacking(retailPkg) : { kind: 'NONE' as const }

    let planId = ''
    if (backing.kind === 'BOUND') {
      if (backing.backing.providerId !== order.providerId) {
        return { success: false, status: order.status, reconciliation: true, error: 'No authoritative provider package backing for recovery redispatch.' }
      }
      planId = backing.backing.providerPlanId
    } else if (backing.kind === 'CUSTOM') {
      const match = backing.backings.find(b => b.providerId === order.providerId)
      if (match) {
        const pp = await prisma.providerPackage.findUnique({
          where: { id: match.providerPackageId },
          select: { providerPlanId: true },
        })
        planId = pp?.providerPlanId || ''
      }
      if (!planId) {
        return { success: false, status: order.status, reconciliation: true, error: 'No authoritative provider package backing for recovery redispatch.' }
      }
    } else {
      // UNAVAILABLE / NONE — no authoritative provider package backing.
      return { success: false, status: order.status, reconciliation: true, error: 'No authoritative provider package binding for recovery redispatch.' }
    }

    // Record the attempt BEFORE any provider HTTP so a crash after the mutation
    // still leaves evidence (mirrors executeProviderAttempt ordering).
    const existingCount = await prisma.providerAttempt.count({ where: { orderId: order.id, source: 'PURCHASE' } })
    const attempt = await prisma.providerAttempt.create({
      data: {
        orderId: order.id, providerId: order.providerId, attemptNumber: existingCount + 1,
        source: 'PURCHASE', status: 'STARTED', startedAt: new Date(),
        metadata: { redispatched: true, retailPackageId: order.packageId } as any,
      },
    })
    await prisma.eSIMPurchase.update({ where: { id: order.id }, data: { providerId: order.providerId } }).catch(() => {})

    const result = await adapter.activateESIM({ planId, quantity, subscriber, activationType: 'ACTIVATE_NOW', externalId: order.businessId, orderId: order.id } as any)
    const latencyMs = Date.now() - attempt.startedAt.getTime()

    if (!result.success) {
      const classification = classifyRetry(result.error)
      const isRetryable = classification === 'RETRYABLE'
      await prisma.providerAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'FAILED', completedAt: new Date(), latencyMs,
          retryClassification: isRetryable ? 'RETRYABLE' : 'NON_RETRYABLE',
          errorCode: result.error?.code, errorMessage: result.error?.message,
        },
      })
      if (!isRetryable) return { success: false, status: order.status, error: result.error?.message || 'Redispatch failed' }
      // Retryable — return error for caller to retry later
      return { success: false, status: order.status, reconciliation: true, error: result.error?.message || 'Retryable failure — uncertain outcome' }
    }

    // Record success
    await prisma.providerAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'SUCCEEDED', completedAt: new Date(), latencyMs,
        providerReference: result.data?.activationId || undefined,
      },
    })

    const data = result.data
    const iccids: string[] = []
    for (let i = 0; i < quantity; i++) {
      const val = data?.iccids?.[i] || data?.imsis?.[i]
      if (val) iccids.push(String(val))
    }

    if (iccids.length > 0) {
      const { completeProviderFinalization } = await import('./fulfillment')
      const finalResult = await completeProviderFinalization({
        orderId: order.id, businessId: order.businessId, providerId: order.providerId,
        providerRef: data?.activationId || '', providerName: provider.name,
        totalAmount: Number(order.totalAmount),
        providerResult: { iccids, providerFulfillId: data?.activationId },
        userId: order.userId,
      })
      return { success: finalResult.success, status: finalResult.orderStatus, error: finalResult.error }
    }

    return { success: true, status: 'PROCESSING', reconciliation: true, error: 'Provider accepted — no ICCIDs yet' }
  } catch (e: any) {
    return { success: false, status: order.status, reconciliation: true, error: e.message }
  }
}

// ─────────────────────────────────────────────
// Persistence helpers
// ─────────────────────────────────────────────

async function persistRecoverySuccess(orderId: string, currentRetryCount: number) {
  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: { lastRetryAt: new Date(), nextRetryAt: null, retryReason: null, failureReason: null, providerErrorCode: null, providerErrorMessage: null },
  })
}

async function persistRecoveryFailure(orderId: string, currentRetryCount: number, reason: string) {
  const nextCount = currentRetryCount + 1
  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: {
      retryCount: nextCount,
      lastRetryAt: new Date(),
      nextRetryAt: computeNextRetryAt(nextCount),
      retryReason: reason,
    },
  })
}

async function persistRecoveryRetry(orderId: string, currentRetryCount: number, reason: string) {
  const nextCount = currentRetryCount + 1
  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: { retryCount: nextCount, lastRetryAt: new Date(), nextRetryAt: computeNextRetryAt(nextCount), retryReason: reason },
  })
}

