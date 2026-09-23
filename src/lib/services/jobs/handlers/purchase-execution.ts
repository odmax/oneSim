/**
 * Background job handler for enqueued purchase dispatch (async purchase flow).
 *
 * The HTTP/API layer enqueues a PROVIDER_OPERATION job with
 * `{ operation: 'purchase', ...PurchaseDispatchContext }`. This handler runs the
 * provider-neutral dispatch via PurchaseOrchestrator.runDispatch — never
 * re-resolving or duplicating the purchase from the browser request.
 *
 * Worker-side completing timing (sanitized): one `provider_operation_complete`
 * event is emitted for every provider purchase execution outcome, measuring
 * queue wait, provider HTTP call, persistence/finalization and total fulfillment.
 */
import { prisma } from '@/lib/prisma'
import { emitProviderOperationTiming, type ProviderOperationOutcome } from '../../orders/purchase-timing'

export interface PurchaseJobMeta {
  jobId?: string
  runAt?: Date
}

export async function executePurchaseDispatch(payload: any, jobMeta?: PurchaseJobMeta): Promise<{ completed: boolean; error?: string }> {
  if (!payload?.orderId) return { completed: false, error: 'Missing orderId in purchase dispatch payload' }

  const handlerStart = Date.now()
  const queueWaitMs = Math.max(0, handlerStart - (jobMeta?.runAt ? new Date(jobMeta.runAt).getTime() : handlerStart))

  const { PurchaseOrchestrator } = await import('../../orders/purchase-orchestrator')
  const orchestrator = new PurchaseOrchestrator()
  const result = await orchestrator.runDispatch(payload)

  // Map the canonical dispatch outcome → worker timing outcome.
  let outcome: ProviderOperationOutcome = 'UNKNOWN'
  let immediateFinalization = false
  let activationJobScheduled = false
  if (result.success && result.status === 'FULFILLED') {
    outcome = 'FULFILLED'
    immediateFinalization = true
  } else if (result.success && result.status === 'PROCESSING') {
    outcome = 'DEFERRED'
    activationJobScheduled = true
  } else if (result.status === 'PROVIDER_RECONCILIATION') {
    outcome = 'RECONCILIATION'
  } else if (!result.success && result.retryable) {
    outcome = 'DEFERRED'
  } else if (!result.success) {
    outcome = 'FAILED'
  }

  // Provider HTTP duration from the most recent PURCHASE attempt (recorded by
  // provider-attempt-service; this is a local read, not a provider call).
  let providerCallMs = 0
  try {
    const attempt = await prisma.providerAttempt.findFirst({
      where: { orderId: payload.orderId, source: 'PURCHASE' },
      orderBy: { attemptNumber: 'desc' },
      select: { latencyMs: true },
    })
    if (attempt?.latencyMs != null) providerCallMs = Math.max(0, attempt.latencyMs)
  } catch {
    providerCallMs = 0
  }

  const fulfillmentMs = Math.max(0, Date.now() - handlerStart)
  const persistenceMs = Math.max(0, fulfillmentMs - providerCallMs)

  // Exactly one sanitized completion event; instrumentation never throws.
  emitProviderOperationTiming({
    orderId: payload.orderId,
    providerCode: payload.providerCode || payload.providerName,
    operation: payload.operation || 'purchase',
    attemptNumber: typeof payload.attemptNumber === 'number' ? payload.attemptNumber : undefined,
    jobId: jobMeta?.jobId,
    correlationId: payload.correlationId,
    queueWaitMs,
    providerCallMs,
    persistenceMs,
    fulfillmentMs,
    outcome,
    immediateFinalization,
    activationJobScheduled,
  })

  if (result.success) return { completed: true }
  // Ambiguous — order already moved to PROVIDER_RECONCILIATION; job is complete.
  if (result.status === 'PROVIDER_RECONCILIATION') return { completed: true }
  // Retryable pre-dispatch — not complete; let the queue retry with backoff.
  if (result.retryable) return { completed: false, error: result.message || 'Retryable purchase dispatch' }
  // Definitive failure — order finalized (released/failed); job is complete.
  return { completed: true }
}