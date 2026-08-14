import { prisma } from '@/lib/prisma'
import { getAdapterForProvider } from '@/lib/providers/adapter-manager'
import { reserveTopUpFunds, captureTopUpFundsUpToInTx, releaseTopUpFundsUpTo } from './wallet-actions'
import { createTimelineEvent } from './order-state-machine'

export interface TopUpOrderParams {
  businessId: string
  userId: string
  esimId: string
  topUpPackageId: string
  quantity?: number
  /** Optional client-supplied dedup key. One logical top-up is only processed once. */
  idempotencyKey?: string
}

export interface TopUpOrderResult {
  success: boolean
  topUpId?: string
  status?: string
  amount?: number
  currency?: string
  dataAddedMB?: number
  validityDaysAdded?: number
  error?: string
  errorStatus?: number
  alreadyCompleted?: boolean
}

/**
 * Outcome classification for a provider top-up response.
 * UNCERTAIN (timeout/network) keeps the reservation and waits for reconciliation —
 * it is NEVER treated as a definite failure and NEVER blindly retried (F2).
 */
const UNCERTAIN_OUTCOME_HINTS = ['timeout', 'timed out', 'network', 'econnrefused', 'econnreset', 'socket hang up', '503', '502', '504']

function isUncertainOutcome(error?: { message?: string }): boolean {
  const msg = (error?.message || '').toLowerCase()
  return UNCERTAIN_OUTCOME_HINTS.some((hint) => msg.includes(hint))
}

/**
 * Unified top-up billing engine (single implementation for portal + API).
 *
 * Billing invariants:
 * - ONE immutable price source: the quote is snapshotted from the package BEFORE
 *   any wallet mutation or provider dispatch. The provider response NEVER changes
 *   the customer charge (F1).
 * - Each ESIMTopUp is its own wallet billing identity: wallet RESERVE/CAPTURE/
 *   RELEASE entries are keyed by the top-up id, not the purchase id, so a top-up
 *   can never short-circuit against the purchase's ledger (F1).
 * - Reserve BEFORE provider dispatch; capture only after confirmed success;
 *   release on definite failure; keep reserved on UNCERTAIN outcomes (F2).
 * - Idempotent by `idempotencyKey`: a retried request returns the existing record
 *   without re-dispatching the provider or re-deducting the wallet (F2).
 */
