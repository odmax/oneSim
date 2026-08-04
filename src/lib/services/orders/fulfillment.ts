import { prisma } from '@/lib/prisma'
import { captureReservedFunds } from '@/lib/services/orders/wallet-actions'
import { createTimelineEvent, transitionOrder } from '@/lib/services/orders/order-state-machine'
import { publishOrderLifecycleEvent, ORDER_LIFECYCLE_EVENTS } from './lifecycle-publisher'

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface ProviderFulfillmentResult {
  iccids: string[]
  providerFulfillId?: string | null
  providerReservationId?: string | null
  providerStatus?: string | null
  qrCodeUrl?: string | null
  activationCode?: string | null
  providerResponse?: any
  rawMetadata?: any
}

export interface PersistFulfillmentInput {
  orderId: string
  businessId: string
  providerAttemptId?: string
  providerResult: ProviderFulfillmentResult
  packageSnapshot?: any
  packageName?: string
  packageDataGB?: number
  packageValidityDays?: number
  validityDays?: number
  userId?: string
}

export interface PersistFulfillmentOutput {
  success: boolean
  requestedQuantity: number
  persistedQuantity: number
  existingQuantity: number
  iccids: string[]
  failedItems: Array<{ iccid: string; reason: string }>
  alreadyFulfilled?: boolean
}

export interface FinalizeOutput {
  success: boolean
  orderStatus: string
  walletCaptured: boolean
  eSIMsPersisted: boolean
  error?: string
  recoveryRequired?: boolean
}

// ─────────────────────────────────────────────
// Task 3: Idempotent eSIM persistence
// ─────────────────────────────────────────────

/**
 * Persist provider fulfillment results idempotently into eSIM records.
 *
 * - ICCID uniqueness prevents duplicates at the database level.
 * - If an eSIM already exists for the same order + ICCID, missing
 *   provider fields are updated without creating a duplicate.
 * - ActivationCode and qrCodeUrl are never overwritten with null.
 * - Returns exactly what was persisted vs. what was requested.
 */
