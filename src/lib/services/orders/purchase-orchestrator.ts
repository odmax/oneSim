import { prisma } from '@/lib/prisma'
import { isProviderOperational } from '@/lib/providers/adapter-manager'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'
import { createTimelineEvent, transitionOrder, failOrder } from './order-state-machine'
import { reserveWalletFunds, captureReservedFunds, releaseReservedFunds } from './wallet-actions'
import { getProviderBalance } from '@/lib/services/providers/provider-balance'
import { resolvePackageIdentifier } from '@/lib/packages/resolve-package'
import { executeProviderAttempt, tryFailoverAfterAttempt } from './provider-attempt-service'
import type { ProviderScore } from '@/lib/services/routing/provider-routing-engine'
import { requiresTravelDateForPackage, isValidTravelDate, resolveEffectiveTravelDate } from '@/lib/providers/travel-date-utils'
import { resolveEffectiveProviderRequirements } from '@/lib/providers/provider-requirements-resolver'
import { consumeQuoteAndCreateOrder } from '@/lib/pricing/purchase-quote-service'
import { publishOrderLifecycleEvent, ORDER_LIFECYCLE_EVENTS } from './lifecycle-publisher'
import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'
import { resolvePackageBacking } from './package-backing-resolver'
import { enqueueJob } from '@/lib/services/jobs/queue'
import type { CreateOrderParams, CreateOrderResult } from './create-order'
import { enforcePurchasePriceGuard } from '@/lib/pricing/purchase-price-guard'

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
  /** Internal: enqueue dispatch and return PROCESSING instead of executing inline. */
  _async?: boolean
}

/**
 * Serializable context that fully determines provider dispatch for a prepared
 * (order-created + wallet-reserved) purchase. Carried into the background job so
 * the worker can execute without re-resolving anything from the browser request.
 */
export interface PurchaseDispatchContext {
  orderId: string
  businessId: string
  userId: string
  providerId: string
  providerName: string
  planId: string
  quantity: number
  subscriber: { email: string; first_name?: string; last_name?: string }
  totalAmount: number
  displayName: string
  packageId: string
  currency: string
  customerId?: string
  rankedProviders: ProviderScore[]
  travelDate?: string
  providerPackageId?: string
  /** Maps each candidate providerId to its backing ProviderPackage id. */
  providerPackageByProviderId: Record<string, string>
  unitPrice: number
  correlationId?: string
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

