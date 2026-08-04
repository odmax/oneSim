import { prisma } from '@/lib/prisma'
import { deriveOperationalState, deriveWalletOperationalSummary, deriveFulfillmentOperationalSummary } from './operational-classifier'

// ─────────────────────────────────────────────
// View model types (Task 18)
// ─────────────────────────────────────────────

export interface OperationDetailHeader {
  orderId: string
  businessName: string
  packageName: string
  createdAt: string
  status: string
  severity: string
  actionRequired: boolean
  actionType: string
  currentBlocker: string
  title: string
  reason: string
  ageMinutes: number
}

export interface OperationFulfillment {
  requestedQuantity: number
  fulfilledQuantity: number
  failedQuantity: number
  remainingQuantity: number
  percentage: number
  state: string
  completionTime?: string
  alerts: string[]
}

export interface OperationWalletTx {
  id: string
  type: string
  amount: number
  createdAt: string
  description: string | null
}

export interface OperationWallet {
  reserved: number
  captured: number
  released: number
  refunded: number
  state: string
  alerts: string[]
  transactions: OperationWalletTx[]
}

export interface OperationProviderAttempt {
  attemptNumber: number
  providerName: string
  source: string
  status: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  retryClassification?: string
  providerReferenceSuffix?: string
  errorCode?: string
  errorSummary?: string
}

export interface OperationEsim {
  id: string
  iccidMasked: string
  status: string
  providerStatus?: string
  hasActivation: boolean
  dataUsedMB?: number
  dataTotalMB?: number
  expiresAt?: string
  activatedAt?: string
}

export interface OperationInventory {
  id: string
  providerId: string
  status: string
  requestedQuantity: number
  reservedQuantity: number
  fulfilledQuantity: number
  releasedQuantity: number
  expiresAt: string
  hasProviderEvidence: boolean
}

export interface OperationRecovery {
  retryCount: number
  maxRetries: number
  nextRetryAt?: string
  retryReason?: string
  reconciliationAttempts: number
  redispatchAllowed: boolean
  recommendedAction: string
}

export interface OperationTimelineEvent {
  category: string
  eventType: string
  message: string
  createdAt: string
}

export interface OperationWebhook {
  id: string
  providerType: string
  eventType: string
  externalIdSuffix?: string
  status: string
  receivedAt: string
  errorMsg?: string
}

export interface OperationCallback {
  id: string
  eventType: string
  hostname: string
  status: string
  attemptCount: number
  lastStatus?: number
  deliveredAt?: string
  deadLettered: boolean
}

export interface OperationPricing {
  quotedQuantity?: number
  unitPrice: number
  total: number
  currency: string
  quoteReference?: string
  quoteStatus?: string
  isLegacy: boolean
}

export interface OperationIntegrityCheck {
  name: string
  result: 'PASS' | 'WARNING' | 'FAIL'
  message: string
}

export interface OrderOperationsDetail {
  header: OperationDetailHeader
  fulfillment: OperationFulfillment
  wallet: OperationWallet
  providerAttempts: OperationProviderAttempt[]
  esims: OperationEsim[]
  inventory?: OperationInventory
  recovery: OperationRecovery
  timeline: OperationTimelineEvent[]
  webhooks: OperationWebhook[]
  callbacks: OperationCallback[]
  pricing: OperationPricing
  integrityChecks: OperationIntegrityCheck[]
}

// ─────────────────────────────────────────────
// Sanitizers
// ─────────────────────────────────────────────

function maskIccid(iccid: string, show: number = 8): string {
  if (iccid.length <= show) return iccid
  return '\u2022'.repeat(iccid.length - show) + iccid.slice(-show)
}

function hostnameOnly(url: string): string {
  try { return new URL(url).hostname } catch { return url.slice(0, 40) }
}

function safeSuffix(value?: string | null, len: number = 6): string | undefined {
  if (!value) return undefined
  return value.slice(-len)
}

// ─────────────────────────────────────────────
// Main data loader (Task 2)
// ─────────────────────────────────────────────