export async function persistProviderFulfillment(input: PersistFulfillmentInput): Promise<PersistFulfillmentOutput> {
  const { orderId, providerResult, packageSnapshot, packageName, packageDataGB, packageValidityDays, validityDays = 30 } = input
  const { iccids, providerFulfillId, providerReservationId, providerStatus, qrCodeUrl, activationCode, rawMetadata } = providerResult

  // Load existing eSIMs for this order
  const existingEsims = await prisma.eSIM.findMany({
    where: { purchaseId: orderId },
    select: { id: true, iccid: true, status: true, activationCode: true, qrCodeUrl: true },
  })
  const existingIccids = new Set(existingEsims.map(e => e.iccid))

  const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId } })
  if (!order) return { success: false, requestedQuantity: iccids.length, persistedQuantity: 0, existingQuantity: existingEsims.length, iccids: [], failedItems: [{ iccid: '', reason: 'Order not found' }] }

  const pkg = order.packageId ? await prisma.eSIMPackage.findUnique({ where: { id: order.packageId } }) : null
  const snap = packageSnapshot ?? (order.packageSnapshot as any)
  const pName = packageName || order.packageName || ''
  const pGB = packageDataGB ?? order.packageDataGB ?? 0
  const pValidity = packageValidityDays ?? order.packageValidityDays ?? validityDays

  let persistedCount = 0
  const finalIccids: string[] = []
  const failedItems: Array<{ iccid: string; reason: string }> = []

  for (const iccid of iccids) {
    const cleanIccid = String(iccid).trim()
    if (!cleanIccid) {
      failedItems.push({ iccid, reason: 'Empty ICCID' })
      continue
    }

    const alreadyExists = existingIccids.has(cleanIccid)
    try {
      if (alreadyExists) {
        // Update missing fields without overwriting valid data
        const esim = existingEsims.find(e => e.iccid === cleanIccid)!
        const updateData: any = {
          providerActivationId: providerFulfillId || esim.id,
          providerStatus: providerStatus || 'ACTIVE',
          ...(providerReservationId ? { providerReservationId } : {}),
          ...(rawMetadata ? { providerResponse: rawMetadata } : {}),
        }
        // Never overwrite valid data with null
        if (activationCode && !esim.activationCode) updateData.activationCode = activationCode
        if (qrCodeUrl && !esim.qrCodeUrl) updateData.qrCodeUrl = qrCodeUrl

        await prisma.eSIM.update({ where: { id: esim.id }, data: updateData })
      } else {
        await prisma.eSIM.create({
          data: {
            purchaseId: orderId,
            iccid: cleanIccid,
            imsi: null,
            status: 'PENDING_ACTIVATION',
            providerActivationId: providerFulfillId || '',
            providerSubscriptionId: providerReservationId || null,
            providerStatus: providerStatus || 'ACTIVE',
            activationCode: activationCode || null,
            qrCodeUrl: qrCodeUrl || null,
            expiresAt: new Date(Date.now() + (pkg?.validityDays || validityDays) * 86400000),
            packageSnapshot: snap ?? undefined,
            packageName: pName,
            packageDataGB: pGB,
            packageValidityDays: pValidity,
            ...(rawMetadata ? { providerResponse: rawMetadata } : {}),
          },
        })
      }
      persistedCount++
      finalIccids.push(cleanIccid)
    } catch (e: any) {
      // P2002 = unique constraint violation (duplicate ICCID from race)
      if (e.code === 'P2002' || /unique.*iccid/i.test(e.message || '')) {
        const existing = existingIccids.has(cleanIccid)
          ? null
          : await prisma.eSIM.findUnique({ where: { iccid: cleanIccid }, select: { id: true, status: true, activationCode: true, qrCodeUrl: true } })
        if (existing) {
          // ICCID exists in DB (possibly from a different order) — update this order's fields
          const updateData: any = {
            providerActivationId: providerFulfillId || existing.id,
            providerStatus: providerStatus || 'ACTIVE',
            ...(activationCode && !existing.activationCode ? { activationCode } : {}),
            ...(qrCodeUrl && !existing.qrCodeUrl ? { qrCodeUrl } : {}),
            ...(rawMetadata ? { providerResponse: rawMetadata } : {}),
          }
          await prisma.eSIM.update({ where: { id: existing.id }, data: updateData }).catch(() => {})
          persistedCount++
          finalIccids.push(cleanIccid)
          continue
        }
      }
      failedItems.push({ iccid: cleanIccid, reason: e.message?.substring(0, 200) || 'Persistence error' })
    }
  }

  return {
    success: failedItems.length === 0,
    requestedQuantity: iccids.length,
    persistedQuantity: persistedCount,
    existingQuantity: existingEsims.length,
    iccids: finalIccids,
    failedItems,
  }
}

// ─────────────────────────────────────────────
// Task 5-6: Complete provider finalization
// ─────────────────────────────────────────────

/**
 * Complete the local finalization of a provider-fulfilled order.
 * Safe to call multiple times — every step is idempotent.
 *
 * Logical order:
 *  1. Persist provider-success evidence on the order.
 *  2. Persist/update all eSIM records idempotently.
 *  3. Capture reserved wallet funds (only after eSIMs exist).
 *  4. Transition to FULFILLED.
 *  5. Record timeline events.
 *
 * If any step fails, the order remains in a recoverable state.
 * The provider is never called again.
 */
