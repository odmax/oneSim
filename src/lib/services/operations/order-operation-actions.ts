import { prisma } from '@/lib/prisma'

// ─────────────────────────────────────────────
// Action availability types
// ─────────────────────────────────────────────

export interface OperationsAction {
  visible: boolean
  enabled: boolean
  reason?: string
  requiresConfirmation?: boolean
}

export interface OperationsActions {
  resumeFinalization: OperationsAction
  pollProvider: OperationsAction
  startReconciliation: OperationsAction
  safeRedispatch: OperationsAction
  retryCallback: OperationsAction
  cancelCallback: OperationsAction
  requeueWebhook: OperationsAction
  releaseInventory: OperationsAction
  markReviewed: OperationsAction
}

/**
 * Determine which safe admin actions are available for an order.
 * All rules are server-authoritative; the UI only reflects, never enforces.
 */
export async function getOrderOperationsActions(orderId: string): Promise<OperationsActions> {
  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    include: {
      esims: { select: { id: true } },
      provider: { select: { id: true, type: true, supportsUsage: true } },
    },
  })
  if (!order) return allHidden()

  const provider = order.provider
  const hasFulfillEvidence = Boolean(order.providerFulfillId || order.providerReservationId)
  const hasEsims = order.esims.length > 0
  const isTerminal = ['FULFILLED', 'REFUNDED', 'CANCELLED'].includes(order.status)
  const isReconciling = order.status === 'PROVIDER_RECONCILIATION'

  // Wallet transactions for guards
  const captureTx = await prisma.walletTransaction.findFirst({ where: { orderId, type: 'WALLET_CAPTURE' } })
  const hasCapture = Boolean(captureTx)

  // Inventory
  const inventory = await prisma.providerInventoryReservation.findFirst({ where: { orderId } })
  const hasInventory = Boolean(inventory)
  const inventoryHasProviderEvidence = hasInventory && Boolean(inventory?.providerReservationReference)

  // Callbacks
  const deadLetterCallbacks = await prisma.orderCallbackDelivery.count({ where: { orderId, status: 'DEAD_LETTERED' } })

  // Webhooks
  const failedWebhooks = await prisma.providerWebhookEvent.count({ where: { esimId: { in: order.esims.map(e => e.id) }, status: { in: ['RECEIVED', 'FAILED'] } } })

  return {
    resumeFinalization: {
      visible: hasFulfillEvidence && !isTerminal && order.status !== 'FULFILLED',
      enabled: hasFulfillEvidence && !hasEsims || !hasCapture,
      reason: !hasFulfillEvidence ? 'No provider fulfillment evidence' : (!hasEsims || !hasCapture) ? undefined : 'All local steps already complete',
    },

    pollProvider: {
      visible: Boolean(provider && (order.providerFulfillId || order.providerReservationId)),
      enabled: Boolean(provider && (order.providerFulfillId || order.providerReservationId) && !isTerminal),
      reason: !provider ? 'No provider linked' : isTerminal ? 'Order is terminal' : !(order.providerFulfillId || order.providerReservationId) ? 'No provider reference to poll' : undefined,
    },

    startReconciliation: {
      visible: isReconciling || (!hasFulfillEvidence && order.status === 'FAILED'),
      enabled: isReconciling || (order.status === 'FAILED' && order.retryCount < order.maxRetries),
      reason: isTerminal ? 'Order is terminal' : undefined,
    },

    safeRedispatch: {
      visible: order.status === 'FAILED' && !hasFulfillEvidence && !hasEsims && !hasCapture,
      enabled: order.status === 'FAILED' && !hasFulfillEvidence && !hasEsims && !hasCapture && order.retryCount < order.maxRetries,
      reason: hasFulfillEvidence ? 'Provider evidence exists — cannot redispatch' : hasEsims ? 'eSIM records exist' : hasCapture ? 'Wallet captured' : order.retryCount >= order.maxRetries ? 'Max retries reached' : isTerminal ? 'Order is terminal' : undefined,
      requiresConfirmation: true,
    },

    retryCallback: {
      visible: deadLetterCallbacks > 0,
      enabled: deadLetterCallbacks > 0,
      reason: deadLetterCallbacks === 0 ? 'No dead-letter callbacks' : undefined,
    },

    cancelCallback: {
      visible: deadLetterCallbacks > 0,
      enabled: deadLetterCallbacks > 0,
      reason: undefined,
      requiresConfirmation: true,
    },

    requeueWebhook: {
      visible: failedWebhooks > 0,
      enabled: failedWebhooks > 0,
      reason: failedWebhooks === 0 ? 'No failed webhooks to reprocess' : undefined,
    },

    releaseInventory: {
      visible: hasInventory && !inventoryHasProviderEvidence,
      enabled: hasInventory && !inventoryHasProviderEvidence && !hasEsims && order.status !== 'FULFILLED',
      reason: !hasInventory ? 'No inventory reservation' : inventoryHasProviderEvidence ? 'Provider evidence exists' : hasEsims ? 'eSIMs depend on reservation' : order.status === 'FULFILLED' ? 'Order fulfilled' : undefined,
      requiresConfirmation: true,
    },

    markReviewed: {
      visible: true,
      enabled: true,
      reason: undefined,
    },
  }
}

function allHidden(): OperationsActions {
  const hidden: OperationsAction = { visible: false, enabled: false, reason: 'Order not found' }
  return { resumeFinalization: hidden, pollProvider: hidden, startReconciliation: hidden, safeRedispatch: hidden, retryCallback: hidden, cancelCallback: hidden, requeueWebhook: hidden, releaseInventory: hidden, markReviewed: hidden }
}
