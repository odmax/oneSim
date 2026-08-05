import { prisma } from '@/lib/prisma'
import { isProviderOperational } from '@/lib/providers/adapter-manager'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'
import { createTimelineEvent, transitionOrder, failOrder } from './order-state-machine'
import { reserveWalletFunds, captureReservedFunds, releaseReservedFunds } from './wallet-actions'
import { getProviderBalance } from '@/lib/services/providers/provider-balance'
import { resolvePackageIdentifier } from '@/lib/packages/resolve-package'
import { executeProviderAttempt, tryFailoverAfterAttempt } from './provider-attempt-service'
import { ProviderRoutingEngine } from '@/lib/services/routing/provider-routing-engine'
import { requiresTravelDateForPackage, isValidTravelDate } from '@/lib/providers/travel-date-utils'
import { consumeQuoteAndCreateOrder } from '@/lib/pricing/purchase-quote-service'
import { publishOrderLifecycleEvent, ORDER_LIFECYCLE_EVENTS } from './lifecycle-publisher'
import type { CreateOrderParams, CreateOrderResult } from './create-order'

function trace(correlationId: string | undefined, stage: string, status: string, extra?: Record<string, any>) {
  if (!correlationId) return
  const fields = [`correlationId=${correlationId}`, `stage=${stage}`, `status=${status}`]
  if (extra) for (const [k, v] of Object.entries(extra)) fields.push(`${k}=${v}`)
  console.log(`[BUSINESS_PURCHASE_TRACE] ${fields.join(' ')}`)
}

const DUP_WINDOW_MS = 30_000

export interface PurchaseRequest {
  businessId: string
  userId: string
  packageId?: string
  sku?: string
  packageCode?: string
  quantity: number
  /** Optional quote reference for atomic quote consumption + order creation. */
  quoteReference?: string
  /** Internal trace correlation ID — never exposed to clients. */
  correlationId?: string
  customer?: {
    name: string
    email: string
    phone?: string
    country?: string
    externalId?: string
  }
  callbackUrl?: string
  idempotencyKey?: string
  /** Travel date (YYYY-MM-DD) required by plans that mandate it. */
  travelDate?: string
}

export interface PurchaseResult {
  success: boolean
  orderId?: string
  status?: string
  provider?: string
  providerReference?: string
  iccid?: string
  qrCode?: string
  activationCode?: string
  message?: string
  errorCode?: string
  retryable?: boolean
  providerResponse?: any
  unitCost?: number
  totalCost?: number
  currency?: string
  quantity?: number
  esims?: Array<{
    id: string
    iccid: string
    imsi?: string | null
    activationCode?: string | null
    status: string
    qrCodeUrl?: string | null
  }>
  error?: string
  errorStatus?: number
}