export async function completeProviderFinalization(input: {
  orderId: string
  businessId: string
  providerId: string
  providerRef: string
  providerName: string
  totalAmount: number
  providerResult: ProviderFulfillmentResult
  userId?: string
  packageSnapshot?: any
  packageName?: string
  packageDataGB?: number
  packageValidityDays?: number
  validityDays?: number
}): Promise<FinalizeOutput> {
  const { orderId, businessId, providerId, providerRef, providerName, totalAmount, providerResult, userId, packageSnapshot, packageName, packageDataGB, packageValidityDays, validityDays } = input

  // Guard: load order and check state
  const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId } })
  if (!order) return { success: false, orderStatus: 'UNKNOWN', walletCaptured: false, eSIMsPersisted: false, error: 'Order not found' }
  if (order.status === 'FULFILLED') return { success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true }

  // Step 1: Durably record provider success evidence
  const providerEvidence = {
    providerFulfillId: providerRef || providerResult.providerFulfillId || null,
    providerReservationId: providerResult.providerReservationId || null,
    providerResponse: providerResult.rawMetadata || providerResult.providerResponse || null,
  }
  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: {
      providerId,
      providerFulfillId: providerEvidence.providerFulfillId,
      providerReservationId: providerEvidence.providerReservationId,
      ...(providerEvidence.providerResponse ? { providerResponse: providerEvidence.providerResponse } : {}),
      lastRetryAt: new Date(),
    },
  })
  await createTimelineEvent(orderId, { eventType: 'PROVIDER_FULFILLMENT_RECORDED', message: `Provider ${providerName} reported success — ${providerResult.iccids.length} ICCIDs` })

  // Step 2: Persist eSIMs idempotently
  const persistResult = await persistProviderFulfillment({
    orderId, businessId, providerResult, packageSnapshot, packageName, packageDataGB, packageValidityDays, validityDays, userId,
  })

  if (persistResult.persistedQuantity > 0) {
    await createTimelineEvent(orderId, { eventType: 'ESIMS_PERSISTED', message: `${persistResult.persistedQuantity} eSIM${persistResult.persistedQuantity !== 1 ? 's' : ''} persisted (${persistResult.iccids.map(i => i.slice(-4)).join(', ')})` })
  }

  // Step 3: Check for failed items
  if (persistResult.failedItems.length > 0) {
    await createTimelineEvent(orderId, {
      eventType: 'LOCAL_FINALIZATION_FAILED',
      message: `eSIM persistence: ${persistResult.persistedQuantity}/${persistResult.requestedQuantity} succeeded. Failed: ${persistResult.failedItems.map(f => f.iccid.slice(-4)).join(', ')}`,
    })
    return {
      success: false,
      orderStatus: order.status,
      walletCaptured: false,
      eSIMsPersisted: false,
      error: `Partial eSIM persistence: ${persistResult.persistedQuantity}/${persistResult.requestedQuantity}`,
      recoveryRequired: true,
    }
  }

  // Step 4: Verify we have all requested ICCIDs
  const currentEsims = await prisma.eSIM.count({ where: { purchaseId: orderId } })
  if (currentEsims < order.quantity) {
    await createTimelineEvent(orderId, {
      eventType: 'LOCAL_FINALIZATION_FAILED',
      message: `Quantity mismatch: have ${currentEsims} eSIMs, need ${order.quantity}`,
    })
    return {
      success: false,
      orderStatus: order.status,
      walletCaptured: false,
      eSIMsPersisted: true,
      error: `Quantity mismatch: ${currentEsims}/${order.quantity}`,
      recoveryRequired: true,
    }
  }

  // Step 5: Capture wallet idempotently
  const captureResult = await captureReservedFunds(orderId, businessId || order.businessId, totalAmount || Number(order.totalAmount))
  if (!captureResult.success) {
    await createTimelineEvent(orderId, { eventType: 'LOCAL_FINALIZATION_FAILED', message: `Wallet capture failed: ${captureResult.error}` })
    return {
      success: false,
      orderStatus: order.status,
      walletCaptured: false,
      eSIMsPersisted: true,
      error: `Wallet capture failed: ${captureResult.error}`,
      recoveryRequired: true,
    }
  }
  await createTimelineEvent(orderId, { eventType: 'WALLET_CAPTURED', message: `Captured $${totalAmount}` })

  // Step 6: Transition to FULFILLED
  const transition = await transitionOrder(orderId, 'FULFILLED')
  if (!transition.success) {
    return {
      success: false,
      orderStatus: order.status,
      walletCaptured: true,
      eSIMsPersisted: true,
      error: transition.error,
      recoveryRequired: true,
    }
  }

  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: { providerStatus: 'ACTIVE' },
  })

  await createTimelineEvent(orderId, { eventType: 'ORDER_FULFILLED', message: `Order completed — ${providerName}` })
  publishOrderLifecycleEvent({ orderId, eventType: ORDER_LIFECYCLE_EVENTS.FULFILLED }).catch(() => {})

  // Audit
  await prisma.auditLog.create({
    data: {
      userId: userId || order.userId || '',
      action: 'PROVIDER_FULFILLMENT_COMPLETED',
      entity: 'Purchase',
      entityId: orderId,
      details: JSON.stringify({ providerId, providerRef, iccids: persistResult.iccids, totalAmount }),
    },
  }).catch(() => {})

  return { success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true }
}