export async function createTopUpOrder(params: TopUpOrderParams): Promise<TopUpOrderResult> {
  const { businessId, userId, esimId, topUpPackageId, quantity = 1, idempotencyKey } = params

  const returnExisting = (topUp: { id: string; status: string; amount: any; currency: string; dataAddedMB: number | null; validityDaysAdded: number | null }) => {
    if (topUp.status === 'COMPLETED') {
      return {
        success: true,
        topUpId: topUp.id,
        status: topUp.status,
        amount: Number(topUp.amount),
        currency: topUp.currency,
        dataAddedMB: topUp.dataAddedMB ?? undefined,
        validityDaysAdded: topUp.validityDaysAdded ?? undefined,
        alreadyCompleted: true,
      }
    }
    return {
      success: false,
      topUpId: topUp.id,
      status: topUp.status,
      error: topUp.status === 'PENDING_REVIEW' ? 'Top-up outcome pending review — funds are reserved' : 'Top-up already processed',
      errorStatus: 409,
      alreadyCompleted: true,
    }
  }

  // Idempotency: a previously processed logical top-up is never re-executed.
  // The key is scoped per business — two businesses may safely reuse the same key.
  if (idempotencyKey) {
    const existing = await prisma.eSIMTopUp.findFirst({ where: { businessId, idempotencyKey } })
    if (existing) return returnExisting(existing)
  }

  // Fetch eSIM with relations
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: {
      purchase: { include: { business: true, package: true } },
    },
  })

  if (!esim) return { success: false, error: 'eSIM not found', errorStatus: 404 }
  if (esim.purchase.businessId !== businessId) return { success: false, error: 'eSIM does not belong to this business', errorStatus: 403 }

  const allowedStatuses = ['ACTIVE', 'PENDING_ACTIVATION', 'PENDING']
  if (!allowedStatuses.includes(esim.status)) {
    return { success: false, error: 'eSIM status does not allow top-up', errorStatus: 400 }
  }

  if (!esim.iccid) return { success: false, error: 'eSIM has no ICCID', errorStatus: 400 }

  // Fetch top-up package
  const topUpPkg = await prisma.eSIMPackage.findUnique({ where: { id: topUpPackageId } })
  if (!topUpPkg || !topUpPkg.isActive) return { success: false, error: 'Top-up package not found or inactive', errorStatus: 404 }

  const productType = topUpPkg.productType || 'NEW_ESIM'
  if (productType !== 'TOP_UP' && productType !== 'BOTH') {
    return { success: false, error: 'Package is not a top-up package', errorStatus: 400 }
  }

  const providerId = topUpPkg.providerId || esim.purchase.package.providerId
  if (!providerId) return { success: false, error: 'No provider configured for top-up', errorStatus: 400 }

  // Check provider supports top-up
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider || !provider.supportsTopUp) {
    return { success: false, error: 'Provider does not support top-up', errorStatus: 400 }
  }

  // Check business
  const business = await prisma.business.findUnique({ where: { id: businessId } })
  if (!business) return { success: false, error: 'Business not found', errorStatus: 404 }
  if (business.status === 'SUSPENDED') return { success: false, error: 'Business account is suspended', errorStatus: 403 }

  // ── Immutable quote — the single source of truth for the charge (F1) ──
  const quotedUnitPrice = Number(topUpPkg.priceUSD)
  const amount = quotedUnitPrice * quantity
  const currency = topUpPkg.currency || 'USD'
  if (!(amount > 0)) return { success: false, error: 'Invalid top-up amount', errorStatus: 400 }

  // ── Create the PENDING top-up record with the quote snapshot ──
  // Its id becomes the wallet topUpId, giving every top-up its own reservation
  // (F1: the purchase ledger can no longer short-circuit top-up billing).
  let topUp
  try {
    topUp = await prisma.eSIMTopUp.create({
      data: {
        businessId,
        esimId,
        packageId: topUpPackageId,
        providerId,
        amount,
        currency,
        status: 'PENDING',
        requestedQuantity: quantity,
        quotedUnitPrice,
        quotedTotalAmount: amount,
        quotedCurrency: currency,
        quotedQuantity: quantity,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    })
  } catch (e: any) {
    // Unique-key race on (businessId, idempotencyKey) — already processed.
    if (e?.code === 'P2002' && idempotencyKey) {
      const existing = await prisma.eSIMTopUp.findFirst({ where: { businessId, idempotencyKey } })
      if (existing) return returnExisting(existing)
    }
    throw e
  }

  // ── Reserve wallet (atomic + idempotent, keyed by this top-up's topUpId) ──
  const reserve = await reserveTopUpFunds(topUp.id, businessId, amount)
  if (!reserve.success) {
    await prisma.eSIMTopUp.update({
      where: { id: topUp.id },
      data: { status: 'FAILED', errorMessage: (reserve.error || 'Wallet reserve failed').slice(0, 500), completedAt: new Date() },
    })
    return { success: false, error: reserve.error || 'Insufficient wallet balance', errorStatus: 402 }
  }

  // ── Dispatch provider ──
  const adapter = await getAdapterForProvider(providerId)
  if (!adapter) {
    await releaseTopUpFundsUpTo(topUp.id, businessId, amount)
    await prisma.eSIMTopUp.update({
      where: { id: topUp.id },
      data: { status: 'FAILED', errorMessage: 'Provider adapter unavailable', completedAt: new Date() },
    })
    return { success: false, error: 'Provider adapter unavailable', errorStatus: 502 }
  }

  const providerResult = await adapter.topUpESIM({
    iccid: esim.iccid,
    imsi: esim.imsi,
    planId: topUpPkg.providerPlanId || topUpPkg.id,
    sku: topUpPkg.sku || topUpPkg.packageCode || undefined,
    packageName: topUpPkg.displayName || topUpPkg.name,
    quantity,
  })

  // ── UNCERTAIN outcome (timeout/network): keep funds reserved, hold for review ──
  if (!providerResult.success && isUncertainOutcome(providerResult.error)) {
    await prisma.eSIMTopUp.update({
      where: { id: topUp.id },
      data: { status: 'PENDING_REVIEW', errorMessage: (providerResult.error?.message || 'Provider outcome unknown').slice(0, 500) },
    })
    await createTimelineEvent(esim.purchaseId, {
      eventType: 'TOPUP_PENDING_REVIEW',
      message: `Top-up outcome unknown — funds reserved for reconciliation (${providerResult.error?.message?.slice(0, 120) || 'timeout'})`,
    })
    return { success: false, error: 'Provider top-up outcome unknown — funds reserved for review', errorStatus: 502 }
  }

  // ── DEFINITE FAILURE: release the reservation once, mark FAILED ──
  if (!providerResult.success) {
    const errorMessage = providerResult.error?.message || 'Provider top-up failed'
    await releaseTopUpFundsUpTo(topUp.id, businessId, amount)
    await prisma.eSIMTopUp.update({
      where: { id: topUp.id },
      data: { status: 'FAILED', errorMessage: errorMessage.slice(0, 500), completedAt: new Date() },
    })
    await createTimelineEvent(esim.purchaseId, { eventType: 'TOPUP_FAILED', message: errorMessage.slice(0, 200) })
    ;(async () => {
      try {
        const { enqueueBusinessWebhooks } = await import('@/lib/services/business-webhooks/dispatcher')
        await enqueueBusinessWebhooks(businessId, 'topup.failed', {
          esimId, iccid: esim.iccid, topUpPackageId, error: errorMessage,
        })
      } catch { /* non-fatal */ }
    })()
    return { success: false, error: errorMessage, errorStatus: 502 }
  }

  // ── DEFINITE SUCCESS: atomic completion + capture ──
  const topUpData = providerResult.data!
  const dataAddedMB = topUpData.dataAddedMB ?? (topUpPkg.dataGB ? topUpPkg.dataGB * 1024 : undefined)
  const validityDaysAdded = topUpData.validityDaysAdded ?? topUpPkg.validityDays ?? undefined

  try {
    await prisma.$transaction(async (tx) => {
      // Capture exactly the quoted amount, once, inside the completion transaction.
      // Cumulative + idempotent — concurrent/repeated completion can never double-charge.
      const capture = await captureTopUpFundsUpToInTx(tx, topUp.id, businessId, amount)
      if (!capture.success) throw new Error(capture.error || 'Wallet capture failed')

      await tx.eSIMTopUp.update({
        where: { id: topUp.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          providerReference: topUpData.providerReference || null,
          dataAddedMB: dataAddedMB || null,
          validityDaysAdded: validityDaysAdded || null,
          providerResponse: topUpData as any,
        },
      })

      // Update eSIM expiry and data
      const updateData: any = {}
      if (validityDaysAdded && esim.expiresAt) {
        updateData.expiresAt = new Date(esim.expiresAt.getTime() + validityDaysAdded * 24 * 60 * 60 * 1000)
      } else if (validityDaysAdded) {
        updateData.expiresAt = new Date(Date.now() + validityDaysAdded * 24 * 60 * 60 * 1000)
      }
      if (topUpData.newDataTotalMB) updateData.dataTotalMB = topUpData.newDataTotalMB
      if (topUpData.newDataRemainingMB) updateData.dataRemainingMB = topUpData.newDataRemainingMB

      if (Object.keys(updateData).length > 0) {
        await tx.eSIM.update({ where: { id: esimId }, data: updateData })
      }

      const ts = Date.now().toString(36).toUpperCase()
      const rand = Math.random().toString(36).substring(2, 6).toUpperCase()

      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber: `TOP-${ts}-${rand}`,
          businessId,
          topUpId: topUp.id,
          type: 'TOPUP',
          amount,
          currency,
          status: 'PAID',
          paidAt: new Date(),
        },
      })

      // Finance P&L: record the top-up as TOPUP revenue. The billing-service P&L
      // (getBillingStats / by-provider / by-business) already includes TOPUP in its
      // revenue contract — this is the missing record. Idempotent per invoice.
      await tx.billingRecord.create({
        data: {
          businessId,
          esimId,
          invoiceId: invoice.id,
          type: 'TOPUP',
          amount,
          currency,
          providerId: topUp.providerId,
          description: `Top-up completed (${esim.iccid})`,
        },
      })

      await tx.auditLog.create({
        data: {
          userId,
          action: 'ESIM_TOPUP',
          entity: 'ESIMTopUp',
          entityId: topUp.id,
          details: JSON.stringify({ topUpId: topUp.id, businessId, esimId, iccid: esim.iccid, packageId: topUpPackageId, amount, currency, status: 'COMPLETED' }),
        },
      })
    })

    await createTimelineEvent(esim.purchaseId, {
      eventType: 'TOPUP_COMPLETED',
      message: `Top-up: ${topUpPkg.displayName || topUpPkg.name} (${esim.iccid.slice(-8)})`,
    })
    ;(async () => {
      try {
        const { enqueueBusinessWebhooks } = await import('@/lib/services/business-webhooks/dispatcher')
        await enqueueBusinessWebhooks(businessId, 'topup.completed', {
          topUpId: topUp.id, esimId, iccid: esim.iccid, topUpPackageId, amount, dataAddedMB, validityDaysAdded,
        })
      } catch { /* non-fatal */ }
    })()

    return {
      success: true,
      topUpId: topUp.id,
      status: 'COMPLETED',
      amount,
      currency,
      dataAddedMB: dataAddedMB || undefined,
      validityDaysAdded: validityDaysAdded || undefined,
    }
  } catch (error: any) {
    // Provider succeeded but local completion failed — the reservation is KEPT
    // so the top-up can be resumed without losing funds or re-charging.
    await prisma.eSIMTopUp.update({
      where: { id: topUp.id },
      data: { errorMessage: (error.message || 'Completion failed').slice(0, 500) },
    }).catch(() => {})
    await createTimelineEvent(esim.purchaseId, {
      eventType: 'TOPUP_COMPLETION_FAILED',
      message: `Top-up delivered but local completion failed: ${(error.message || '').slice(0, 200)}`,
    })
    return { success: false, error: `Transaction failed: ${error.message || 'Unknown error'}`, errorStatus: 500 }
  }
}
