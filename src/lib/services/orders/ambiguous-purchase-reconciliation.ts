import { prisma } from '@/lib/prisma'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { createTimelineEvent } from './order-state-machine'

export interface ReconcileAmbiguousPurchaseResult {
  success: boolean
  resolved: boolean
  iccid?: string
  imsi?: string
  reason?: 'unique-match' | 'no-match' | 'multiple-matches' | 'inconclusive'
  error?: string
}

/**
 * Provider-neutral read-only reconciliation for an order stuck in
 * PROVIDER_RECONCILIATION after an ambiguous (timed-out) activation.
 *
 * NEVER repeats the activation/purchase POST. It derives the authoritative
 * provider + provider-owned plan id (SKU) from the ambiguous attempt's recorded
 * metadata (not the denormalized retail snapshot), builds the connector, and
 * delegates to the connector's optional `reconcileAmbiguousPurchase` (read-only).
 *
 * Auto-resolution happens ONLY on a unique, defensible match returned by the
 * connector; otherwise the order remains in PROVIDER_RECONCILIATION.
 */
export async function reconcileAmbiguousPurchase(orderId: string): Promise<ReconcileAmbiguousPurchaseResult> {
  const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId } })
  if (!order) return { success: false, resolved: false, error: 'Order not found' }
  if (order.status !== 'PROVIDER_RECONCILIATION') {
    return { success: false, resolved: false, error: `Order is not in PROVIDER_RECONCILIATION (current: ${order.status})` }
  }

  const attempt = await prisma.providerAttempt.findFirst({
    where: { orderId, status: 'AMBIGUOUS' },
    orderBy: { startedAt: 'desc' },
  })
  if (!attempt || !attempt.providerId) {
    return { success: false, resolved: false, error: 'No ambiguous provider attempt recorded for this order' }
  }

  const metadata = (attempt.metadata || {}) as Record<string, unknown>
  const planId = metadata.externalPlanId != null ? String(metadata.externalPlanId) : ''
  if (!planId) {
    return { success: false, resolved: false, error: 'No provider plan id (SKU) recorded on the ambiguous attempt' }
  }

  const connector = await buildConnectorFromProvider(attempt.providerId).catch(() => null)
  if (!connector || typeof connector.reconcileAmbiguousPurchase !== 'function') {
    return { success: false, resolved: false, error: 'Provider does not support read-only reconciliation' }
  }

  const result = await connector.reconcileAmbiguousPurchase({
    orderId,
    planId,
    quantity: order.quantity || 1,
    attemptedAt: attempt.startedAt ? attempt.startedAt.toISOString() : '',
  })
  if (!result.success) {
    return { success: false, resolved: false, error: result.error?.message || 'Provider reconciliation failed' }
  }
  const data = result.data
  if (!data) {
    return { success: false, resolved: false, error: 'Provider reconciliation returned no result' }
  }
  await createTimelineEvent(orderId, {
    eventType: 'PROVIDER_RECONCILIATION',
    message: data.resolved
      ? `Ambiguous purchase reconciled: ICCID ${data.iccid ?? data.imsi ?? '(unknown)'}`
      : `Ambiguous purchase reconciliation ${data.reason ?? 'inconclusive'} — no automatic resolution`,
    metadata: { resolved: data.resolved, reason: data.reason ?? null, iccid: data.iccid ?? null, imsi: data.imsi ?? null, evidence: data.evidence ?? null },
  })

  return {
    success: true,
    resolved: data.resolved,
    iccid: data.iccid,
    imsi: data.imsi,
    reason: data.reason,
  }
}