// ─────────────────────────────────────────────
// Task 6: Resumable local finalization
// ─────────────────────────────────────────────

/**
 * Resume a provider finalization that was interrupted after provider success.
 * Safe to call from jobs, admin panel, or after process restart.
 * Never calls the provider purchase endpoint.
 */
export async function resumeProviderFinalization(orderId: string): Promise<FinalizeOutput> {
  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    include: { business: true, esims: true },
  })
  if (!order) return { success: false, orderStatus: 'UNKNOWN', walletCaptured: false, eSIMsPersisted: false, error: 'Order not found' }
  if (order.status === 'FULFILLED') return { success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true }

  await createTimelineEvent(orderId, { eventType: 'LOCAL_FINALIZATION_RESUMED', message: 'Local finalization resumed' })

  // Check: is there provider fulfillment evidence?
  if (!order.providerFulfillId && !order.providerReservationId) {
    // Check the providerResponse for ICCIDs
    const pr = (order.providerResponse as any) || {}
    const iccidsFromResponse: string[] = pr?.iccids || []
    if (iccidsFromResponse.length === 0) {
      return { success: false, orderStatus: order.status, walletCaptured: false, eSIMsPersisted: false, error: 'No provider fulfillment evidence found — cannot resume', recoveryRequired: true }
    }

    // Reconstruct provider result from stored data
    const providerResult: ProviderFulfillmentResult = {
      iccids: iccidsFromResponse.map(String),
      providerFulfillId: pr.providerReference || order.providerFulfillId,
      providerReservationId: order.providerReservationId,
      rawMetadata: order.providerResponse,
    }

    const persistResult = await persistProviderFulfillment({
      orderId,
      businessId: order.businessId,
      providerResult,
      packageSnapshot: order.packageSnapshot,
      packageName: order.packageName || '',
      packageDataGB: order.packageDataGB ?? 0,
      packageValidityDays: order.packageValidityDays ?? 30,
      userId: order.userId,
    })

    await createTimelineEvent(orderId, { eventType: 'LOCAL_FINALIZATION_RESUMED', message: `Resumed — persisted ${persistResult.persistedQuantity}/${persistResult.requestedQuantity} eSIMs` })

    if (persistResult.failedItems.length > 0) {
      return { success: false, orderStatus: order.status, walletCaptured: false, eSIMsPersisted: false, error: 'eSIM persistence incomplete', recoveryRequired: true }
    }
  }

  // Check wallet transactions
  const captureTx = await prisma.walletTransaction.findFirst({
    where: { orderId, type: 'WALLET_CAPTURE' },
  })
  const releaseTx = await prisma.walletTransaction.findFirst({
    where: { orderId, type: 'WALLET_RELEASE' },
  })

  if (releaseTx && !captureTx) {
    return { success: false, orderStatus: order.status, walletCaptured: false, eSIMsPersisted: order.esims.length > 0, error: 'Funds were already released — cannot capture', recoveryRequired: true }
  }

  if (!captureTx) {
    // Need to capture
    const captureResult = await captureReservedFunds(orderId, order.businessId, Number(order.totalAmount))
    if (!captureResult.success) {
      await createTimelineEvent(orderId, { eventType: 'LOCAL_FINALIZATION_FAILED', message: `Resume — wallet capture failed: ${captureResult.error}` })
      return { success: false, orderStatus: order.status, walletCaptured: false, eSIMsPersisted: true, error: captureResult.error, recoveryRequired: true }
    }
    await createTimelineEvent(orderId, { eventType: 'WALLET_CAPTURED', message: `Resumed — captured $${order.totalAmount}` })
  }

  // Transition to FULFILLED
  await transitionOrder(orderId, 'FULFILLED').catch(() => {})

  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: { providerStatus: 'ACTIVE' },
  }).catch(() => {})

  if (order.status !== 'FULFILLED') {
    await createTimelineEvent(orderId, { eventType: 'ORDER_FULFILLED', message: 'Order completed — resumed finalization' })
    publishOrderLifecycleEvent({ orderId, eventType: ORDER_LIFECYCLE_EVENTS.FULFILLED }).catch(() => {})
  }

  return { success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true }
}