    try {

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

    // ── Authoritative backing resolution (single source of truth) ─────────────
    // Resolution order (provider-neutral — never guesses a provider, never routes
    // the retail package id through a generic provider ranking):
    //   1. bound single ProviderPackage (pkg.providerPackageId)
    //   2. explicit multi-backing providerBindings (custom package)
    //   3. legacy denormalized providerId+providerPlanId → a UNIQUE matching
    //      ProviderPackage (compatibility only)
    //   4. otherwise → BACKING_NOT_CONFIGURED (fail safe)
    const backing = await resolvePackageBacking(pkg)
    let customBackings: Array<{ providerPackageId: string; providerId: string; providerName: string; priority: number }> | null = null
    let boundBacking: { providerPackageId: string; providerId: string; providerPlanId: string } | null = null

    if (backing.kind === 'BOUND') {
      boundBacking = backing.backing
      trace(correlationId, 'BACKING_RESOLUTION', 'SUCCESS', { providerPackageId: backing.backing.providerPackageId, providerId: backing.backing.providerId, providerPlanId: backing.backing.providerPlanId })
    } else if (backing.kind === 'CUSTOM') {
      customBackings = backing.backings
      trace(correlationId, 'BACKING_RESOLUTION', 'CUSTOM', { backingCount: backing.backings.length })
    } else if (backing.kind === 'UNAVAILABLE') {
      trace(correlationId, 'BACKING_RESOLUTION', 'FAILED', { internalCode: 'PACKAGE_UNAVAILABLE' })
      return this.fail('PACKAGE_UNAVAILABLE', 'This package is temporarily unavailable. Please select another package or try again later.', true)
    } else {
      trace(correlationId, 'BACKING_RESOLUTION', 'FAILED', { internalCode: 'BACKING_NOT_CONFIGURED' })
      return this.fail('BACKING_NOT_CONFIGURED', 'This package is not configured with a valid provider backing. Please contact support.', false)
    }

    // Step 4: Validate pricing availability using centralized readiness
    trace(correlationId, 'PURCHASE_READINESS', 'START')
    const backingPkgId = boundBacking?.providerPackageId ?? pkg.providerPackageId ?? null
    const readiness = getPackagePurchaseReadiness({
      pkg: { isActive: pkg.isActive, hiddenFromCatalog: pkg.hiddenFromCatalog, archivedAt: pkg.archivedAt, source: pkg.source, providerPackageId: backingPkgId },
      providerPkg: backingPkgId ? await prisma.providerPackage.findUnique({
        where: { id: backingPkgId },
        select: { costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true },
      }) : null,
      ...(customBackings ? { customBackingCount: customBackings.length, customSellingPrice: parseFloat(pkg.priceUSD.toString()) } : {}),
    })
    if (!readiness.ready) {
      trace(correlationId, 'PURCHASE_READINESS', 'FAILED', { internalCode: 'PACKAGE_UNAVAILABLE', reasonsCount: readiness.reasons.length })
      return this.fail('PACKAGE_UNAVAILABLE', 'This package is temporarily unavailable. Please select another package or try again later.', false)
    }
    trace(correlationId, 'PURCHASE_READINESS', 'SUCCESS')

    // Step 4b: Validate travel date requirement before any wallet hold.
    // Uses resolveEffectiveTravelDate to default to today for packages that
    // mandate a travel date (e.g. AirHub) for immediate purchases.
    let normalizedTravelDate = travelDate !== undefined && travelDate !== null && travelDate.trim() !== '' ? travelDate.trim() : undefined
    if (normalizedTravelDate !== undefined && !isValidTravelDate(normalizedTravelDate)) {
      return this.fail('TRAVEL_DATE_INVALID', `travelDate must be a valid date in YYYY-MM-DD format, got "${normalizedTravelDate}"`, false)
    }
    if (backingPkgId) {
      const travelPkg = await prisma.providerPackage.findUnique({
        where: { id: backingPkgId },
        select: {
          activationPolicy: true, travelDateRequirement: true, travelDateLeadDays: true, travelDateSource: true,
          provider: { select: { code: true, config: true, adapterStrategy: true } },
        },
      })
      const requirements = resolveEffectiveProviderRequirements({
        provider: { code: travelPkg?.provider?.code, adapterStrategy: travelPkg?.provider?.adapterStrategy, config: travelPkg?.provider?.config },
        providerPackage: {
          activationPolicy: travelPkg?.activationPolicy,
          travelDateRequirement: travelPkg?.travelDateRequirement,
          travelDateLeadDays: travelPkg?.travelDateLeadDays,
          travelDateSource: travelPkg?.travelDateSource,
        },
      })
      const resolved = resolveEffectiveTravelDate({
        requestedTravelDate: normalizedTravelDate,
        activationPolicy: requirements.activationPolicy,
        travelDateRequirement: requirements.travelDateRequirement,
        travelDateLeadDays: requirements.travelDateLeadDays,
      })

      if (resolved.error) {
        return this.fail('TRAVEL_DATE_REQUIRED', resolved.error, false)
      }
      normalizedTravelDate = resolved.resolvedDate
    }

    trace(correlationId, 'TRAVEL_DATE_RESOLVED', 'SUCCESS', {
      requested: travelDate || null,
      resolved: normalizedTravelDate || null,
      present: !!normalizedTravelDate,
    })

    // Step 4c: Price parity guard for BOUND packages.
    // Verifies retail priceUSD matches provider sellingPrice and active
    // snapshot before any wallet mutations or order creation.
    if (backingPkgId) {
      const priceGuard = await enforcePurchasePriceGuard({
        providerPackageId: backingPkgId,
        retailPriceUSD: parseFloat(pkg.priceUSD.toString()),
        retailLocalPrice: pkg.localPrice ? parseFloat(pkg.localPrice.toString()) : null,
      })
      if (!priceGuard.passed) {
        trace(correlationId, 'PRICE_GUARD', 'FAILED', { internalCode: 'PRICE_STALE', reason: priceGuard.reason })
        return this.fail('PRICE_STALE', 'Package pricing has been updated since this quote was generated. Please request a new quote.', false)
      }
      trace(correlationId, 'PRICE_GUARD', 'SUCCESS')
    }

    // Step 5: Validate business wallet
    let unitPrice = parseFloat(pkg.priceUSD.toString())
    let totalAmount = unitPrice * quantity
    if (parseFloat(business.walletBalance.toString()) < totalAmount) {
      trace(correlationId, 'WALLET_VALIDATION', 'FAILED', { internalCode: 'INSUFFICIENT_WALLET' })
      return this.fail('INSUFFICIENT_WALLET', `Wallet balance $${business.walletBalance} is insufficient for $${totalAmount}`, false)
    }

    // Step 5: Resolve the execution provider from the authoritative backing.
    // Backing resolution above guarantees a backing (bound or custom). Never
    // route the retail package id through a generic provider ranking.
    let providerId = boundBacking ? boundBacking.providerId : (customBackings ? customBackings[0].providerId : undefined)
    trace(correlationId, 'PROVIDER_ROUTING', providerId ? 'ASSIGNED' : 'ROUTING_REQUIRED', { providerId: providerId || 'null' })
    if (!providerId) {
      trace(correlationId, 'PROVIDER_ROUTING', 'FAILED', { internalCode: 'BACKING_NOT_CONFIGURED' })
      return this.fail('BACKING_NOT_CONFIGURED', 'This package is not configured with a valid provider backing. Please contact support.', false)
    }

    const provider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!provider) {
      trace(correlationId, 'PROVIDER_VALIDATION', 'FAILED', { internalCode: 'PROVIDER_NOT_FOUND' })
      return this.fail('PROVIDER_NOT_FOUND', 'Provider not found', false)
    }
    if (!isProviderOperational(provider.status)) {
      trace(correlationId, 'PROVIDER_VALIDATION', 'FAILED', { internalCode: 'PROVIDER_UNAVAILABLE', providerStatus: provider.status })
      return this.fail('PROVIDER_UNAVAILABLE', `Provider is ${provider.status}`, false)
    }

