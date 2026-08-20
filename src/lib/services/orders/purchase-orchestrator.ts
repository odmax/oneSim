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
import { resolveCustomPackageBackings } from '@/lib/services/custom-package/custom-package'
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
    let customBackings: Array<{ providerPackageId: string; providerId: string; providerName: string; priority: number }> | null = null
    let boundBacking: { providerPackageId: string; providerId: string; providerPlanId: string } | null = null

    if (pkg.providerPackageId) {
      const bb = await prisma.providerPackage.findUnique({
        where: { id: pkg.providerPackageId },
        select: { id: true, providerId: true, providerPlanId: true, isAvailable: true },
      })
      if (!bb || bb.isAvailable === false) {
        trace(correlationId, 'BACKING_RESOLUTION', 'FAILED', { internalCode: 'PACKAGE_UNAVAILABLE', providerPackageId: pkg.providerPackageId })
        return this.fail('PACKAGE_UNAVAILABLE', 'This package is temporarily unavailable. Please select another package or try again later.', true)
      }
      boundBacking = { providerPackageId: bb.id, providerId: bb.providerId, providerPlanId: bb.providerPlanId }
      trace(correlationId, 'BACKING_RESOLUTION', 'SUCCESS', { providerPackageId: bb.id, providerId: bb.providerId, providerPlanId: bb.providerPlanId })
    } else {
      customBackings = await resolveCustomPackageBackings(pkg.id).catch(() => [])
      if (customBackings.length === 0) {
        // Legacy compatibility: a sellable package with no bound ProviderPackage
        // and no bindings may carry denormalized providerId+providerPlanId. Resolve
        // ONLY a unique matching ProviderPackage; anything else fails safe.
        if (pkg.providerId && pkg.providerPlanId) {
          const legacy = await prisma.providerPackage.findMany({
            where: { providerId: pkg.providerId, providerPlanId: pkg.providerPlanId, isAvailable: true },
            select: { id: true, providerId: true, providerPlanId: true },
          })
          if (legacy.length === 1) {
            boundBacking = { providerPackageId: legacy[0].id, providerId: legacy[0].providerId, providerPlanId: legacy[0].providerPlanId }
            // Not a multi-backing custom package — clear so the bound path drives
            // readiness/dispatch (an empty [] is truthy and would wrongly select the
            // custom multi-backing branch).
            customBackings = null
            trace(correlationId, 'BACKING_RESOLUTION', 'LEGACY_UNIQUE', { providerPackageId: legacy[0].id, providerId: legacy[0].providerId, providerPlanId: legacy[0].providerPlanId })
          } else {
            trace(correlationId, 'BACKING_RESOLUTION', 'FAILED', { internalCode: 'BACKING_NOT_CONFIGURED', matchCount: legacy.length })
            return this.fail('BACKING_NOT_CONFIGURED', 'This package is not configured with a valid provider backing. Please contact support.', false)
          }
        } else {
          trace(correlationId, 'BACKING_RESOLUTION', 'FAILED', { internalCode: 'BACKING_NOT_CONFIGURED' })
          return this.fail('BACKING_NOT_CONFIGURED', 'This package is not configured with a valid provider backing. Please contact support.', false)
        }
      }
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
    if (caps.includes('BALANCE')) {
      const balanceResult = await getProviderBalance(provider.id, { forceRefresh: false })
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

    // Step 13-14: Dispatch to provider with failover via shared service.
    // Custom retail packages (one retail → many backing ProviderPackages) are
    // resolved provider-neutrally into the SAME routing/failover flow — the
    // connectors receive only their own ProviderPackage/providerPlanId.
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
      // Single bound backing → exactly one provider. No cross-provider failover:
      // the backing (and its provider-owned plan id) is the only execution path.
      rankedProviders = []
      currentProviderId = boundBacking.providerId
      currentProviderName = provider.name
    } else {
      // Unreachable: backing resolution guarantees a bound or custom backing.
      // Defensive fallback — no provider ranking of the retail package id.
      rankedProviders = []
      currentProviderId = provider.id
      currentProviderName = provider.name
    }

    const attemptedIds: string[] = []
    attemptedIds.push(currentProviderId)

    for (let attemptNum = 1; attemptNum <= 3; attemptNum++) {
      // The backing ProviderPackage bound to the CURRENT provider (ownership
      // guard derives the provider plan id from it). Null for unbound packages.
      const attemptProviderPackageId = customBackings
        ? (customBackings.find(b => b.providerId === currentProviderId)?.providerPackageId ?? undefined)
        : boundBacking
          ? boundBacking.providerPackageId
          : (pkg.providerPackageId || undefined)

      const result = await executeProviderAttempt({
        orderId, businessId, providerId: currentProviderId, providerName: currentProviderName,
        planId, quantity, subscriber, totalAmount, displayName, packageId: pkg.id,
        packageSnapshot, pkg, customerId, rankedProviders, policy: 'PREFERRED',
        travelDate: normalizedTravelDate,
        providerPackageId: attemptProviderPackageId,
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
    } catch (e: any) {
      console.error(`[BUSINESS_PURCHASE_TRACE] correlationId=${correlationId} stage=UNCAUGHT_EXCEPTION name=${e.name} message=${e.message} stack=${e.stack?.substring(0, 300)}`)
      trace(correlationId, 'ACTION_RESULT', 'FAILED', { publicCode: 'purchase_failed', exception: e.name })
      return this.fail('INTERNAL_ERROR', e.message || 'Internal error', false)
    }
  }

  private async buildActivationInput(orderId: string, businessId: string, providerId: string, provider: any, planId: string, quantity: number, subscriber: any, totalAmount: number, displayName: string, pkg: any, packageSnapshot: any, customerId: any, rankedProviders: any) {
    return { orderId, businessId, providerId, providerName: provider.name, planId, quantity, subscriber, totalAmount, displayName, packageId: pkg.id, packageSnapshot, pkg, customerId, rankedProviders }
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
