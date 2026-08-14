import { runTopUpReconciliationBatch } from '@/lib/services/topups/top-up-reconciliation'

/**
 * Background job handler for ESIMTopUp.PENDING_REVIEW reconciliation.
 * Processes one batch per invocation. Recurring, idempotent, and concurrency-safe
 * (each row is claimed with a lease before work). NEVER re-dispatches the provider
 * top-up mutation — only read-only status verification happens here.
 */
export async function executeTopUpReconciliation(): Promise<{ completed: boolean; result?: any; error?: string }> {
  try {
    const result = await runTopUpReconciliationBatch(20)
    return { completed: true, result }
  } catch (e: any) {
    return { completed: false, error: e?.message || 'Top-up reconciliation failed' }
  }
}