export class PurchaseOrchestrator {
  async executePurchase(request: PurchaseRequest): Promise<PurchaseResult> {
    const { businessId, userId, packageId, sku, packageCode, quantity, customer, callbackUrl, idempotencyKey, travelDate, correlationId } = request
    trace(correlationId, 'VALIDATION', 'START', { packageId, quantity, businessId })

    // Step 1: Validate business
    const business = await prisma.business.findUnique({ where: { id: businessId } })
    if (!business) return this.fail('BUSINESS_NOT_FOUND', 'Business not found', false)
    if (business.status === 'SUSPENDED') return this.fail('BUSINESS_SUSPENDED', 'Business suspended', false)

    // Step 2: Validate quantity
    if (quantity < 1 || quantity > 100) return this.fail('INVALID_QUANTITY', 'Quantity must be 1-100', false)

    // Step 3: Resolve package
    const resolution = await resolvePackageIdentifier({ packageId, sku, packageCode })
    if (!resolution || resolution.package.source === 'PROVIDER_PLAN') {
      return this.fail('PACKAGE_NOT_FOUND', 'Package not available for purchase', false)
    }
    const pkg = resolution.package
    trace(correlationId, 'PACKAGE_RESOLVED', 'SUCCESS', { orderPackageId: pkg.id, providerBound: Boolean(pkg.providerId) })

    // Step 4: Validate pricing availability
    trace(correlationId, 'PRICING_CHECK', 'START', { providerPackageId: pkg.providerPackageId || 'none' })
    if (pkg.providerPackageId) {
      const providerPkg = await prisma.providerPackage.findUnique({
        where: { id: pkg.providerPackageId },
        select: { costStatus: true, pricingStatus: true, costSource: true },
      })
      if (providerPkg) {
        if (providerPkg.costStatus === 'MISSING' || providerPkg.costStatus === 'INVALID') {
          trace(correlationId, 'PRICING_CHECK', 'FAILED', { internalCode: 'PACKAGE_UNAVAILABLE', costStatus: providerPkg.costStatus, publicCode: 'package_pricing_unavailable' })
          return this.fail('PACKAGE_UNAVAILABLE', 'This package is temporarily unavailable. Please select another package or try again later.', false)
        }
        if (providerPkg.pricingStatus === 'COST_UNAVAILABLE' || providerPkg.pricingStatus === 'DISABLED') {
          trace(correlationId, 'PRICING_CHECK', 'FAILED', { internalCode: 'PACKAGE_UNAVAILABLE', pricingStatus: providerPkg.pricingStatus, publicCode: 'package_pricing_unavailable' })
          return this.fail('PACKAGE_UNAVAILABLE', 'This package is temporarily unavailable. Please select another package or try again later.', false)
        }
        trace(correlationId, 'PRICING_CHECK', 'SUCCESS', { costStatus: providerPkg.costStatus, costSource: providerPkg.costSource || 'none' })
      }
    } else {
      trace(correlationId, 'PRICING_CHECK', 'SUCCESS', { pricingSource: 'direct_package_price' })
    }

    // Step 4b: Validate travel date requirement before any wallet hold. A
    // required travel date is never invented here — the purchase fails fast
    // with a clear message instead of letting the provider reject it later.
    const normalizedTravelDate = travelDate !== undefined && travelDate !== null && travelDate.trim() !== '' ? travelDate.trim() : undefined
    if (normalizedTravelDate !== undefined && !isValidTravelDate(normalizedTravelDate)) {
      return this.fail('TRAVEL_DATE_INVALID', `travelDate must be a valid date in YYYY-MM-DD format, got "${normalizedTravelDate}"`, false)
    }
    if (pkg.providerPackageId) {
      const travelPkg = await prisma.providerPackage.findUnique({
        where: { id: pkg.providerPackageId },
        select: { providerRawData: true },
      })
      if (requiresTravelDateForPackage(travelPkg) && !normalizedTravelDate) {
        return this.fail('TRAVEL_DATE_REQUIRED', 'This package requires a travel date (YYYY-MM-DD) before purchase.', false)
      }
    }

    // Step 5: Validate business wallet
    let unitPrice = parseFloat(pkg.priceUSD.toString())
    let totalAmount = unitPrice * quantity
    if (parseFloat(business.walletBalance.toString()) < totalAmount) {
      return this.fail('INSUFFICIENT_WALLET', `Wallet balance $${business.walletBalance} is insufficient for $${totalAmount}`, false)
    }

    // Step 5: Validate provider — use routing engine if not assigned
    let providerId = pkg.providerId
    if (!providerId) {
      const { ProviderRoutingEngine } = await import('@/lib/services/routing/provider-routing-engine')
      const engine = new ProviderRoutingEngine()
      const route = await engine.selectBestProvider({ packageId: pkg.id, quantity })
      if (!route.success || !route.selected) return this.fail('NO_PROVIDER', 'No eligible provider found via routing', false)
      providerId = route.selected.providerId
      console.log(`[ROUTING] Selected provider=${route.selected.providerName}(${providerId}) score=${route.selected.score}`)
    }

    const provider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!provider) return this.fail('PROVIDER_NOT_FOUND', 'Provider not found', false)
    if (!isProviderOperational(provider.status)) return this.fail('PROVIDER_UNAVAILABLE', `Provider is ${provider.status}`, false)

    // Step 6: Validate PURCHASE capability
    const caps = (provider.enabledCapabilities || DEFAULT_PROVIDER_CAPABILITIES[provider.code || ''] || []) as string[]
    if (!caps.includes('PURCHASE')) return this.fail('PROVIDER_NO_PURCHASE', 'Provider does not support purchases', false)

    // Step 7: Validate provider balance (if BALANCE capability)
    if (caps.includes('BALANCE')) {
      const balanceResult = await getProviderBalance(provider.id, { forceRefresh: false })
      if (balanceResult.success && balanceResult.supported && balanceResult.balance != null) {
        if (balanceResult.balance < totalAmount) {
          return this.fail('PROVIDER_LOW_BALANCE', `Provider balance ${(balanceResult.currency || '')} ${balanceResult.balance} is insufficient for order total $${totalAmount}`, true)
        }
      }
    }