// ─────────────────────────────────────────────
// Task 3: Quantity derivation
// ─────────────────────────────────────────────

export interface FulfillmentQuantities {
  requestedQuantity: number
  fulfilledQuantity: number
  remainingQuantity: number
  failedQuantity: number
  capturedAmount: number
  unitPrice: number
}

/**
 * Derive authoritative fulfillment quantities for an order.
 * Uses immutable pricing where available; falls back to legacy fields safely.
 */
export async function deriveOrderFulfillmentQuantities(orderId: string): Promise<FulfillmentQuantities> {
  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    include: { esims: { select: { id: true, iccid: true } }, business: { select: { id: true } } },
  })
  if (!order) return { requestedQuantity: 0, fulfilledQuantity: 0, remainingQuantity: 0, failedQuantity: 0, capturedAmount: 0, unitPrice: 0 }

  const requestedQuantity = order.quotedQuantity ?? order.quantity ?? 1
  const unitPrice = Number(order.quotedUnitPrice ?? order.packageUnitPrice ?? 0)

  const uniqueIccids = new Set(order.esims.map(e => e.iccid).filter(Boolean))
  const fulfilledQuantity = Math.min(uniqueIccids.size, requestedQuantity)
  const failedQuantity = order.failedQuantity ?? 0
  const remainingQuantity = Math.max(0, requestedQuantity - fulfilledQuantity - failedQuantity)

  const captures = await prisma.walletTransaction.findMany({
    where: { orderId, type: 'WALLET_CAPTURE' },
    select: { amount: true },
  })
  const capturedAmount = captures.reduce((sum, c) => sum + Math.abs(Number(c.amount || 0)), 0)

  return { requestedQuantity, fulfilledQuantity, remainingQuantity, failedQuantity, capturedAmount, unitPrice }
}

// ─────────────────────────────────────────────
// Task 7: Partial fulfillment flow
// ─────────────────────────────────────────────

