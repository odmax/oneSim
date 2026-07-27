import { prisma } from '@/lib/prisma'
import { isProviderOperational } from '@/lib/providers/adapter-manager'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'
import { createTimelineEvent, transitionOrder, failOrder } from './order-state-machine'
import { reserveWalletFunds, captureReservedFunds, releaseReservedFunds } from './wallet-actions'
import { getProviderBalance } from '@/lib/services/providers/provider-balance'
import { resolvePackageIdentifier } from '@/lib/packages/resolve-package'
import type { CreateOrderParams, CreateOrderResult } from './create-order'

const DUP_WINDOW_MS = 30_000

export interface PurchaseRequest {
  businessId: string
  userId: string
  packageId?: string
  sku?: string
  packageCode?: string
  quantity: number
  customer?: {
    name: string
    email: string
    phone?: string
    country?: string
    externalId?: string
  }
  callbackUrl?: string
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
    const { businessId, userId, packageId, sku, packageCode, quantity, customer, callbackUrl } = request

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

    // Step 4: Validate business wallet
    const unitPrice = parseFloat(pkg.priceUSD.toString())
    const totalAmount = unitPrice * quantity
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

    // Step 10: Create order
    let orderId: string
    try {
      const order = await prisma.eSIMPurchase.create({ data: { businessId, userId, packageId: pkg.id, quantity, totalAmount, status: 'CREATED', callbackUrl: callbackUrl || null, packageSnapshot: packageSnapshot as any, packageName: displayName, packageDataGB: pkg.dataGB, packageValidityDays: pkg.validityDays, packageUnitPrice: unitPrice, packageCurrency: pkg.currency || 'USD' } })
      orderId = order.id
    } catch (e: any) { return this.fail('ORDER_CREATE_FAILED', `Failed to create order: ${e.message}`, false) }

    await createTimelineEvent(orderId, { eventType: 'ORDER_CREATED', message: `Purchase started: ${quantity}x ${displayName} via ${provider.name}` })
    await transitionOrder(orderId, 'CREATED')

    // Step 11: Reserve wallet
    const reserve = await reserveWalletFunds(orderId, businessId, totalAmount)
    if (!reserve.success) {
      await failOrder(orderId, `Wallet reserve failed: ${reserve.error}`)
      await this.writeAudit(businessId, userId, providerId, pkg.id, displayName, totalAmount, 'FAILED', reserve.error)
      return this.fail('WALLET_RESERVE_FAILED', reserve.error || 'Wallet reserve failed', true)
    }
    await transitionOrder(orderId, 'PAYMENT_RESERVED')
    await createTimelineEvent(orderId, { eventType: 'WALLET_RESERVED', message: `Reserved $${totalAmount}` })

    const planId = pkg.providerPlanId || pkg.id

    // Step 13-14: Dispatch to provider with failover
    const nameParts = (customer?.name || 'Business Order').trim().split(/\s+/)
    const subscriber = { email: customer?.email || '', first_name: nameParts[0] || '', last_name: nameParts.slice(1).join(' ') || undefined }

    let currentProviderId = provider.id
    let currentProviderName = provider.name
    let currentProvider = provider
    const attemptedIds = new Set<string>()
    attemptedIds.add(currentProviderId)

    const { classifyRetry } = await import('@/lib/services/routing/provider-failover-engine')
    const { ProviderRoutingEngine } = await import('@/lib/services/routing/provider-routing-engine')
    const routingEngine = new ProviderRoutingEngine()
    const rankedProviders = await routingEngine.getRankedProviders({ packageId: pkg.id, quantity })
    const attemptHistory: Array<{ provider: string; errorCode?: string; errorMessage?: string }> = []

    const { getAdapterForType } = await import('@/lib/providers/adapter-manager')