    // Step 6: Validate PURCHASE capability
    const caps = (provider.enabledCapabilities || DEFAULT_PROVIDER_CAPABILITIES[provider.code || ''] || []) as string[]
    if (!caps.includes('PURCHASE')) {
      trace(correlationId, 'PROVIDER_VALIDATION', 'FAILED', { internalCode: 'PROVIDER_NO_PURCHASE' })
      return this.fail('PROVIDER_NO_PURCHASE', 'Provider does not support purchases', false)
    }

    // Step 7: Validate provider balance (if BALANCE capability)
    // Cache-only: the hot path must never block on live provider HTTP. A stale
    // or missing snapshot skips the check — purchase safety is still enforced
    // by the reserved wallet and the provider's own rejection at dispatch.
    if (caps.includes('BALANCE')) {
      const balanceResult = await getProviderBalance(provider.id, { forceRefresh: false, cacheOnly: true })
      if (balanceResult.success && balanceResult.supported && balanceResult.balance != null) {
        if (balanceResult.balance < totalAmount) {
          trace(correlationId, 'PROVIDER_VALIDATION', 'FAILED', { internalCode: 'PROVIDER_LOW_BALANCE' })
          return this.fail('PROVIDER_LOW_BALANCE', `Provider balance ${(balanceResult.currency || '')} ${balanceResult.balance} is insufficient for order total $${totalAmount}`, true)
        }
      }
    }

    // Step 8: Dedup
    trace(correlationId, 'ORDER_CREATION', 'START')
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
      trace(correlationId, 'QUOTE_FORWARDING', 'SUCCESS', { quotePresent: true, quantity })

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
      trace(correlationId, 'QUOTE_FORWARDING', 'FAILED', { quotePresent: false, quotesRequired: true })
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

    // Provider-owned plan id comes from the authoritative backing when bound —
    // never the local retail package id (which must not go upstream).
    const planId = boundBacking ? boundBacking.providerPlanId : (pkg.providerPlanId || pkg.id)

    // Build the fully-resolved dispatch context (single source of truth for the
    // provider dispatch — serializable so it can run in a background job).
    const nameParts = (customer?.name || 'Business Order').trim().split(/\s+/)
    const subscriber = { email: customer?.email || '', first_name: nameParts[0] || '', last_name: nameParts.slice(1).join(' ') || undefined }