export async function processPartialFulfillment(input: {
  orderId: string
  businessId: string
  providerId: string
  providerRef: string
  providerName: string
  totalAmount: number
  providerResult: ProviderFulfillmentResult
  userId?: string
  packageSnapshot?: any
  packageName?: string
  packageDataGB?: number
  packageValidityDays?: number
  validityDays?: number
}): Promise<FinalizeOutput> {
  const { orderId, businessId, providerId, providerRef, providerName, totalAmount, providerResult, userId, packageSnapshot, packageName, packageDataGB, packageValidityDays, validityDays } = input

  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: orderId },
    include: { business: { select: { id: true } } },
  })
  if (!order) return { success: false, orderStatus: 'UNKNOWN', walletCaptured: false, eSIMsPersisted: false, error: 'Order not found' }
  if (order.status === 'FULFILLED') return { success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true }

  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: { providerId, providerFulfillId: providerRef || providerResult.providerFulfillId || undefined, providerReservationId: providerResult.providerReservationId || undefined, lastRetryAt: new Date() },
  })

  const persistResult = await persistProviderFulfillment({
    orderId, businessId, providerResult, packageSnapshot, packageName, packageDataGB, packageValidityDays, validityDays, userId,
  })

  await createTimelineEvent(orderId, { eventType: 'FULFILLMENT_BATCH_RECEIVED', message: `${persistResult.persistedQuantity}/${persistResult.requestedQuantity} eSIMs in batch` })

  const qtys = await deriveOrderFulfillmentQuantities(orderId)
  const newlyFulfilled = Math.max(0, qtys.fulfilledQuantity - (order.fulfilledQuantity ?? 0))
  const unitPrice = Number(order.quotedUnitPrice ?? order.packageUnitPrice ?? 0)
  const captureAmount = unitPrice * newlyFulfilled

  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: { fulfilledQuantity: qtys.fulfilledQuantity, failedQuantity: qtys.failedQuantity },
  })

  let walletCaptured = false
  if (newlyFulfilled > 0 && captureAmount > 0) {
    const existingCaptures = await prisma.walletTransaction.findMany({
      where: { orderId, type: 'WALLET_CAPTURE' },
    })
    const alreadyCaptured = existingCaptures.reduce((s, c) => s + Math.abs(Number(c.amount || 0)), 0)
    const remainingToCapture = qtys.capturedAmount - alreadyCaptured

    if (remainingToCapture > 0) {
      const captureResult = await captureReservedFunds(orderId, businessId, remainingToCapture)
      if (captureResult.success) {
        walletCaptured = true
        await createTimelineEvent(orderId, { eventType: 'PARTIAL_WALLET_CAPTURED', message: `Captured ${remainingToCapture} for ${newlyFulfilled} new eSIMs` })
      }
    }
  }

  const caps = await prisma.walletTransaction.findMany({ where: { orderId, type: 'WALLET_CAPTURE' }, select: { amount: true } })
  const totalCaptured = caps.reduce((s, c) => s + Math.abs(Number(c.amount || 0)), 0)
  await prisma.eSIMPurchase.update({ where: { id: orderId }, data: { capturedAmount: totalCaptured } })

  if (qtys.remainingQuantity === 0 && qtys.fulfilledQuantity > 0) {
    await transitionOrder(orderId, 'FULFILLED')
    await prisma.eSIMPurchase.update({ where: { id: orderId }, data: { fulfillmentCompletedAt: new Date() } })
    await createTimelineEvent(orderId, { eventType: 'ORDER_FULFILLED', message: `All ${qtys.fulfilledQuantity} eSIMs fulfilled` })
    publishOrderLifecycleEvent({ orderId, eventType: ORDER_LIFECYCLE_EVENTS.FULFILLED }).catch(() => {})
    return { success: true, orderStatus: 'FULFILLED', walletCaptured: true, eSIMsPersisted: true }
  }

  if (qtys.fulfilledQuantity > 0 && qtys.remainingQuantity > 0) {
    await transitionOrder(orderId, 'PARTIALLY_FULFILLED')
    publishOrderLifecycleEvent({ orderId, eventType: ORDER_LIFECYCLE_EVENTS.PARTIALLY_FULFILLED, metadata: { fulfilledQuantity: qtys.fulfilledQuantity, remainingQuantity: qtys.remainingQuantity }, transitionKey: `${orderId}:partial:${qtys.fulfilledQuantity}` }).catch(() => {})
    await createTimelineEvent(orderId, { eventType: 'PARTIAL_FULFILLMENT_RECORDED', message: `${qtys.fulfilledQuantity} of ${qtys.requestedQuantity} eSIMs fulfilled` })
    await prisma.eSIMPurchase.update({ where: { id: orderId }, data: { nextRetryAt: new Date(Date.now() + 5 * 60_000), retryReason: `Waiting for ${qtys.remainingQuantity} remaining eSIMs` } })
    return { success: true, orderStatus: 'PARTIALLY_FULFILLED', walletCaptured: walletCaptured, eSIMsPersisted: true }
  }

  return { success: false, orderStatus: order.status, walletCaptured: false, eSIMsPersisted: false, error: 'No valid eSIMs in provider response' }
}
