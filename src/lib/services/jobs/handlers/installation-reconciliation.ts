import { reconcileMissingInstallationDetails } from '../qr-reconciliation'

/**
 * Background job handler for QR/installation reconciliation.
 * Called by the job queue scheduler. Processes one batch per invocation.
 */
export async function executeInstallationReconciliation(): Promise<{ completed: boolean; result?: any; error?: string }> {
  const result = await reconcileMissingInstallationDetails(10)
  return { completed: true, result }
}