    // Step 8: Dedup
    const recent = await prisma.eSIMPurchase.findFirst({
      where: { businessId, packageId: pkg.id, quantity, totalAmount, createdAt: { gte: new Date(Date.now() - DUP_WINDOW_MS) }, status: { notIn: ['FAILED', 'CANCELLED', 'REFUNDED'] } },
    })
    if (recent) {
      return { success: true, orderId: recent.id, status: recent.status, unitCost: unitPrice, totalCost: totalAmount, quantity, currency: pkg.currency || 'USD' }
    }

    // Service-layer idempotency: guard for concurrent/non-route callers (keyed by providerPurchaseKey).
    const purchaseKey = idempotencyKey ? `${businessId}:${idempotencyKey}` : undefined
    if (purchaseKey) {
      const existing = await prisma.eSIMPurchase.findUnique({
        where: { providerPurchaseKey: purchaseKey },
        include: { esims: { select: { id: true, iccid: true, imsi: true, activationCode: true, status: true, qrCodeUrl: true } } },
      })
      if (existing) {
        return {
          success: existing.status === 'FULFILLED',
          orderId: existing.id,
          status: existing.status,
          unitCost: unitPrice,
          totalCost: totalAmount,
          quantity,
          currency: pkg.currency || 'USD',
          esims: existing.esims.map((e) => ({ id: e.id, iccid: e.iccid, imsi: e.imsi ?? null, activationCode: e.activationCode ?? null, status: e.status, qrCodeUrl: e.qrCodeUrl ?? null })),
        }
      }
    }

    // Step 9: Find or create customer
    let customerId: string | undefined
    if (customer) {
      let dbCustomer = await prisma.customer.findFirst({ where: { businessId, email: customer.email } })
      if (dbCustomer) {
        dbCustomer = await prisma.customer.update({ where: { id: dbCustomer.id }, data: { name: customer.name, phone: customer.phone || dbCustomer.phone, country: customer.country || dbCustomer.country } })
      } else {
        dbCustomer = await prisma.customer.create({ data: { businessId, name: customer.name, email: customer.email, phone: customer.phone || null, country: customer.country || 'Unknown' } })
      }
      customerId = dbCustomer.id
    }

    const displayName = pkg.displayName || pkg.name
    const packageSnapshot = { packageId: pkg.id, sku: pkg.sku, packageCode: pkg.packageCode, displayName, customerDescription: pkg.customerDescription || null, dataGB: pkg.dataGB, validityDays: pkg.validityDays, priceUSD: unitPrice, localPrice: parseFloat(pkg.localPrice.toString()), currency: pkg.currency || 'USD', source: pkg.source, providerId: pkg.providerId, providerPlanId: pkg.providerPlanId || null, providerName: pkg.providerName || null, purchasedAt: new Date().toISOString() }

    // Step 10: Create order — use quote atomic flow when quoteReference provided
    const quotesRequired = process.env.PRICING_QUOTES_REQUIRED === 'true'
    let orderId: string