    for (let attempt = 1; attempt <= 3; attempt++) {
      // Update order with current provider
      await prisma.eSIMPurchase.update({ where: { id: orderId }, data: { providerId: currentProviderId } })
      await createTimelineEvent(orderId, { eventType: 'PROVIDER_DISPATCH', message: `Attempt ${attempt}: Dispatching to ${currentProviderName}` })

      // Resolve adapter for current provider
      const currentAdapter = await getAdapterForType(currentProvider.type, {
        apiBaseUrl: currentProvider.apiBaseUrl, apiToken: currentProvider.apiToken,
        providerId: currentProvider.id, environment: currentProvider.environment, authUrl: currentProvider.authUrl,
      })

      // Validate config
      if (currentAdapter.validatePurchase) {
        const v = await currentAdapter.validatePurchase({ planId, quantity, subscriber })
        if (!v.valid) {
          attemptHistory.push({ provider: currentProvider.id, errorCode: 'PROVIDER_CONFIG', errorMessage: v.reason })
          // Try next provider
          const next = rankedProviders.find(p => !attemptedIds.has(p.providerId))
          if (!next) break
          currentProviderId = next.providerId
          currentProviderName = next.providerName
          currentProvider = await prisma.provider.findUnique({ where: { id: next.providerId } }) || currentProvider
          attemptedIds.add(currentProviderId)
          continue
        }
      }

      // Activate
      try {
        const result = await currentAdapter.activateESIM({ planId, quantity, subscriber, activationType: 'ACTIVATE_NOW', externalId: businessId })

        if (!result.success || !result.data) {
          const err = result.error
          const cls = classifyRetry(err)
          attemptHistory.push({ provider: currentProviderId, errorCode: err?.code, errorMessage: err?.message })

          if (cls !== 'RETRYABLE' || attempt >= 3) {
            await releaseReservedFunds(orderId, businessId, totalAmount)
            await failOrder(orderId, err?.message || 'Provider activation failed')
            await this.writeAudit(businessId, userId, currentProviderId, pkg.id, displayName, totalAmount, 'FAILED', err?.message)
            return this.fail(err?.code || 'PROVIDER_FAILED', err?.message || 'Provider activation failed', err?.details?.retryable || false)
          }

          // Failover: try next provider
          const next = rankedProviders.find(p => !attemptedIds.has(p.providerId))
          if (!next) {
            await releaseReservedFunds(orderId, businessId, totalAmount)
            await failOrder(orderId, 'All providers exhausted')
            await this.writeAudit(businessId, userId, currentProviderId, pkg.id, displayName, totalAmount, 'FAILED', 'All providers exhausted')
            return this.fail('ALL_PROVIDERS_EXHAUSTED', 'All available providers failed', false)
          }

          createTimelineEvent(orderId, { eventType: 'PROVIDER_FAILOVER', message: `Failover: ${currentProviderName} → ${next.providerName} (${err?.code || 'error'})` })
          currentProviderId = next.providerId
          currentProviderName = next.providerName
          currentProvider = await prisma.provider.findUnique({ where: { id: next.providerId } }) || currentProvider
          attemptedIds.add(currentProviderId)
          continue
        }

        // Success — same flow as before
        const data = result.data
        const providerOrderId = data.activationId || (data as any).providerOrderId || undefined

        const hasIccids = data.iccids && data.iccids.length > 0
        const isAsync = !hasIccids && (data.status === 'PENDING' || data.status === 'PROCESSING' || data.status === 'QUEUED' || data.status === 'PENDING_ACTIVATION')

        if (isAsync && providerOrderId) {
          const { ProviderJobEngine } = await import('@/lib/services/jobs/provider-job-engine')
          await ProviderJobEngine.createJob({ orderId, businessId, providerId: currentProviderId, providerRef: providerOrderId, totalAmount, operation: 'activation' })
          await prisma.eSIMPurchase.update({ where: { id: orderId }, data: { providerId: currentProviderId, providerReservationId: providerOrderId, providerStatus: 'PENDING' } })
          await transitionOrder(orderId, 'PROCESSING')
          await createTimelineEvent(orderId, { eventType: 'PROVIDER_ACCEPTED', message: `Async job queued — ${currentProviderName} ref: ${providerOrderId}` })
          await this.writeAudit(businessId, userId, currentProviderId, pkg.id, displayName, totalAmount, 'ACCEPTED', `Async job for ${providerOrderId}`)
          return { success: true, orderId, status: 'PROCESSING', provider: currentProviderName, providerReference: providerOrderId, unitCost: unitPrice, totalCost: totalAmount, quantity, currency: pkg.currency || 'USD' }
        }

        // Map eSIMs and complete
        const extractString = (raw: any): string | null => raw == null ? null : String(raw)
        const esimIccids: string[] = []
        for (let i = 0; i < quantity; i++) {
          esimIccids.push(extractString(data.iccids?.[i]) || extractString(data.imsis?.[i])?.replace(/[^0-9]/g, '') || '')
        }
        if (esimIccids.some(e => !e)) {
          await releaseReservedFunds(orderId, businessId, totalAmount)
          await failOrder(orderId, 'Provider returned incomplete ICCID data')
          return this.fail('INCOMPLETE_RESPONSE', 'Provider returned incomplete data', false)
        }

        // Save eSIMs
        for (let i = 0; i < quantity; i++) {
          await prisma.eSIM.create({ data: { purchaseId: orderId, customerId: customerId || null, iccid: esimIccids[i], imsi: extractString(data.imsis?.[i]), activationCode: extractString(data.activationCodes?.[i]) || extractString(data.qrCodeUrl), qrCodeUrl: extractString(data.qrCodeUrl) || undefined, status: 'PENDING_ACTIVATION', providerActivationId: providerOrderId || null, providerStatus: 'PENDING', expiresAt: new Date(Date.now() + pkg.validityDays * 24 * 60 * 60 * 1000), packageSnapshot: packageSnapshot as any, packageName: displayName, packageDataGB: pkg.dataGB, packageValidityDays: pkg.validityDays } })
        }

        await captureReservedFunds(orderId, businessId, totalAmount)
        await prisma.eSIMPurchase.update({ where: { id: orderId }, data: { providerFulfillId: providerOrderId || null, providerStatus: data.status || 'ACTIVE' } })
        await transitionOrder(orderId, 'FULFILLED')
        await createTimelineEvent(orderId, { eventType: 'PURCHASE_COMPLETE', message: `Fulfilled via ${currentProviderName} (attempt ${attempt})` })
        await this.writeAudit(businessId, userId, currentProviderId, pkg.id, displayName, totalAmount, 'COMPLETED')

        const savedEsims = await prisma.eSIM.findMany({ where: { purchaseId: orderId }, select: { id: true, iccid: true, imsi: true, activationCode: true, status: true, qrCodeUrl: true } })
        return { success: true, orderId, status: 'FULFILLED', provider: currentProviderName || provider.name, providerReference: providerOrderId || undefined, iccid: esimIccids[0], qrCode: extractString(data.qrCodeUrl) || undefined, activationCode: extractString(data.activationCodes?.[0]) || undefined, unitCost: unitPrice, totalCost: totalAmount, quantity, currency: pkg.currency || 'USD', esims: savedEsims.map(e => ({ id: e.id, iccid: e.iccid, imsi: e.imsi, activationCode: e.activationCode, status: e.status, qrCodeUrl: e.qrCodeUrl })) }
      } catch (e: any) {
        attemptHistory.push({ provider: currentProviderId, errorCode: 'PROVIDER_ERROR', errorMessage: e.message })
        const cls = classifyRetry({ code: 'PROVIDER_ERROR', message: e.message })
        if (cls !== 'RETRYABLE' || attempt >= 3) {
          await releaseReservedFunds(orderId, businessId, totalAmount)
          await failOrder(orderId, `Provider error: ${e.message}`)
          await this.writeAudit(businessId, userId, currentProviderId, pkg.id, displayName, totalAmount, 'FAILED', e.message)
          return this.fail('PROVIDER_ERROR', `Provider error: ${e.message}`, true)
        }
        const next = rankedProviders.find(p => !attemptedIds.has(p.providerId))
        if (!next) {
          await releaseReservedFunds(orderId, businessId, totalAmount)
          await failOrder(orderId, 'All providers exhausted after error')
          return this.fail('ALL_PROVIDERS_EXHAUSTED', 'All available providers failed', false)
        }
        createTimelineEvent(orderId, { eventType: 'PROVIDER_FAILOVER', message: `Failover: ${currentProviderName} → ${next.providerName} (error)` })
        currentProviderId = next.providerId
        currentProviderName = next.providerName
        currentProvider = await prisma.provider.findUnique({ where: { id: next.providerId } }) || currentProvider
        attemptedIds.add(currentProviderId)
      }
    }

    // Exhausted all retries
    await releaseReservedFunds(orderId, businessId, totalAmount)
    await failOrder(orderId, 'All provider attempts exhausted')
    await this.writeAudit(businessId, userId, provider.id, pkg.id, displayName, totalAmount, 'FAILED', 'All attempts exhausted: ' + JSON.stringify(attemptHistory))
    return this.fail('ALL_PROVIDERS_EXHAUSTED', 'All available providers failed', false)
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
