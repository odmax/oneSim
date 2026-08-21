/**
 * Background job handler for enqueued purchase dispatch (async purchase flow).
 *
 * The HTTP/API layer enqueues a PROVIDER_OPERATION job with
 * `{ operation: 'purchase', ...PurchaseDispatchContext }`. This handler runs the
 * provider-neutral dispatch via PurchaseOrchestrator.runDispatch — never
 * re-resolving or duplicating the purchase from the browser request.
 */
export async function executePurchaseDispatch(payload: any): Promise<{ completed: boolean; error?: string }> {
  if (!payload?.orderId) return { completed: false, error: 'Missing orderId in purchase dispatch payload' }

  const { PurchaseOrchestrator } = await import('../../orders/purchase-orchestrator')
  const orchestrator = new PurchaseOrchestrator()
  const result = await orchestrator.runDispatch(payload)

  if (result.success) return { completed: true }
  // Ambiguous → order already moved to PROVIDER_RECONCILIATION; job is complete.
  if (result.status === 'PROVIDER_RECONCILIATION') return { completed: true }
  // Retryable pre-dispatch → not complete; let the queue retry with backoff.
  if (result.retryable) return { completed: false, error: result.message || 'Retryable purchase dispatch' }
  // Definitive failure → order finalized (released/failed); job is complete.
  return { completed: true }
}