    if (request.quoteReference) {
      // Atomic quote consumption + order creation
      const qtResult = await consumeQuoteAndCreateOrder({
        quoteReference: request.quoteReference, businessId, userId: userId,
        packageId: pkg.id, quantity,
        idempotencyKey,
        callbackUrl: callbackUrl || undefined,
        packageName: displayName, packageDataGB: pkg.dataGB, packageValidityDays: pkg.validityDays,
      })
      if (!qtResult.success) {
        if (qtResult.alreadyConsumed && qtResult.existingOrderId) {
          const ex = await prisma.eSIMPurchase.findUnique({ where: { id: qtResult.existingOrderId }, include: { esims: { select: { id: true, iccid: true, imsi: true, activationCode: true, status: true, qrCodeUrl: true } } } })
          if (ex) {
            return { success: ex.status === 'FULFILLED', orderId: ex.id, status: ex.status, unitCost: unitPrice, totalCost: totalAmount, quantity, currency: pkg.currency || 'USD', esims: ex.esims.map(e => ({ id: e.id, iccid: e.iccid, imsi: e.imsi ?? null, activationCode: e.activationCode ?? null, status: e.status, qrCodeUrl: e.qrCodeUrl ?? null })) }
          }
        }
        trace(correlationId, 'ORDER_CREATION', 'FAILED', { internalCode: qtResult.errorCode || 'QUOTE_FAILED' })
        return this.fail(qtResult.errorCode || 'QUOTE_FAILED', qtResult.error || 'Quote consumption failed', false)
      }
      orderId = qtResult.orderId!
      trace(correlationId, 'ORDER_CREATION', 'SUCCESS', { orderId, fromQuote: true })
      // Use immutable quote pricing for wallet operations
      const qOrder = qtResult.order!
      unitPrice = Number(qOrder.quotedUnitPrice || qOrder.packageUnitPrice || unitPrice)
      totalAmount = Number(qOrder.quotedTotalAmount || qOrder.totalAmount || totalAmount)
    } else if (quotesRequired) {
      trace(correlationId, 'QUOTE_VALIDATION', 'FAILED', { quotePresent: false, quotesRequired: true, publicCode: 'quote_required' })
      return this.fail('QUOTE_REQUIRED', 'A valid purchase quote is required for checkout', false)
    } else {
      // Legacy flow — create order directly
      const purchaseKey = idempotencyKey ? `${businessId}:${idempotencyKey}` : undefined
      try {
        const order = await prisma.eSIMPurchase.create({
          data: {
            businessId, userId, packageId: pkg.id, quantity, totalAmount, status: 'CREATED',
            callbackUrl: callbackUrl || null,
            packageSnapshot: packageSnapshot as any,
            packageName: displayName, packageDataGB: pkg.dataGB, packageValidityDays: pkg.validityDays,
            packageUnitPrice: unitPrice, packageCurrency: pkg.currency || 'USD',
            providerPurchaseKey: purchaseKey || null,
            quotedUnitPrice: unitPrice, quotedTotalAmount: totalAmount, quotedCurrency: pkg.currency || 'USD',
            quotedQuantity: quantity, pricingEngineVersion: 'LEGACY_DIRECT',
          },
        })
        orderId = order.id
        trace(correlationId, 'ORDER_CREATION', 'SUCCESS', { orderId, fromQuote: false })
        await createTimelineEvent(orderId, { eventType: 'ORDER_CREATED_WITHOUT_QUOTE', message: `Order created directly — ${quantity}x ${displayName}` })
      } catch (e: any) {
        if (purchaseKey && (e.code === 'P2002' || /providerPurchaseKey/i.test(e.message || ''))) {
          const existing = await prisma.eSIMPurchase.findUnique({ where: { providerPurchaseKey: purchaseKey }, include: { esims: { select: { id: true, iccid: true, imsi: true, activationCode: true, status: true, qrCodeUrl: true } } } })
          if (existing) {
            return {
              success: existing.status === 'FULFILLED', orderId: existing.id, status: existing.status,
              unitCost: unitPrice, totalCost: totalAmount, quantity, currency: pkg.currency || 'USD',
              esims: existing.esims.map(e => ({ id: e.id, iccid: e.iccid, imsi: e.imsi ?? null, activationCode: e.activationCode ?? null, status: e.status, qrCodeUrl: e.qrCodeUrl ?? null })),
            }
          }
        }
        return this.fail('ORDER_CREATE_FAILED', `Failed to create order: ${e.message}`, false)
      }
    }

    await createTimelineEvent(orderId, { eventType: 'ORDER_CREATED', message: `Purchase started: ${quantity}x ${displayName} via ${provider.name}` })
    await transitionOrder(orderId, 'CREATED')
    publishOrderLifecycleEvent({ orderId, eventType: ORDER_LIFECYCLE_EVENTS.CREATED }).catch(() => {})

    // Step 11: Reserve wallet
    const reserve = await reserveWalletFunds(orderId, businessId, totalAmount)
    if (!reserve.success) {
      await failOrder(orderId, `Wallet reserve failed: ${reserve.error}`)
      await this.writeAudit(businessId, userId, providerId, pkg.id, displayName, totalAmount, 'FAILED', reserve.error)
      return this.fail('WALLET_RESERVE_FAILED', reserve.error || 'Wallet reserve failed', true)
    }
    trace(correlationId, 'WALLET_RESERVE', 'SUCCESS')
    await transitionOrder(orderId, 'PAYMENT_RESERVED')
    await createTimelineEvent(orderId, { eventType: 'WALLET_RESERVED', message: `Reserved $${totalAmount}` })

    const planId = pkg.providerPlanId || pkg.id

    // Step 13-14: Dispatch to provider with failover via shared service
    const nameParts = (customer?.name || 'Business Order').trim().split(/\s+/)
    const subscriber = { email: customer?.email || '', first_name: nameParts[0] || '', last_name: nameParts.slice(1).join(' ') || undefined }

