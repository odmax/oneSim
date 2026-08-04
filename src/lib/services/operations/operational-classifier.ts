// ─────────────────────────────────────────────
// Operational classifier (Tasks 2-3)
// ─────────────────────────────────────────────

export type OperationalSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'

export type ActionType =
  | 'NONE' | 'MONITOR' | 'RETRY_SAFE' | 'RECONCILE'
  | 'WALLET_REVIEW' | 'PROVIDER_REVIEW' | 'CALLBACK_REVIEW'
  | 'WEBHOOK_REVIEW' | 'INVENTORY_REVIEW' | 'SECURITY_REVIEW'

export type CurrentBlocker =
  | 'NONE' | 'PROVIDER' | 'WALLET' | 'INVENTORY' | 'FULFILLMENT'
  | 'RECOVERY' | 'CALLBACK' | 'WEBHOOK' | 'UNKNOWN'

export interface OperationalState {
  severity: OperationalSeverity
  actionRequired: boolean
  actionType: ActionType
  title: string
  reason: string
  currentBlocker: CurrentBlocker
}

export interface OperationalSummary {
  walletState: 'NONE' | 'RESERVED' | 'PARTIALLY_CAPTURED' | 'CAPTURED' | 'RELEASED' | 'REFUNDED' | 'INTEGRITY_ALERT'
  walletAlerts: string[]
  reserved: number
  captured: number
  released: number
  refunded: number
  fulfillmentState: 'NOT_STARTED' | 'PROCESSING' | 'PARTIAL' | 'COMPLETE' | 'INCONSISTENT'
  fulfillmentAlerts: string[]
  requestedQuantity: number
  fulfilledQuantity: number
  failedQuantity: number
  remainingQuantity: number
}

const STALE_ORDER_MINUTES = parseInt(process.env.OPERATIONS_STALE_ORDER_MINUTES || '30', 10)

/**
 * Classify operational state from provider-neutral order data.
 */
export function deriveOperationalState(params: {
  orderStatus: string
  orderAgeMinutes: number
  fulfilledQuantity: number
  requestedQuantity: number
  esimCount: number
  walletState: string
  walletAlerts: string[]
  maxRetries: number
  retryCount: number
  isReconciling: boolean
  isDeadLetteredCallback: boolean
  hasUnprocessedWebhook: boolean
  hasProviderFulfillmentEvidence: boolean
}): OperationalState {
  const { orderStatus, orderAgeMinutes, fulfilledQuantity, requestedQuantity, esimCount, walletState, walletAlerts, maxRetries, retryCount, isReconciling, isDeadLetteredCallback, hasUnprocessedWebhook, hasProviderFulfillmentEvidence } = params

  // CRITICAL: wallet integrity alerts
  if (walletState === 'INTEGRITY_ALERT') {
    return { severity: 'CRITICAL', actionRequired: true, actionType: 'WALLET_REVIEW', title: 'Wallet Integrity Alert', reason: walletAlerts[0] || 'Wallet state inconsistent', currentBlocker: 'WALLET' }
  }
  // CRITICAL: fulfillment inconsistency
  if (fulfilledQuantity > requestedQuantity) {
    return { severity: 'CRITICAL', actionRequired: true, actionType: 'PROVIDER_REVIEW', title: 'Fulfillment Inconsistency', reason: `Fulfilled ${fulfilledQuantity} exceeds requested ${requestedQuantity}`, currentBlocker: 'FULFILLMENT' }
  }
  // CRITICAL: provider success but local FAILED
  if (orderStatus === 'FAILED' && hasProviderFulfillmentEvidence) {
    return { severity: 'CRITICAL', actionRequired: true, actionType: 'PROVIDER_REVIEW', title: 'Provider fulfilled but order failed', reason: 'Provider fulfillment evidence exists but order is FAILED', currentBlocker: 'PROVIDER' }
  }

  // ERROR: reconciliation
  if (isReconciling || orderStatus === 'PROVIDER_RECONCILIATION') {
    return { severity: 'ERROR', actionRequired: true, actionType: 'RECONCILE', title: 'Provider Reconciliation Required', reason: 'Uncertain provider outcome — reconciliation active', currentBlocker: 'PROVIDER' }
  }
  // ERROR: retry limit
  if (retryCount >= maxRetries && orderStatus !== 'FULFILLED') {
    return { severity: 'ERROR', actionRequired: true, actionType: 'RETRY_SAFE', title: 'Max Retries Reached', reason: `Retry count ${retryCount}/${maxRetries}`, currentBlocker: 'RECOVERY' }
  }
  // ERROR: dead-letter
  if (isDeadLetteredCallback) {
    return { severity: 'ERROR', actionRequired: true, actionType: 'CALLBACK_REVIEW', title: 'Callback Dead-Lettered', reason: 'Outbound callback delivery permanently failed', currentBlocker: 'CALLBACK' }
  }
  // ERROR: stale webhook
  if (hasUnprocessedWebhook) {
    return { severity: 'ERROR', actionRequired: true, actionType: 'WEBHOOK_REVIEW', title: 'Unprocessed Provider Webhook', reason: 'Provider webhook received but not processed', currentBlocker: 'WEBHOOK' }
  }
  // ERROR: stale order
  if (orderAgeMinutes > STALE_ORDER_MINUTES && !['FULFILLED', 'REFUNDED', 'CANCELLED', 'EXPIRED'].includes(orderStatus)) {
    return { severity: 'ERROR', actionRequired: true, actionType: 'MONITOR', title: 'Stale Order', reason: `Order in ${orderStatus} for ${orderAgeMinutes} minutes`, currentBlocker: 'PROVIDER' }
  }

  // WARNING: partial fulfillment
  if (orderStatus === 'PARTIALLY_FULFILLED' || (fulfilledQuantity > 0 && fulfilledQuantity < requestedQuantity)) {
    return { severity: 'WARNING', actionRequired: false, actionType: 'MONITOR', title: 'Partially Fulfilled', reason: `${fulfilledQuantity}/${requestedQuantity} eSIMs ready`, currentBlocker: 'FULFILLMENT' }
  }
  // WARNING: retry scheduled
  if (retryCount > 0 && retryCount < maxRetries && !isReconciling) {
    return { severity: 'WARNING', actionRequired: false, actionType: 'MONITOR', title: 'Retry Scheduled', reason: `Retry ${retryCount}/${maxRetries}`, currentBlocker: 'RECOVERY' }
  }

  // INFO: fulfilled
  if (orderStatus === 'FULFILLED' && esimCount >= requestedQuantity && walletState === 'CAPTURED') {
    return { severity: 'INFO', actionRequired: false, actionType: 'NONE', title: 'Fulfilled', reason: `All ${fulfilledQuantity} eSIMs ready`, currentBlocker: 'NONE' }
  }
  // INFO: normal processing
  return { severity: 'INFO', actionRequired: false, actionType: 'NONE', title: 'Processing', reason: 'Order processing normally', currentBlocker: 'NONE' }
}