    let rankedProviders: ProviderScore[]
    let currentProviderId: string
    let currentProviderName: string
    if (customBackings) {
      // Priority-ordered backing providers drive the routing/failover list.
      rankedProviders = customBackings.map((b, i) => ({
        providerId: b.providerId, providerName: b.providerName, providerCode: '', score: 100 - i,
        breakdown: { health: 100, price: 100, latency: 100, balance: 100, successRate: 100, priority: 100 },
      }))
      currentProviderId = customBackings[0].providerId
      currentProviderName = customBackings[0].providerName
    } else if (boundBacking) {
      // Single bound backing → exactly one provider. No cross-provider failover.
      rankedProviders = []
      currentProviderId = boundBacking.providerId
      currentProviderName = provider.name
    } else {
      // Unreachable: backing resolution guarantees a bound or custom backing.
      rankedProviders = []
      currentProviderId = provider.id
      currentProviderName = provider.name
    }

    const providerPackageByProviderId: Record<string, string> = {}
    if (boundBacking) providerPackageByProviderId[boundBacking.providerId] = boundBacking.providerPackageId
    if (customBackings) for (const b of customBackings) providerPackageByProviderId[b.providerId] = b.providerPackageId

    const ctx: PurchaseDispatchContext = {
      orderId, businessId, userId, providerId: currentProviderId, providerName: currentProviderName,
      planId, quantity, subscriber, totalAmount, displayName, packageId: pkg.id,
      currency: pkg.currency || 'USD', customerId, rankedProviders,
      travelDate: normalizedTravelDate,
      providerPackageId: boundBacking ? boundBacking.providerPackageId : (pkg.providerPackageId || undefined),
      providerPackageByProviderId, unitPrice, correlationId,
    }

    // Async mode: enqueue the dispatch and return PROCESSING immediately — the
    // browser/API must not wait for the provider activation HTTP. The existing
    // background job system executes the dispatch.
    if (request._async) {
      try {
        // runAt = now: the in-process worker loop claims within ~1s. The small
        // historical +500ms offset bought nothing — claims are atomic anyway.
        await enqueueJob('PROVIDER_OPERATION' as any, { operation: 'purchase', ...ctx }, new Date(), 5)
      } catch (e: any) {
        // Enqueue failed AFTER reserve — never leave a paid/reserved order stranded.
        await releaseReservedFunds(orderId, businessId, totalAmount)
        await failOrder(orderId, `Purchase dispatch enqueue failed: ${e?.message || 'unknown'}`)
        await this.writeAudit(businessId, userId, ctx.providerId, pkg.id, displayName, totalAmount, 'FAILED', 'dispatch enqueue failed')
        return this.fail('DISPATCH_ENQUEUE_FAILED', 'Unable to start purchase processing. Please try again.', true)
      }
      trace(correlationId, 'PROVIDER_DISPATCH', 'ENQUEUED', { orderId })
      return { success: true, orderId, status: 'PROCESSING', unitCost: unitPrice, totalCost: totalAmount, quantity, currency: pkg.currency || 'USD' }
    }

