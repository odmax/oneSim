import { prisma } from '@/lib/prisma'
import { getQuoteExpiryMinutes, PRICING_ENGINE_VERSION } from '../currency/currency-config'
import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'

export async function createPurchaseQuote(params: {
  businessId: string
  providerPackageId: string
  quantity: number
}): Promise<{ success: boolean; quote?: any; error?: string }> {
  const { businessId, providerPackageId, quantity } = params

  const pkg = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    select: {
      pricingStatus: true, sellingPrice: true, sellingCurrency: true, effectiveCostPrice: true, currency: true, id: true,
      activePriceSnapshotId: true, costStatus: true, publishStatus: true, configurationStatus: true, costPrice: true,
      provider: { select: { status: true, enabledCapabilities: true, code: true } },
    },
  })
  if (!pkg) {
    console.log(`[BUSINESS_QUOTE_TRACE] stage=PACKAGE_LOOKUP status=FAILED providerPackageId=${providerPackageId}`)
    return { success: false, error: 'Package not found' }
  }
  console.log(`[BUSINESS_QUOTE_TRACE] stage=PACKAGE_LOOKUP status=SUCCESS pricingStatus=${pkg.pricingStatus} hasSnapshot=${!!pkg.activePriceSnapshotId}`)

  const readiness = getPackagePurchaseReadiness({
    providerPkg: { costStatus: pkg.costStatus, pricingStatus: pkg.pricingStatus, publishStatus: pkg.publishStatus, configurationStatus: pkg.configurationStatus, activePriceSnapshotId: pkg.activePriceSnapshotId, sellingPrice: pkg.sellingPrice, costPrice: pkg.costPrice },
    provider: { status: pkg.provider.status, enabledCapabilities: pkg.provider.enabledCapabilities, code: pkg.provider.code },
  })
  if (!readiness.ready) {
    console.log(`[BUSINESS_QUOTE_TRACE] stage=PRICING_READINESS status=FAILED reasons=${readiness.reasons.join('; ')}`)
    return { success: false, error: readiness.reasons[0] || 'Package not ready for purchase' }
  }

  // Verify active snapshot exists and belongs to this package
  const snapshot = await prisma.packagePriceSnapshot.findUnique({
    where: { id: pkg.activePriceSnapshotId! },
    select: { id: true, finalSellingPrice: true, sellingCurrency: true, effectiveCostAmount: true, effectiveCostCurrency: true, status: true },
  })
  if (!snapshot || snapshot.status !== 'ACTIVE') return { success: false, error: 'Active price snapshot invalid' }

  // Use snapshot values, not mutable package fields
  const sellPrice = Number(snapshot.finalSellingPrice)
  if (sellPrice <= 0) return { success: false, error: 'No valid selling price' }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + getQuoteExpiryMinutes() * 60 * 1000)
  const quoteRef = `QT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const totalAmount = sellPrice * quantity
  const costAmount = Number(snapshot.effectiveCostAmount)

  const quote = await prisma.purchaseQuote.create({
    data: {
      quoteReference: quoteRef,
      providerPackageId, packagePriceSnapshotId: snapshot.id,
      businessId, quantity,
      unitPrice: sellPrice, totalAmount,
      currency: snapshot.sellingCurrency || 'USD',
      effectiveCostAmount: costAmount, effectiveCostCurrency: snapshot.effectiveCostCurrency || 'USD',
      pricingEngineVersion: PRICING_ENGINE_VERSION,
      expiresAt,
    },
  })

  return { success: true, quote: { reference: quote.quoteReference, unitPrice: sellPrice, totalAmount, currency: quote.currency, expiresAt: quote.expiresAt.toISOString() } }
}

export async function validatePurchaseQuote(quoteRef: string, businessId: string): Promise<{ valid: boolean; quote?: any; error?: string }> {
  const quote = await prisma.purchaseQuote.findUnique({ where: { quoteReference: quoteRef } })
  if (!quote) return { valid: false, error: 'Quote not found' }
  if (quote.businessId !== businessId) return { valid: false, error: 'Unauthorized' }
  if (quote.status !== 'ACTIVE') return { valid: false, error: `Quote ${quote.status}` }
  if (new Date() > quote.expiresAt) return { valid: false, error: 'Quote expired' }
  return { valid: true, quote }
}

export async function consumePurchaseQuote(quoteRef: string, idempotencyKey?: string): Promise<{ success: boolean; error?: string }> {
  const result = await prisma.purchaseQuote.updateMany({
    where: { quoteReference: quoteRef, status: 'ACTIVE', expiresAt: { gt: new Date() } },
    data: { status: 'CONSUMED', consumedAt: new Date(), idempotencyKey: idempotencyKey || null },
  })
  if (result.count === 0) return { success: false, error: 'Quote not found, already consumed, or expired' }
  return { success: true }
}

export interface QuoteOrderInput {
  quoteReference: string
  businessId: string
  userId: string
  packageId: string
  quantity: number
  idempotencyKey?: string
  callbackUrl?: string
  packageName?: string
  packageDataGB?: number
  packageValidityDays?: number
}

export interface QuoteOrderResult {
  success: boolean
  orderId?: string
  order?: any
  error?: string
  errorCode?: string
  alreadyConsumed?: boolean
  existingOrderId?: string
}

/**
 * Atomically consume a quote and create an order in one Prisma transaction.
 *
 * Transaction sequence:
 *  1. Load & validate quote (ACTIVE, not expired, correct business, quantity matches)
 *  2. Guarded update: ACTIVE → CONSUMED (affected rows === 1)
 *  3. Create ESIMPurchase linked to quote + price snapshot with immutable pricing
 *  4. Create timeline event
 *
 * Concurrency safety: guarded updateMany WHERE status='ACTIVE' ensures only one
 * request succeeds. The second request sees affected rows === 0 → already consumed.
 */
export async function consumeQuoteAndCreateOrder(input: QuoteOrderInput): Promise<QuoteOrderResult> {
  const { quoteReference, businessId, userId, packageId, quantity, idempotencyKey, callbackUrl, packageName, packageDataGB, packageValidityDays } = input

  // 0. Check for existing order by idempotency key
  if (idempotencyKey) {
    const providerPurchaseKey = `${businessId}:${idempotencyKey}`
    const existing = await prisma.eSIMPurchase.findUnique({
      where: { providerPurchaseKey },
    })
    if (existing) {
      return { success: true, orderId: existing.id, order: existing, alreadyConsumed: true, existingOrderId: existing.id }
    }
  }

  return prisma.$transaction(async (tx) => {
    // 1. Load quote
    const quote = await tx.purchaseQuote.findUnique({
      where: { quoteReference },
      select: {
        id: true, status: true, expiresAt: true, businessId: true,
        quantity: true, unitPrice: true, totalAmount: true, currency: true,
        packagePriceSnapshotId: true, pricingEngineVersion: true,
        providerPackageId: true,
      },
    })

    if (!quote) return { success: false, error: 'Quote not found', errorCode: 'QUOTE_NOT_FOUND' }
    if (quote.businessId !== businessId) return { success: false, error: 'Quote does not belong to this business', errorCode: 'QUOTE_TENANT_MISMATCH' }
    if (quote.status !== 'ACTIVE') {
      if (quote.status === 'CONSUMED') {
        const linkedOrder = await tx.eSIMPurchase.findFirst({
          where: { purchaseQuoteId: quote.id, businessId },
          orderBy: { createdAt: 'desc' },
        })
        if (linkedOrder) return { success: true, orderId: linkedOrder.id, alreadyConsumed: true, existingOrderId: linkedOrder.id }
      }
      return { success: false, error: `Quote is already ${quote.status}`, errorCode: quote.status === 'CONSUMED' ? 'QUOTE_ALREADY_CONSUMED' : 'QUOTE_INVALID' }
    }
    if (new Date() > quote.expiresAt) return { success: false, error: 'Quote has expired', errorCode: 'QUOTE_EXPIRED' }
    if (quote.quantity !== quantity) return { success: false, error: `Quote quantity ${quote.quantity} does not match requested ${quantity}`, errorCode: 'QUOTE_QUANTITY_MISMATCH' }

    // 2. Verify price snapshot still exists
    const snapshot = await tx.packagePriceSnapshot.findUnique({ where: { id: quote.packagePriceSnapshotId }, select: { id: true, status: true } })
    if (!snapshot || snapshot.status !== 'ACTIVE') return { success: false, error: 'Price snapshot is no longer active', errorCode: 'QUOTE_SNAPSHOT_MISSING' }

    // 3. Guarded consume — only one request succeeds
    const consumeResult = await tx.purchaseQuote.updateMany({
      where: { id: quote.id, status: 'ACTIVE', expiresAt: { gt: new Date() } },
      data: { status: 'CONSUMED', consumedAt: new Date(), idempotencyKey: idempotencyKey || null },
    })
    if (consumeResult.count === 0) {
      // Check if already consumed (by another concurrent request)
      const consumedCheck = await tx.purchaseQuote.findUnique({ where: { id: quote.id }, select: { status: true } })
      if (consumedCheck?.status === 'CONSUMED') {
        // Try to find the linked order
        const linkedOrder = await tx.eSIMPurchase.findFirst({
          where: { purchaseQuoteId: quote.id, businessId },
          orderBy: { createdAt: 'desc' },
        })
        if (linkedOrder) return { success: true, orderId: linkedOrder.id, alreadyConsumed: true, existingOrderId: linkedOrder.id }
        return { success: false, error: 'Quote already consumed', errorCode: 'QUOTE_ALREADY_CONSUMED' }
      }
      return { success: false, error: 'Quote not found, already consumed, or expired', errorCode: 'QUOTE_ALREADY_CONSUMED' }
    }

    // 4. Create order with immutable pricing
    const purchaseKey = idempotencyKey ? `${businessId}:${idempotencyKey}` : undefined
    const order = await tx.eSIMPurchase.create({
      data: {
        businessId, userId, packageId, quantity,
        totalAmount: quote.totalAmount,
        status: 'CREATED',
        purchaseQuoteId: quote.id,
        packagePriceSnapshotId: quote.packagePriceSnapshotId,
        quotedUnitPrice: quote.unitPrice,
        quotedTotalAmount: quote.totalAmount,
        quotedCurrency: quote.currency,
        quotedQuantity: quote.quantity,
        pricingEngineVersion: quote.pricingEngineVersion,
        callbackUrl: callbackUrl || null,
        packageSnapshot: {
          packageId, quantity,
          unitPrice: Number(quote.unitPrice), totalAmount: Number(quote.totalAmount),
          currency: quote.currency,
          packageName, packageDataGB, packageValidityDays,
          pricingEngineVersion: quote.pricingEngineVersion,
        } as any,
        packageName: packageName || null,
        packageDataGB: packageDataGB || null,
        packageValidityDays: packageValidityDays || null,
        packageUnitPrice: Number(quote.unitPrice),
        packageCurrency: quote.currency,
        providerPurchaseKey: purchaseKey || null,
      },
    })

    // 5. Timeline
    await tx.orderTimelineEvent.create({
      data: {
        orderId: order.id,
        eventType: 'ORDER_CREATED_FROM_QUOTE',
        message: `Order created from quote ${quoteReference.slice(-8)} — ${quantity}x @ ${quote.currency} ${Number(quote.unitPrice).toFixed(2)}`,
      },
    })

    return { success: true, orderId: order.id, order }
  }).catch((e: any) => {
    // Handle unique constraint violations
    if (e.code === 'P2002' && (e.message || '').includes('providerPurchaseKey')) {
      return { success: false, error: 'Duplicate purchase key', errorCode: 'DUPLICATE_IDEMPOTENCY' }
    }
    if (e.code === 'P2002' && (e.message || '').includes('purchaseQuoteId')) {
      return { success: false, error: 'Quote already consumed by another order', errorCode: 'QUOTE_ALREADY_CONSUMED' }
    }
    return { success: false, error: e.message || 'Transaction failed', errorCode: 'TRANSACTION_FAILED' }
  })
}