// ─────────────────────────────────────────────
// Wallet summary helper (Task 10)
// ─────────────────────────────────────────────

export interface WalletSummary {
  state: 'NONE' | 'RESERVED' | 'PARTIALLY_CAPTURED' | 'CAPTURED' | 'RELEASED' | 'REFUNDED' | 'INTEGRITY_ALERT'
  alerts: string[]
  totalReserved: number
  totalCaptured: number
  totalReleased: number
  totalRefunded: number
}

export interface FulfillmentSummary {
  state: 'NOT_STARTED' | 'PROCESSING' | 'PARTIAL' | 'COMPLETE' | 'INCONSISTENT'
  alerts: string[]
  percentage: number
  remainingQuantity: number
}

export function deriveWalletOperationalSummary(params: {
  transactions: Array<{ type: string; amount: number }>
  orderStatus: string
  fulfilledQuantity: number
  esimCount: number
}): WalletSummary {
  const { transactions, orderStatus, fulfilledQuantity, esimCount } = params
  const reserved = Math.abs(transactions.filter(t => t.type === 'WALLET_RESERVE').reduce((s, t) => s + Number(t.amount || 0), 0))
  const captured = transactions.filter(t => t.type === 'WALLET_CAPTURE').reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0)
  const released = transactions.filter(t => t.type === 'WALLET_RELEASE').reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0)
  const refunded = transactions.filter(t => t.type === 'WALLET_REFUND').reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0)

  let state: WalletSummary['state'] = 'NONE'
  const alerts: string[] = []

  if (captured > 0 && esimCount === 0) {
    alerts.push('Wallet captured but no eSIMs exist')
  }
  if (captured + released > reserved + 0.01) {
    alerts.push('Capture + release exceeds reserve')
  }
  if (refunded > captured + 0.01) {
    alerts.push('Refund exceeds captured amount')
  }
  if (orderStatus === 'FULFILLED' && captured === 0 && reserved > 0) {
    alerts.push('Order FULFILLED but funds not captured')
  }

  if (alerts.length > 0) {
    state = 'INTEGRITY_ALERT'
  } else if (refunded > 0) {
    state = 'REFUNDED'
  } else if (released >= reserved && captured === 0) {
    state = 'RELEASED'
  } else if (captured > 0) {
    state = captured >= reserved ? 'CAPTURED' : 'PARTIALLY_CAPTURED'
  } else if (reserved > 0) {
    state = 'RESERVED'
  }

  return { state, alerts, totalReserved: reserved, totalCaptured: captured, totalReleased: released, totalRefunded: refunded }
}

// ─────────────────────────────────────────────
// Fulfillment progress helper (Task 11)
// ─────────────────────────────────────────────

export function deriveFulfillmentOperationalSummary(params: {
  requestedQuantity: number
  fulfilledQuantity: number
  failedQuantity: number
  esimCount: number
}): FulfillmentSummary {
  const { requestedQuantity, fulfilledQuantity, failedQuantity, esimCount } = params
  const remainingQuantity = Math.max(0, requestedQuantity - fulfilledQuantity - failedQuantity)
  const percentage = requestedQuantity > 0 ? Math.round((fulfilledQuantity / requestedQuantity) * 100) : 0
  const alerts: string[] = []
  let state: FulfillmentSummary['state'] = 'NOT_STARTED'

  if (fulfilledQuantity > requestedQuantity) {
    alerts.push('Fulfilled exceeds requested')
    state = 'INCONSISTENT'
  } else if (fulfilledQuantity >= requestedQuantity) {
    state = 'COMPLETE'
  } else if (fulfilledQuantity > 0) {
    state = 'PARTIAL'
  } else if (esimCount > 0) {
    state = 'PROCESSING'
  }

  return { state, percentage, remainingQuantity, alerts }
}