export async function getOrderOperationsDetail(orderId: string): Promise<OrderOperationsDetail | null> {
  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    include: {
      business: { select: { id: true, name: true } },
      package: { select: { displayName: true, name: true } },
      provider: { select: { id: true, name: true, code: true, config: true } },
      esims: { select: { id: true, iccid: true, status: true, providerStatus: true, activationCode: true, qrCodeUrl: true, dataUsedMB: true, dataTotalMB: true, expiresAt: true, activatedAt: true } },
    },
  })
  if (!order) return null

  const now = new Date()
  const ageMinutes = Math.round((now.getTime() - new Date(order.createdAt).getTime()) / 60000)

  // Batch-load relations
  const [walletTxs, providerAttempts, timeline, inventory, callbacks, webhooks, quote] = await Promise.all([
    prisma.walletTransaction.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, select: { id: true, type: true, amount: true, createdAt: true, description: true } }),
    prisma.providerAttempt.findMany({ where: { orderId }, orderBy: { attemptNumber: 'asc' }, select: { attemptNumber: true, providerId: true, source: true, status: true, startedAt: true, completedAt: true, latencyMs: true, retryClassification: true, providerReference: true, errorCode: true, errorMessage: true } }),
    prisma.orderTimelineEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, select: { eventType: true, message: true, createdAt: true } }),
    prisma.providerInventoryReservation.findFirst({ where: { orderId }, select: { id: true, providerId: true, status: true, requestedQuantity: true, reservedQuantity: true, fulfilledQuantity: true, releasedQuantity: true, expiresAt: true, providerReservationReference: true } }),
    prisma.orderCallbackDelivery.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, select: { id: true, eventType: true, callbackUrl: true, status: true, attemptCount: true, lastHttpStatus: true, deliveredAt: true } }),
    prisma.providerWebhookEvent.findMany({ where: { esimId: { in: order.esims.map(e => e.id) } }, orderBy: { receivedAt: 'desc' }, select: { id: true, providerType: true, eventType: true, externalEventId: true, status: true, receivedAt: true, errorMessage: true } }),
    order.purchaseQuoteId ? prisma.purchaseQuote.findUnique({ where: { id: order.purchaseQuoteId }, select: { quoteReference: true, status: true, unitPrice: true, totalAmount: true, currency: true } }) : null,
  ])

  // Wallet
  const wallet = deriveWalletOperationalSummary({
    transactions: walletTxs.map(t => ({ type: t.type, amount: Number(t.amount || 0) })),
    orderStatus: order.status,
    fulfilledQuantity: order.fulfilledQuantity ?? 0,
    esimCount: order.esims.length,
  })

  const walletView: OperationWallet = {
    reserved: wallet.totalReserved,
    captured: wallet.totalCaptured,
    released: wallet.totalReleased,
    refunded: wallet.totalRefunded,
    state: wallet.state,
    alerts: wallet.alerts,
    transactions: walletTxs.map(t => ({
      id: t.id, type: t.type, amount: Number(t.amount || 0),
      createdAt: t.createdAt.toISOString(), description: t.description,
    })),
  }

  // Fulfillment
  const fulfill = deriveFulfillmentOperationalSummary({
    requestedQuantity: order.quotedQuantity ?? order.quantity ?? 1,
    fulfilledQuantity: order.fulfilledQuantity ?? 0,
    failedQuantity: order.failedQuantity ?? 0,
    esimCount: order.esims.length,
  })

  const fulfillmentView: OperationFulfillment = {
    ...fulfill,
    completionTime: order.fulfillmentCompletedAt?.toISOString(),
    requestedQuantity: order.quotedQuantity ?? order.quantity ?? 1,
    fulfilledQuantity: order.fulfilledQuantity ?? 0,
    failedQuantity: order.failedQuantity ?? 0,
  }

  // Operational state
  const opsState = deriveOperationalState({
    orderStatus: order.status, orderAgeMinutes: ageMinutes,
    fulfilledQuantity: order.fulfilledQuantity ?? 0, requestedQuantity: order.quotedQuantity ?? order.quantity ?? 1,
    esimCount: order.esims.length, walletState: wallet.state, walletAlerts: wallet.alerts,
    maxRetries: order.maxRetries, retryCount: order.retryCount,
    isReconciling: order.status === 'PROVIDER_RECONCILIATION',
    isDeadLetteredCallback: callbacks.some(c => c.status === 'DEAD_LETTERED'),
    hasUnprocessedWebhook: webhooks.some(w => w.status === 'RECEIVED'),
    hasProviderFulfillmentEvidence: Boolean(order.providerFulfillId || order.providerReservationId),
  })

  const header: OperationDetailHeader = {
    orderId: order.id, businessName: order.business?.name || '-',
    packageName: order.package?.displayName || order.package?.name || '-',
    createdAt: order.createdAt.toISOString(), status: order.status,
    severity: opsState.severity, actionRequired: opsState.actionRequired,
    actionType: opsState.actionType, currentBlocker: opsState.currentBlocker,
    title: opsState.title, reason: opsState.reason, ageMinutes,
  }

  // Provider attempts
  const attemptsView: OperationProviderAttempt[] = providerAttempts.map(a => ({
    attemptNumber: a.attemptNumber,
    providerName: order.provider?.name || a.providerId || '-',
    source: a.source, status: a.status,
    startedAt: a.startedAt?.toISOString(), completedAt: a.completedAt?.toISOString(),
    durationMs: a.latencyMs ?? undefined,
    retryClassification: a.retryClassification ?? undefined,
    providerReferenceSuffix: safeSuffix(a.providerReference),
    errorCode: a.errorCode ?? undefined,
    errorSummary: a.errorMessage?.substring(0, 200) ?? undefined,
  }))

  // eSIMs
  const esimsView: OperationEsim[] = order.esims.map(e => ({
    id: e.id, iccidMasked: maskIccid(e.iccid),
    status: e.status, providerStatus: e.providerStatus ?? undefined,
    hasActivation: Boolean(e.activationCode || e.qrCodeUrl),
    dataUsedMB: e.dataUsedMB ?? undefined, dataTotalMB: e.dataTotalMB ?? undefined,
    expiresAt: e.expiresAt?.toISOString(), activatedAt: e.activatedAt?.toISOString(),
  }))

  // Inventory
  let inventoryView: OperationInventory | undefined
  if (inventory) {
    inventoryView = {
      id: inventory.id, providerId: inventory.providerId,
      status: inventory.status, requestedQuantity: inventory.requestedQuantity,
      reservedQuantity: inventory.reservedQuantity, fulfilledQuantity: inventory.fulfilledQuantity,
      releasedQuantity: inventory.releasedQuantity, expiresAt: inventory.expiresAt.toISOString(),
      hasProviderEvidence: Boolean(inventory.providerReservationReference),
    }
  }

  // Recovery
  const recoveryView: OperationRecovery = {
    retryCount: order.retryCount, maxRetries: order.maxRetries,
    nextRetryAt: order.nextRetryAt?.toISOString(),
    retryReason: order.retryReason ?? undefined,
    reconciliationAttempts: providerAttempts.filter(a => a.source === 'RECONCILIATION').length,
    redispatchAllowed: order.retryCount >= order.maxRetries,
    recommendedAction: opsState.actionType,
  }

  // Timeline
  const categoryMap: Record<string, string> = {
    ORDER_CREATED: 'ORDER', ORDER_CREATED_FROM_QUOTE: 'ORDER', ORDER_CREATED_WITHOUT_QUOTE: 'ORDER',
    ORDER_FULFILLED: 'FULFILLMENT', ESIMS_PERSISTED: 'FULFILLMENT',
    PARTIAL_FULFILLMENT_RECORDED: 'FULFILLMENT', FULFILLMENT_BATCH_RECEIVED: 'FULFILLMENT',
    WALLET_RESERVED: 'WALLET', WALLET_CAPTURED: 'WALLET', WALLET_RELEASED: 'WALLET', WALLET_REFUNDED: 'WALLET', PARTIAL_WALLET_CAPTURED: 'WALLET',
    PROVIDER_FULFILLMENT_RECORDED: 'PROVIDER', PROVIDER_FULFILLED: 'PROVIDER', PROVIDER_STILL_PROCESSING: 'PROVIDER',
    PROVIDER_POLL_STARTED: 'PROVIDER', PROVIDER_REDISPATCH_STARTED: 'PROVIDER', PROVIDER_REDISPATCH_SUCCEEDED: 'PROVIDER', PROVIDER_REDISPATCH_FAILED: 'PROVIDER',
    PROVIDER_FAILOVER: 'PROVIDER',
    PROVIDER_RECONCILIATION_STARTED: 'RECOVERY', PROVIDER_RECONCILIATION_RETRY: 'RECOVERY',
    PROVIDER_RECONCILIATION_SUCCESS: 'RECOVERY', PROVIDER_RECONCILIATION_FAILED: 'RECOVERY', PROVIDER_RECONCILIATION_TIMEOUT: 'RECOVERY',
    RECONCILIATION_REQUIRED: 'RECOVERY', REDISPATCH_ALLOWED: 'RECOVERY',
    ORDER_RECOVERY_CLASSIFIED: 'RECOVERY', ORDER_RECOVERY_SKIPPED: 'RECOVERY', ORDER_RECOVERY_EXHAUSTED: 'RECOVERY',
    LOCAL_FINALIZATION_RETRY_STARTED: 'RECOVERY', LOCAL_FINALIZATION_RETRY_SUCCEEDED: 'RECOVERY', LOCAL_FINALIZATION_RETRY_FAILED: 'RECOVERY', LOCAL_FINALIZATION_RESUMED: 'RECOVERY', LOCAL_FINALIZATION_FAILED: 'RECOVERY',
    INVENTORY_RESERVED: 'INVENTORY', INVENTORY_FULFILLED: 'INVENTORY', INVENTORY_RELEASED: 'INVENTORY', INVENTORY_EXPIRED: 'INVENTORY', INVENTORY_RECONCILIATION_REQUIRED: 'INVENTORY', INVENTORY_PARTIALLY_FULFILLED: 'INVENTORY',
    CALLBACK_CREATED: 'CALLBACK', CALLBACK_DELIVERED: 'CALLBACK', CALLBACK_RETRY_SCHEDULED: 'CALLBACK', CALLBACK_DEAD_LETTERED: 'CALLBACK',
    ESIM_ACTIVATED: 'ESIM', STATUS_REFRESHED: 'ESIM',
    RETRY_INITIATED: 'ADMIN', REFUND_COMPLETED: 'ADMIN',
  }

  const timelineView: OperationTimelineEvent[] = timeline.map(e => ({
    category: categoryMap[e.eventType] || 'ORDER',
    eventType: e.eventType, message: e.message || '',
    createdAt: e.createdAt.toISOString(),
  }))

  // Webhooks
  const webhooksView: OperationWebhook[] = webhooks.map(w => ({
    id: w.id, providerType: w.providerType, eventType: w.eventType,
    externalIdSuffix: safeSuffix(w.externalEventId), status: w.status,
    receivedAt: w.receivedAt.toISOString(), errorMsg: w.errorMessage?.substring(0, 100) ?? undefined,
  }))

  // Callbacks
  const callbacksView: OperationCallback[] = callbacks.map(c => ({
    id: c.id, eventType: c.eventType, hostname: hostnameOnly(c.callbackUrl),
    status: c.status, attemptCount: c.attemptCount,
    lastStatus: c.lastHttpStatus ?? undefined, deliveredAt: c.deliveredAt?.toISOString(),
    deadLettered: c.status === 'DEAD_LETTERED',
  }))

  // Pricing
  const pricingView: OperationPricing = {
    unitPrice: Number(order.quotedUnitPrice ?? order.packageUnitPrice ?? 0),
    total: Number(order.quotedTotalAmount ?? order.totalAmount ?? 0),
    currency: order.quotedCurrency || order.packageCurrency || 'USD',
    quotedQuantity: order.quotedQuantity ?? undefined,
    quoteReference: quote ? quote.quoteReference.slice(-12) : undefined,
    quoteStatus: quote?.status ?? undefined,
    isLegacy: !order.quotedUnitPrice,
  }

  // Integrity checks (Task 17)
  const integrityChecks: OperationIntegrityCheck[] = [
    {
      name: 'Fulfillment completeness',
      result: order.status === 'FULFILLED' && (order.fulfilledQuantity ?? 0) < (order.quantity ?? 1) ? 'WARNING' : 'PASS',
      message: order.status === 'FULFILLED' && (order.fulfilledQuantity ?? 0) < (order.quantity ?? 1)
        ? `FULFILLED but only ${order.fulfilledQuantity} of ${order.quantity} eSIMs recorded` : 'Complete',
    },
    {
      name: 'Wallet capture for FULFILLED',
      result: order.status === 'FULFILLED' && wallet.totalCaptured === 0 ? 'FAIL' : 'PASS',
      message: order.status === 'FULFILLED' && wallet.totalCaptured === 0 ? 'Order FULFILLED but no wallet capture' : 'OK',
    },
    {
      name: 'Capture ≤ reserve',
      result: wallet.totalCaptured + wallet.totalReleased > wallet.totalReserved + 0.01 ? 'FAIL' : 'PASS',
      message: wallet.totalCaptured + wallet.totalReleased > wallet.totalReserved + 0.01 ? 'Capture + release exceed reserve' : 'OK',
    },
    {
      name: 'Refund ≤ capture',
      result: wallet.totalRefunded > wallet.totalCaptured + 0.01 ? 'FAIL' : 'PASS',
      message: wallet.totalRefunded > wallet.totalCaptured + 0.01 ? 'Refund exceeds captured amount' : 'OK',
    },
    {
      name: 'Fulfilled ≤ requested',
      result: (order.fulfilledQuantity ?? 0) > (order.quantity ?? 1) ? 'FAIL' : 'PASS',
      message: (order.fulfilledQuantity ?? 0) > (order.quantity ?? 1) ? `Fulfilled ${order.fulfilledQuantity} > requested ${order.quantity}` : 'OK',
    },
    {
      name: 'Provider evidence compatible',
      result: (order.providerFulfillId || order.providerReservationId) && order.status === 'FAILED' ? 'WARNING' : 'PASS',
      message: (order.providerFulfillId || order.providerReservationId) && order.status === 'FAILED' ? 'Provider evidence exists but order FAILED' : 'OK',
    },
  ]

  return {
    header, fulfillment: fulfillmentView, wallet: walletView,
    providerAttempts: attemptsView, esims: esimsView,
    inventory: inventoryView, recovery: recoveryView,
    timeline: timelineView, webhooks: webhooksView,
    callbacks: callbacksView, pricing: pricingView,
    integrityChecks,
  }
}