    return await this.runDispatch(ctx)
    } catch (e: any) {
      console.error(`[BUSINESS_PURCHASE_TRACE] correlationId=${correlationId} stage=UNCAUGHT_EXCEPTION name=${e.name} message=${e.message} stack=${e.stack?.substring(0, 300)}`)
      trace(correlationId, 'ACTION_RESULT', 'FAILED', { publicCode: 'purchase_failed', exception: e.name })
      return this.fail('INTERNAL_ERROR', e.message || 'Internal error', false)
    }
  }

  /**
   * Execute provider dispatch for a prepared purchase (order created + wallet
   * reserved). Runs inline (sync) or in a background job. Provider-neutral.
   */
  async runDispatch(ctx: PurchaseDispatchContext): Promise<PurchaseResult> {
    const { orderId, businessId, userId, providerId, providerName, planId, quantity, subscriber, totalAmount, displayName, packageId, currency, customerId, rankedProviders, travelDate, unitPrice, correlationId } = ctx

    // ── Durable exactly-once dispatch guard ──────────────────────────────
    // Atomically claim the order for dispatch: only ONE worker/process can
    // transition PAYMENT_RESERVED → PENDING_PROVIDER. Any concurrent/duplicate
    // executor sees count===0 and skips — the provider mutation can never fire
    // twice for the same order. This is the guard immediately before mutation,
    // independent of queue deduplication.
    const claim = await prisma.eSIMPurchase.updateMany({
      where: { id: orderId, status: 'PAYMENT_RESERVED' },
      data: { status: 'PENDING_PROVIDER' },
    })
    if (claim.count === 0) {
      const current = await prisma.eSIMPurchase.findUnique({ where: { id: orderId }, select: { status: true, esims: { select: { id: true } } } })
      if (current && (current.status === 'FULFILLED' || (current.esims && current.esims.length > 0))) {
        return { success: true, orderId, status: 'FULFILLED' }
      }
      // Resume path: a previous executor crashed between claiming the order
      // (PAYMENT_RESERVED → PENDING_PROVIDER) and recording the first provider
      // attempt. executeProviderAttempt writes the attempt row BEFORE any
      // provider HTTP, so PENDING_PROVIDER with zero attempts provably means
      // no mutation was dispatched — safe to resume. Any attempt row ⇒ the
      // outcome is owned by that attempt (poll/reconciliation), never re-dispatch.
      let resumed = false
      if (current?.status === 'PENDING_PROVIDER') {
        const attemptCount = await prisma.providerAttempt.count({ where: { orderId, source: 'PURCHASE' } })
        resumed = attemptCount === 0
      }
      if (!resumed) {
        // Already dispatching, reconciling, or failed — do NOT re-dispatch.
        trace(correlationId, 'PROVIDER_DISPATCH', 'ALREADY_CLAIMED', { orderId, orderStatus: current?.status })
        return { success: false, orderId, status: current?.status || 'PENDING_PROVIDER', errorCode: 'ALREADY_DISPATCHING', message: 'This order is already being dispatched', retryable: false }
      }
      trace(correlationId, 'PROVIDER_DISPATCH', 'RESUMED', { orderId })
    }

    let currentProviderId = providerId
    let currentProviderName = providerName
    const attemptedIds: string[] = [currentProviderId]

    for (let attemptNum = 1; attemptNum <= 3; attemptNum++) {
      const attemptProviderPackageId = ctx.providerPackageByProviderId[currentProviderId] ?? ctx.providerPackageId

      const result = await executeProviderAttempt({
        orderId, businessId, providerId: currentProviderId, providerName: currentProviderName,
        planId, quantity, subscriber, totalAmount, displayName, packageId,
        packageSnapshot: {}, pkg: { id: packageId, dataGB: 0, validityDays: 0, currency },
        customerId, rankedProviders, policy: 'PREFERRED',
        travelDate, providerPackageId: attemptProviderPackageId,
      })

      if (result.success && (result.status === 'SUCCEEDED' || result.status === 'ALREADY_COMPLETE')) {
        trace(correlationId, 'PROVIDER_ATTEMPT', 'SUCCESS', { providerName: currentProviderName, attemptNum })
        const savedEsims = await prisma.eSIM.findMany({ where: { purchaseId: orderId }, select: { id: true, iccid: true, imsi: true, activationCode: true, status: true, qrCodeUrl: true } })
        return { success: true, orderId, status: 'FULFILLED', provider: currentProviderName, providerReference: result.providerReference, iccid: result.iccids?.[0], qrCode: result.qrCode, unitCost: unitPrice, totalCost: totalAmount, quantity, currency, esims: savedEsims.map(e => ({ id: e.id, iccid: e.iccid, imsi: e.imsi, activationCode: e.activationCode, status: e.status, qrCodeUrl: e.qrCodeUrl })) }
      }

      if (result.success && result.status === 'PROCESSING') {
        return { success: true, orderId, status: 'PROCESSING', provider: currentProviderName, providerReference: result.providerReference, unitCost: unitPrice, totalCost: totalAmount, quantity, currency }
      }

      // Ambiguous provider outcome: the mutating activation may have completed.
      // Do NOT fail over, do NOT release reserved funds, do NOT mark definitively
      // failed. Move to a reconciliation state for review/re-read.
      if (result.status === 'AMBIGUOUS') {
        await transitionOrder(orderId, 'PROVIDER_RECONCILIATION', { reason: result.errorMessage || 'Provider outcome ambiguous (timeout)' })
        await createTimelineEvent(orderId, { eventType: 'PROVIDER_RECONCILIATION', message: `Provider activation outcome ambiguous for ${currentProviderName}: ${result.errorMessage || 'timeout'}`, metadata: { providerId: currentProviderId, ambiguous: true } })
        await this.writeAudit(businessId, userId, currentProviderId, packageId, displayName, totalAmount, 'RECONCILIATION_REQUIRED', result.errorMessage)
        trace(correlationId, 'PROVIDER_ATTEMPT', 'AMBIGUOUS', { providerName: currentProviderName, attemptNum })
        return { success: false, orderId, status: 'PROVIDER_RECONCILIATION', errorCode: 'AMBIGUOUS_PROVIDER_OUTCOME', message: 'This purchase requires reconciliation — the provider may have completed it. We are verifying the outcome.', retryable: false }
      }

      // Not retryable — fail immediately
      if (result.status !== 'RETRYABLE') {
        await releaseReservedFunds(orderId, businessId, totalAmount)
        await failOrder(orderId, result.errorMessage || 'Provider activation failed')
        await this.writeAudit(businessId, userId, currentProviderId, packageId, displayName, totalAmount, 'FAILED', result.errorMessage)
        return this.fail(result.errorCode || 'PROVIDER_FAILED', result.errorMessage || 'Provider activation failed', false)
      }

      // Try failover
      const next = await tryFailoverAfterAttempt({
        orderId, businessId, providerId: currentProviderId, providerName: currentProviderName,
        planId, quantity, subscriber, totalAmount, displayName, packageId,
        packageSnapshot: {}, pkg: { id: packageId, dataGB: 0, validityDays: 0, currency },
        customerId, rankedProviders,
        currentProviderId, attemptedIds, travelDate,
      })

      if (!next?.shouldContinue) break
      currentProviderId = next.providerId!
      currentProviderName = next.providerName!
      attemptedIds.push(currentProviderId)
    }

    // Exhausted
    await releaseReservedFunds(orderId, businessId, totalAmount)
    await failOrder(orderId, 'All provider attempts exhausted')
    await this.writeAudit(businessId, userId, providerId, packageId, displayName, totalAmount, 'FAILED', 'All attempts exhausted')
    return this.fail('ALL_PROVIDERS_EXHAUSTED', 'All available providers failed', false)
  }

  /**
   * Enqueue-only entry point: validates, resolves the backing, creates the order,
   * reserves wallet funds, enqueues dispatch, and returns PROCESSING immediately.
   */
  async executePurchaseAsync(request: PurchaseRequest): Promise<PurchaseResult> {
    return this.executePurchase({ ...request, _async: true })
  }

  private fail(code: string, message: string, retryable: boolean): PurchaseResult {
    const safeMessage = this.mapToSafeClientError(message)
    console.log(`[PURCHASE_TRACE] traceId=orph step=FAIL code=${code} retryable=${retryable}`)
    return { success: false, errorCode: code, message: safeMessage, retryable }
  }

  private mapToSafeClientError(rawMessage: string): string {
    // Prefer code-based mapping. String fallback for legacy.
    if (rawMessage.startsWith('Unable to') || rawMessage.startsWith('This')) return rawMessage
    const lower = rawMessage.toLowerCase()
    // Code-based classification — produce stable safe messages
    if (lower.includes('validation') || lower.includes('invalid') || lower.includes('mandatory') || lower.includes('required')) return 'Unable to complete this purchase right now. Please try again.'
    if (lower.includes('traveldate') || lower.includes('travel date')) return 'Unable to complete this purchase right now. Please try again.'
    if (lower.includes('balance') && (lower.includes('na') || lower.includes('unavailable') || lower.includes('insufficient'))) return 'Unable to complete this purchase right now. Please try again.'
    if (lower.includes('auth') || lower.includes('unauthorized') || lower.includes('token') || lower.includes('credential')) return 'Unable to complete this purchase right now. Please try again.'
    if (lower.includes('not found') || lower.includes('bundle')) return 'Unable to complete this purchase right now. Please try again.'
    if (lower.includes('timeout') || lower.includes('network') || lower.includes('connection')) return 'Unable to complete this purchase right now. Please try again.'
    // Allow through: Wallet, Provider routing, Quote messages (already safe)
    if (rawMessage.startsWith('Wallet') || rawMessage.startsWith('Provider') || rawMessage.startsWith('No eligible') || rawMessage.startsWith('All available')) return rawMessage
    return 'Unable to complete this purchase right now. Please try again.'
  }

  private async writeAudit(businessId: string, userId: string, providerId: string, packageId: string, packageName: string, amount: number, status: string, reason?: string) {
    try {
      await prisma.auditLog.create({
        data: { userId, action: `PURCHASE_${status}`, entity: 'Purchase', entityId: providerId, details: JSON.stringify({ businessId, packageId, packageName, amount, status, reason: reason || null, timestamp: new Date().toISOString() }) },
      })
    } catch {}
  }
}