    const rankedProviders = await new ProviderRoutingEngine().getRankedProviders({ packageId: pkg.id, quantity })

    let currentProviderId = provider.id
    let currentProviderName = provider.name
    const attemptedIds: string[] = []
    attemptedIds.push(currentProviderId)

    for (let attemptNum = 1; attemptNum <= 3; attemptNum++) {
      const result = await executeProviderAttempt({
        orderId, businessId, providerId: currentProviderId, providerName: currentProviderName,
        planId, quantity, subscriber, totalAmount, displayName, packageId: pkg.id,
        packageSnapshot, pkg, customerId, rankedProviders, policy: 'PREFERRED',
        travelDate: normalizedTravelDate,
      })

      if (result.success && (result.status === 'SUCCEEDED' || result.status === 'ALREADY_COMPLETE')) {
        trace(correlationId, 'PROVIDER_ATTEMPT', 'SUCCESS', { providerName: currentProviderName, attemptNum, connectorType: result.providerReference ? 'found' : 'none' })
        // Load saved eSIMs
        const savedEsims = await prisma.eSIM.findMany({ where: { purchaseId: orderId }, select: { id: true, iccid: true, imsi: true, activationCode: true, status: true, qrCodeUrl: true } })
        return { success: true, orderId, status: 'FULFILLED', provider: currentProviderName, providerReference: result.providerReference, iccid: result.iccids?.[0], qrCode: result.qrCode, unitCost: unitPrice, totalCost: totalAmount, quantity, currency: pkg.currency || 'USD', esims: savedEsims.map(e => ({ id: e.id, iccid: e.iccid, imsi: e.imsi, activationCode: e.activationCode, status: e.status, qrCodeUrl: e.qrCodeUrl })) }
      }

      if (result.success && result.status === 'PROCESSING') {
        return { success: true, orderId, status: 'PROCESSING', provider: currentProviderName, providerReference: result.providerReference, unitCost: unitPrice, totalCost: totalAmount, quantity, currency: pkg.currency || 'USD' }
      }

      // Not retryable — fail immediately
      if (result.status !== 'RETRYABLE') {
        await releaseReservedFunds(orderId, businessId, totalAmount)
        await failOrder(orderId, result.errorMessage || 'Provider activation failed')
        await this.writeAudit(businessId, userId, currentProviderId, pkg.id, displayName, totalAmount, 'FAILED', result.errorMessage)
        return this.fail(result.errorCode || 'PROVIDER_FAILED', result.errorMessage || 'Provider activation failed', false)
      }

      // Try failover
      const next = await tryFailoverAfterAttempt({
        ...(await this.buildActivationInput(orderId, businessId, currentProviderId, provider, planId, quantity, subscriber, totalAmount, displayName, pkg, packageSnapshot, customerId, rankedProviders)),
        currentProviderId, attemptedIds, travelDate: normalizedTravelDate,
      })

      if (!next?.shouldContinue) break
      currentProviderId = next.providerId!
      currentProviderName = next.providerName!
      attemptedIds.push(currentProviderId)
    }

    // Exhausted
    await releaseReservedFunds(orderId, businessId, totalAmount)
    await failOrder(orderId, 'All provider attempts exhausted')
    await this.writeAudit(businessId, userId, provider.id, pkg.id, displayName, totalAmount, 'FAILED', 'All attempts exhausted')
    return this.fail('ALL_PROVIDERS_EXHAUSTED', 'All available providers failed', false)
  }

  private async buildActivationInput(orderId: string, businessId: string, providerId: string, provider: any, planId: string, quantity: number, subscriber: any, totalAmount: number, displayName: string, pkg: any, packageSnapshot: any, customerId: any, rankedProviders: any) {
    return { orderId, businessId, providerId, providerName: provider.name, planId, quantity, subscriber, totalAmount, displayName, packageId: pkg.id, packageSnapshot, pkg, customerId, rankedProviders }
  }

  private fail(code: string, message: string, retryable: boolean): PurchaseResult {
    return { success: false, errorCode: code, message, retryable }
  }

  private async writeAudit(businessId: string, userId: string, providerId: string, packageId: string, packageName: string, amount: number, status: string, reason?: string) {
    try {
      await prisma.auditLog.create({
        data: { userId, action: `PURCHASE_${status}`, entity: 'Purchase', entityId: providerId, details: JSON.stringify({ businessId, packageId, packageName, amount, status, reason: reason || null, timestamp: new Date().toISOString() }) },
      })
    } catch {}
  }
}
