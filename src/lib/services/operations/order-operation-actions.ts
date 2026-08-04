import { prisma } from '@/lib/prisma'

export interface OperationsAction {
  visible: boolean
  enabled: boolean
  reason?: string
  requiresConfirmation?: boolean
  requiredRole?: string
}

export interface OperationsActions {
  resumeFinalization: OperationsAction
  pollProvider: OperationsAction
  startReconciliation: OperationsAction
  safeRedispatch: OperationsAction
  retryCallback: OperationsAction
  cancelCallback: OperationsAction
  reprocessWebhook: OperationsAction
  releaseInventory: OperationsAction
  acknowledgeIncident: OperationsAction
}

const ACTIONS_ENABLED = process.env.ADMIN_OPERATIONS_ACTIONS_ENABLED === 'true'
const REDISPATCH_ENABLED = process.env.ADMIN_SAFE_REDISPATCH_ENABLED === 'true'

export type AdminRole = 'SUPER_ADMIN' | 'INTERNAL_ADMIN' | 'SUPPORT' | 'FINANCE'

/**
 * Check if a role is authorized for a specific action type.
 */
export function canExecuteAction(role: AdminRole, action: string): { allowed: boolean; reason?: string } {
  if (!ACTIONS_ENABLED && action !== 'acknowledgeIncident') {
    return { allowed: false, reason: 'Operations actions are currently disabled' }
  }

  switch (action) {
    case 'safeRedispatch':
      if (role !== 'SUPER_ADMIN') return { allowed: false, reason: 'Safe redispatch requires SUPER_ADMIN role' }
      if (!REDISPATCH_ENABLED) return { allowed: false, reason: 'Safe redispatch is currently disabled' }
      return { allowed: true }

    case 'releaseInventory':
    case 'cancelCallback':
      if (role !== 'SUPER_ADMIN' && role !== 'INTERNAL_ADMIN') return { allowed: false, reason: `Action requires ADMIN or SUPER_ADMIN role` }
      return { allowed: true }

    case 'acknowledgeIncident':
      return { allowed: true } // All roles can acknowledge

    case 'resumeFinalization':
    case 'pollProvider':
    case 'startReconciliation':
    case 'retryCallback':
    case 'reprocessWebhook':
      if (role === 'FINANCE') return { allowed: false, reason: 'Finance users cannot trigger this operation' }
      return { allowed: true }

    default:
      return { allowed: true }
  }
}

function disabled(reason: string): OperationsAction {
  return { visible: true, enabled: false, reason }
}

function hidden(): OperationsAction {
  return { visible: false, enabled: false }
}

/**
 * Determine which safe admin actions are available for an order.
 * Takes the actor's role into account.
 */
export async function getOrderOperationsActions(orderId: string, actorRole: AdminRole = 'INTERNAL_ADMIN'): Promise<OperationsActions> {
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

  const captureTx = await prisma.walletTransaction.findFirst({ where: { orderId, type: 'WALLET_CAPTURE' } })
  const hasCapture = Boolean(captureTx)

  const inventory = await prisma.providerInventoryReservation.findFirst({ where: { orderId } })
  const hasInventory = Boolean(inventory)
  const inventoryHasProviderEvidence = hasInventory && Boolean(inventory?.providerReservationReference)

  const deadLetterCallbacks = await prisma.orderCallbackDelivery.count({ where: { orderId, status: 'DEAD_LETTERED' } })
  const failedCallbacks = await prisma.orderCallbackDelivery.count({ where: { orderId, status: { in: ['FAILED', 'DEAD_LETTERED', 'RETRY_SCHEDULED'] } } })

  const failedWebhooks = await prisma.providerWebhookEvent.count({ where: { esimId: { in: order.esims.map(e => e.id) }, status: { in: ['RECEIVED', 'FAILED'] } } })

  // Poll provider availability
  const hasPollRef = Boolean(provider && (order.providerFulfillId || order.providerReservationId || order.providerId))
  const isPollable = order.status !== 'FULFILLED' && order.status !== 'REFUNDED' && order.status !== 'CANCELLED'

  return {
    resumeFinalization: hasFulfillEvidence && !isTerminal && order.status !== 'FULFILLED'
      ? { visible: true, enabled: ACTIONS_ENABLED && (!hasEsims || !hasCapture), reason: !ACTIONS_ENABLED ? 'Operations disabled' : (hasEsims && hasCapture) ? 'All local steps complete' : undefined }
      : hidden(),

    pollProvider: hasPollRef && isPollable
      ? { visible: true, enabled: ACTIONS_ENABLED && hasPollRef && isPollable && !isTerminal, reason: !ACTIONS_ENABLED ? 'Operations disabled' : !hasPollRef ? 'No provider reference' : undefined }
      : hidden(),

    startReconciliation: (order.status === 'PROVIDER_RECONCILIATION' || (!hasFulfillEvidence && order.status === 'FAILED'))
      ? { visible: true, enabled: ACTIONS_ENABLED, reason: !ACTIONS_ENABLED ? 'Operations disabled' : undefined }
      : hidden(),

    safeRedispatch: order.status === 'FAILED' && !hasFulfillEvidence && !hasEsims && !hasCapture
      ? { visible: true, enabled: ACTIONS_ENABLED && REDISPATCH_ENABLED && order.retryCount < order.maxRetries, reason: !ACTIONS_ENABLED ? 'Operations disabled' : !REDISPATCH_ENABLED ? 'Safe redispatch disabled' : order.retryCount >= order.maxRetries ? 'Max retries reached' : undefined, requiresConfirmation: true, requiredRole: 'SUPER_ADMIN' }
      : hidden(),

    retryCallback: deadLetterCallbacks > 0 || failedCallbacks > 0
      ? { visible: true, enabled: ACTIONS_ENABLED, reason: !ACTIONS_ENABLED ? 'Operations disabled' : undefined }
      : hidden(),

    cancelCallback: deadLetterCallbacks > 0
      ? { visible: true, enabled: ACTIONS_ENABLED, reason: !ACTIONS_ENABLED ? 'Operations disabled' : undefined, requiresConfirmation: true }
      : hidden(),

    reprocessWebhook: failedWebhooks > 0
      ? { visible: true, enabled: ACTIONS_ENABLED, reason: !ACTIONS_ENABLED ? 'Operations disabled' : undefined }
      : hidden(),

    releaseInventory: hasInventory && !inventoryHasProviderEvidence
      ? { visible: true, enabled: ACTIONS_ENABLED && !hasEsims && order.status !== 'FULFILLED', reason: !ACTIONS_ENABLED ? 'Operations disabled' : hasEsims ? 'eSIMs depend on reservation' : undefined, requiresConfirmation: true }
      : hidden(),

    acknowledgeIncident: { visible: true, enabled: true, reason: undefined },
  }
}

function allHidden(): OperationsActions {
  const h = { visible: false, enabled: false, reason: 'Order not found' }
  return { resumeFinalization: h, pollProvider: h, startReconciliation: h, safeRedispatch: h, retryCallback: h, cancelCallback: h, reprocessWebhook: h, releaseInventory: h, acknowledgeIncident: h }
}
