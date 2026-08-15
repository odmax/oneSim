import { prisma } from '@/lib/prisma'
import { decryptToken } from '@/lib/encryption'
import { recordHealthEvent } from '@/lib/services/providers/health-monitor'
import type { IProviderConnector, ConnectorResult, ConnectorPlan, DiagnosticInfo, ActivateESIMParams, ActivateESIMResult, UsageResult, StatusResult, RateResult, TopUpESIMParams, TopUpESIMResult, TokenState, EsimLifecycleResult, ConnectorCapabilities, ConnectorAuthProfile, InstallationLookupInput, InstallationLookupResult } from './connector-interface'
import { SEAMLESS_ENDPOINTS, buildSeamlessUrl, type SeamlessEndpoint } from './telna-seamless-endpoints'
import type { SeamlessProductOffering, SeamlessOrder, SeamlessSubscription, SeamlessQRCode, SeamlessUsage, SeamlessOSApiResponse, SeamlessOrderState, SeamlessSubscriptionState } from './telna-seamless-types'
import { maskIccid } from '../mappers/ibasis-sim-mapper'

interface SeamlessConfig {
  apiBaseUrl: string
  apiKey: string
  environment: string
  timeoutMs: number
  maxRetries: number
  backoffMs: number
}

interface SeamlessRequestResult {
  success: boolean
  status?: number
  data?: any
  error?: { code: string; message: string; details?: any }
  latencyMs?: number
}

function generateCorrelationId(): string {
  return `sls-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
}

function mapOrderState(state: string): string {
  const s = (state || '').toUpperCase()
  switch (s) {
    case 'PENDING':
    case 'PENDING_PAYMENT':
    case 'SUBMITTED':
    case 'PENDING_APPROVAL':
    case 'PROCESSING':
      return 'PENDING_ACTIVATION'
    case 'COMPLETED':
      return 'PENDING_ACTIVATION'
    case 'CANCELLED':
    case 'EXPIRED':
    case 'FAILED':
      return 'FAILED'
    default:
      return 'PENDING_ACTIVATION'
  }
}

function mapSubscriptionState(state: string): string {
  const s = (state || '').toUpperCase()
  switch (s) {
    case 'PENDING':
      return 'PENDING_ACTIVATION'
    case 'ACTIVE':
      return 'ACTIVE'
    case 'CANCELLED':
      return 'INACTIVE'
    default:
      return 'PENDING_ACTIVATION'
  }
}

function extractIccid(sub: SeamlessSubscription): string | null {
  if (sub.iccid) return sub.iccid
  if (sub.icc) return sub.icc
  if (sub.sim?.iccid) return sub.sim.iccid
  return null
}

export class TelnaSeamlessConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string = 'Telna SeamlessOS'
  private cachedApiKey: string | null = null

  constructor(providerId: string) {
    this.providerId = providerId
  }

  private async loadConfig(): Promise<SeamlessConfig | null> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return null
    const cfg = (provider.config as any) || {}
    const apiKey = this.cachedApiKey || (provider.apiToken ? decryptToken(provider.apiToken) : null)
    if (!apiKey) return null
    return {
      apiBaseUrl: provider.apiBaseUrl || '',
      apiKey,
      environment: cfg.environment || provider.environment || 'production',
      timeoutMs: cfg.timeoutMs || 30000,
      maxRetries: cfg.maxRetries ?? 2,
      backoffMs: cfg.backoffMs ?? 1000,
    }
  }

  private async request(
    endpoint: SeamlessEndpoint,
    options: {
      method?: string
      pathParams?: Record<string, string>
      queryParams?: Record<string, string>
      body?: any
      idempotencyKey?: string
      timeoutMs?: number
      retries?: number
    } = {}
  ): Promise<SeamlessRequestResult> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured or API key missing' } }

    const url = buildSeamlessUrl(config.apiBaseUrl, endpoint, options.pathParams)
    const urlObj = new URL(url)
    if (options.queryParams) {
      for (const [k, v] of Object.entries(options.queryParams)) {
        urlObj.searchParams.set(k, v)
      }
    }
    const finalUrl = urlObj.toString()
    const method = options.method || 'GET'
    const correlationId = generateCorrelationId()
    const headers: Record<string, string> = {
      'X-API-Key': config.apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }
    if (options.idempotencyKey) headers['X-Idempotency-Key'] = options.idempotencyKey

    const maxAttempts = (options.retries ?? config.maxRetries) + 1
    let lastError: { code: string; message: string; details?: any } | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startMs = Date.now()
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs || config.timeoutMs)
        const response = await fetch(finalUrl, {
          method,
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const latencyMs = Date.now() - startMs
        const text = await response.text()
        let data: any
        try { data = JSON.parse(text) } catch {
          console.log(`[SEAMLESS_REQUEST] correlationId=${correlationId} endpoint=${endpoint} method=${method} status=${response.status} latencyMs=${latencyMs} parseError=true attempt=${attempt}`)
          return { success: false, status: response.status, error: { code: 'NON_JSON_RESPONSE', message: `SeamlessOS returned non-JSON (status ${response.status})` }, latencyMs }
        }

        console.log(`[SEAMLESS_REQUEST] correlationId=${correlationId} endpoint=${endpoint} method=${method} status=${response.status} latencyMs=${latencyMs} attempt=${attempt}`)

        if (response.ok) return { success: true, status: response.status, data, latencyMs }

        const errorCode = data.code || `HTTP_${response.status}`
        const errorMessage = data.message || `SeamlessOS returned ${response.status}`
        const isRetryable = response.status === 429 || response.status >= 500
        lastError = { code: errorCode, message: errorMessage, details: data.details }

        if (!isRetryable || attempt === maxAttempts) {
          return { success: false, status: response.status, error: lastError, latencyMs }
        }

        const retryDelay = config.backoffMs * Math.pow(2, attempt - 1)
        console.log(`[SEAMLESS_RETRY] correlationId=${correlationId} endpoint=${endpoint} attempt=${attempt} status=${response.status} retryInMs=${retryDelay}`)
        await new Promise(r => setTimeout(r, retryDelay))
      } catch (e: any) {
        const latencyMs = Date.now() - startMs
        const causeCode = e?.cause?.code || ''
        let msg: string
        if (e.name === 'AbortError') msg = `SeamlessOS request timed out after ${options.timeoutMs || config.timeoutMs}ms`
        else if (causeCode === 'ENOTFOUND') msg = 'SeamlessOS host not found (DNS failure)'
        else if (causeCode === 'ECONNREFUSED') msg = 'SeamlessOS refused the connection'
        else msg = `SeamlessOS request failed: ${e.message?.substring(0, 200)}`
        lastError = { code: 'NETWORK_ERROR', message: msg }
        console.log(`[SEAMLESS_ERROR] correlationId=${correlationId} endpoint=${endpoint} attempt=${attempt} latencyMs=${latencyMs} error=${msg}`)
        if (attempt === maxAttempts) return { success: false, error: lastError, latencyMs }
        const retryDelay = config.backoffMs * Math.pow(2, attempt - 1)
        await new Promise(r => setTimeout(r, retryDelay))
      }
    }

    return { success: false, error: lastError || { code: 'UNKNOWN', message: 'Request failed after all retries' } }
  }

  async authenticate(): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    return { success: false, error: { code: 'UNSUPPORTED', message: 'SeamlessOS uses static API key authentication — no OAuth flow' } }
  }

  /** SeamlessOS connector-declared internal capabilities. */
  capabilities: ConnectorCapabilities = {
    installationLookup: true,
    installationDataAtPurchase: true, // QR retrieved from GET /subscriptions/{id}/esim/qrcode at purchase
    installationLookupHistorical: true, // read-only GET /subscriptions/{id}/esim/qrcode by subscription id
    statusLookup: true,
    usageLookup: true,
    topUp: true,
    suspend: true,
    resume: true,
    balance: false,
    inventory: true,
    webhooks: false,
  }

  /** SeamlessOS uses a static X-API-Key — no runtime token exchange. */
  authProfile: ConnectorAuthProfile = {
    mode: 'STATIC_API_KEY',
    requiresRuntimeAuthentication: false,
    canVerifyCredentials: true,
    supportsRefresh: false,
    credentialField: 'apiToken',
    actionLabel: 'Save & Verify',
  }

  async getTokenState(): Promise<TokenState> {
    const config = await this.loadConfig()
    const tokenPresent = !!config?.apiKey
    return { tokenPresent, expiryPresent: false, expired: false, expiresSoon: false, tokenExpiry: null }
  }

  async ensureAuthenticated(): Promise<ConnectorResult<void>> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'SeamlessOS provider not configured or API key missing' } }
    return { success: true }
  }

  async refreshAuthentication(): Promise<boolean> {
    return false
  }

  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number; health?: Record<string, { ok: boolean; latencyMs?: number; error?: string }> }>> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured or API key missing' } }

    const health: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {}
    const checks = [
      { name: 'productOfferings', endpoint: 'productOfferings' as SeamlessEndpoint },
      { name: 'orders', endpoint: 'orders' as SeamlessEndpoint },
      { name: 'subscriptions', endpoint: 'subscriptions' as SeamlessEndpoint },
    ]

    let allOk = true
    for (const check of checks) {
      const result = await this.request(check.endpoint, { method: 'GET', queryParams: { limit: '1' }, timeoutMs: 10000, retries: 0 })
      health[check.name] = { ok: result.success, latencyMs: result.latencyMs, error: result.error?.message }
      if (!result.success) allOk = false
    }

    const overallLatency = Object.values(health).reduce((sum, h) => sum + (h.latencyMs || 0), 0)
    const message = allOk
      ? `Connected (${Object.keys(health).length} endpoints healthy, ${overallLatency}ms total)`
      : `Partial connectivity (${Object.values(health).filter(h => h.ok).length}/${Object.keys(health).length} endpoints healthy)`

    await recordHealthEvent(this.providerId, { eventType: 'CONNECTION_TEST', success: allOk, message }).catch(() => {})

    if (allOk) {
      await prisma.provider.update({ where: { id: this.providerId }, data: { lastSuccessfulConnection: new Date(), lastError: null, errorCount: 0 } }).catch(() => {})
    } else {
      const firstError = Object.values(health).find(h => !h.ok)?.error || 'Partial connectivity'
      await prisma.provider.update({ where: { id: this.providerId }, data: { lastFailedConnection: new Date(), lastError: firstError.substring(0, 500), errorCount: { increment: 1 } } }).catch(() => {})
    }

    return { success: allOk, data: { message, latencyMs: overallLatency, health } }
  }

  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured' } }

    const endpoint = 'productOfferings'
    const path = SEAMLESS_ENDPOINTS[endpoint]
    const finalUrl = buildSeamlessUrl(config.apiBaseUrl, endpoint, undefined)

    try {
      const result = await this.request(endpoint, { method: 'GET', queryParams: { limit: '1' }, timeoutMs: 10000, retries: 0 })
      return {
        success: result.success,
        data: {
          connectorClass: 'TelnaSeamlessConnector', method: 'GET', baseUrl: config.apiBaseUrl, authUrl: '', path, finalUrl,
          tokenPlacement: 'HEADER', authType: 'API_KEY', authHeaderPresent: true, tokenReplaced: false,
          responseStatus: result.status || null, responseContentType: 'application/json',
          responseBody: result.data ? JSON.stringify(result.data).substring(0, 300) : null,
          latencyMs: result.latencyMs || null, warnings: [],
        },
        error: result.error,
      }
    } catch (e: any) {
      return {
        success: false,
        data: {
          connectorClass: 'TelnaSeamlessConnector', method: 'GET', baseUrl: config.apiBaseUrl, authUrl: '', path, finalUrl,
          tokenPlacement: 'HEADER', authType: 'API_KEY', authHeaderPresent: true, tokenReplaced: false,
          responseStatus: null, responseContentType: null, responseBody: null, latencyMs: null,
          warnings: [e.message?.substring(0, 200)],
        },
        error: { code: 'NETWORK_ERROR', message: e.message?.substring(0, 200) },
      }
    }
  }

  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    const plans: ConnectorPlan[] = []
    let cursor: string | undefined
    let hasMore = true

    while (hasMore) {
      const params: Record<string, string> = { limit: '50' }
      if (cursor) params.cursor = cursor

      const result = await this.request('productOfferings', { method: 'GET', queryParams: params })
      if (!result.success) return { success: false, error: result.error }

      const apiResponse = result.data as SeamlessOSApiResponse<SeamlessProductOffering>
      const items = apiResponse.items || []

      for (const item of items) {
        const dataMb = item.product?.features?.dataMb || 0
        const price = item.price?.netPrice || 0
        const validityDays = item.price?.billingCycle?.period === 'MONTHLY' ? 30
          : item.price?.billingCycle?.period === 'YEARLY' ? 365
          : 30

        plans.push({
          id: item.productOfferingId,
          name: item.name,
          data_gb: dataMb / 1024,
          validity_days: validityDays,
          price_usd: price,
          currency: item.price?.currency || 'USD',
          description: item.description,
          sku: item.product?.internalName,
          templateVersion: item.status,
          raw_data: item,
        })
      }

      cursor = apiResponse.pagination?.nextCursor || undefined
      hasMore = !!cursor
    }

    console.log(`[SEAMLESS_SYNC] providerId=${this.providerId} plansCount=${plans.length}`)
    return { success: true, data: plans }
  }

  async validatePurchase(_params: { planId: string; quantity: number; subscriber: { email: string } }): Promise<{ valid: boolean; reason?: string }> {
    const config = await this.loadConfig()
    if (!config) return { valid: false, reason: 'Provider not configured or API key missing' }
    if (!config.apiBaseUrl) return { valid: false, reason: 'API base URL not configured' }
    return { valid: true }
  }

  async activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    const correlationId = generateCorrelationId()
    const startMs = Date.now()
    const purchaseRef = params.externalId || `onesim-${Date.now()}`
    const subscriberName = [params.subscriber.first_name, params.subscriber.last_name].filter(Boolean).join(' ') || params.subscriber.email

    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured or API key missing' } }

    const orderBody = {
      customer: { name: subscriberName, email: params.subscriber.email, customerType: 'consumer' },
      externalPayment: { reference: purchaseRef, receiptDescription: 'OneSIM eSIM Purchase' },
      lineItems: [{
        type: 'SUBSCRIPTION',
        productOfferingId: params.planId,
        quantity: params.quantity,
        subscriber: { name: subscriberName, email: params.subscriber.email },
        sim: { esim: true },
      }],
    }

    console.log(`[SEAMLESS_PURCHASE] correlationId=${correlationId} ref=${purchaseRef} step=CREATE_ORDER planId=${params.planId} quantity=${params.quantity}`)

    const createResult = await this.request('orders', {
      method: 'POST', body: orderBody,
      idempotencyKey: `onesim-${purchaseRef}-create-order`,
      timeoutMs: config.timeoutMs,
    })
    if (!createResult.success) {
      const durationMs = Date.now() - startMs
      console.log(`[SEAMLESS_PURCHASE] correlationId=${correlationId} step=CREATE_ORDER result=FAIL code=${createResult.error?.code} durationMs=${durationMs}`)
      return { success: false, error: createResult.error }
    }

    const order = createResult.data as SeamlessOrder
    const orderId = order.orderId
    console.log(`[SEAMLESS_PURCHASE] correlationId=${correlationId} ref=${purchaseRef} step=CREATE_ORDER orderId=${orderId} state=${order.state}`)

    console.log(`[SEAMLESS_PURCHASE] correlationId=${correlationId} ref=${purchaseRef} step=SUBMIT_ORDER orderId=${orderId}`)

    const submitResult = await this.request('orderSubmit', {
      method: 'POST', pathParams: { orderId },
      idempotencyKey: `onesim-${purchaseRef}-submit-order`,
      timeoutMs: config.timeoutMs,
    })
    if (!submitResult.success) {
      const durationMs = Date.now() - startMs
      console.log(`[SEAMLESS_PURCHASE] correlationId=${correlationId} step=SUBMIT_ORDER result=FAIL code=${submitResult.error?.code} durationMs=${durationMs}`)
      return { success: false, error: submitResult.error }
    }

    const orderState = order.state || (submitResult.data as any)?.state || ''
    console.log(`[SEAMLESS_PURCHASE] correlationId=${correlationId} ref=${purchaseRef} step=SUBMIT_ORDER orderId=${orderId} state=${orderState}`)

    const finalOrder = await this.pollOrder(orderId, correlationId, config)
    if (!finalOrder.success) {
      const durationMs = Date.now() - startMs
      console.log(`[SEAMLESS_PURCHASE] correlationId=${correlationId} step=POLL result=FAIL code=${finalOrder.error?.code} durationMs=${durationMs}`)
      return { success: false, error: finalOrder.error }
    }

    const completedOrder = finalOrder.data!
    const subscriptions = completedOrder.createdEntities?.subscriptions || []
    const subscriptionEntry = subscriptions[0]
    const subscriptionId = subscriptionEntry?.subscriptionId || ''

    if (!subscriptionId) {
      const durationMs = Date.now() - startMs
      console.log(`[SEAMLESS_PURCHASE] correlationId=${correlationId} step=EXTRACT_SUB result=NO_SUBSCRIPTION orderId=${orderId} durationMs=${durationMs}`)
      return { success: true, data: { activationId: orderId, iccids: [], status: 'PENDING_ACTIVATION' } }
    }

    console.log(`[SEAMLESS_PURCHASE] correlationId=${correlationId} ref=${purchaseRef} step=GET_SUBSCRIPTION subscriptionId=${subscriptionId}`)

    const subResult = await this.request('subscription', {
      method: 'GET', pathParams: { subscriptionId }, timeoutMs: config.timeoutMs,
    })
    if (!subResult.success) {
      const durationMs = Date.now() - startMs
      console.log(`[SEAMLESS_PURCHASE] correlationId=${correlationId} step=GET_SUBSCRIPTION result=FAIL code=${subResult.error?.code} durationMs=${durationMs}`)
      return { success: true, data: { activationId: subscriptionId, iccids: [], status: 'PENDING_ACTIVATION' } }
    }

    const subscription = subResult.data as SeamlessSubscription
    const iccid = extractIccid(subscription) || ''
    const iccids = iccid ? [iccid] : []
    const subscriptionStatus = subscription.status || subscriptionEntry?.status || ''
    const normalizedStatus = mapSubscriptionState(subscriptionStatus)

    console.log(`[SEAMLESS_PURCHASE] correlationId=${correlationId} ref=${purchaseRef} step=GET_QR subscriptionId=${subscriptionId}`)

    let qrCodeUrl: string | undefined
    let matchingId: string | undefined
    let smdpAddress: string | undefined
    let activationCodes: string[] | undefined

    const qrResult = await this.request('subscriptionQR', {
      method: 'GET', pathParams: { subscriptionId }, timeoutMs: config.timeoutMs,
    })
    if (qrResult.success) {
      const qrData = qrResult.data as SeamlessQRCode
      qrCodeUrl = qrData.qrCodeUrl || qrData.lpa
      matchingId = qrData.matchingId
      smdpAddress = qrData.smdpAddress
      if (qrData.activationCode) activationCodes = [qrData.activationCode]
    }

    const durationMs = Date.now() - startMs
    console.log(`[SEAMLESS_PURCHASE] correlationId=${correlationId} ref=${purchaseRef} result=SUCCESS subscriptionId=${subscriptionId} iccidCount=${iccids.length} status=${normalizedStatus} durationMs=${durationMs}`)

    return {
      success: true,
      data: {
        activationId: subscriptionId || orderId,
        iccids: iccids.length ? iccids : [subscriptionId || orderId],
        activationCodes,
        qrCodeUrl,
        matchingId,
        smdpAddress,
        status: normalizedStatus,
      },
    }
  }

  private async pollOrder(
    orderId: string,
    correlationId: string,
    config: SeamlessConfig,
  ): Promise<ConnectorResult<SeamlessOrder>> {
    const maxAttempts = 10
    const initialDelayMs = 2000

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = initialDelayMs * Math.pow(1.5, attempt - 2)
        await new Promise(r => setTimeout(r, delay))
      }

      const result = await this.request('order', {
        method: 'GET', pathParams: { orderId }, timeoutMs: config.timeoutMs, retries: 0,
      })

      if (!result.success) {
        console.log(`[SEAMLESS_POLL] correlationId=${correlationId} orderId=${orderId} attempt=${attempt} result=REQUEST_FAIL`)
        continue
      }

      const order = result.data as SeamlessOrder
      const state = (order.state || '').toUpperCase()
      console.log(`[SEAMLESS_POLL] correlationId=${correlationId} orderId=${orderId} attempt=${attempt} state=${state}`)

      if (state === 'COMPLETED') return { success: true, data: order }
      if (state === 'CANCELLED' || state === 'EXPIRED') {
        return { success: false, error: { code: 'ORDER_CANCELLED', message: `Order ${orderId} was ${state}: ${order.failureReason || ''}` } }
      }
      if (state === 'FAILED') {
        return { success: false, error: { code: 'ORDER_FAILED', message: `Order ${orderId} failed: ${order.failureReason || ''}` } }
      }
    }

    return { success: false, error: { code: 'ORDER_NOT_READY', message: `Order ${orderId} did not complete after ${maxAttempts} polls` } }
  }

  async getStatus(subscriptionId: string): Promise<ConnectorResult<StatusResult>> {
    const correlationId = generateCorrelationId()
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured' } }

    console.log(`[SEAMLESS_STATUS] correlationId=${correlationId} subscriptionId=${subscriptionId}`)

    const result = await this.request('subscription', {
      method: 'GET', pathParams: { subscriptionId }, timeoutMs: config.timeoutMs, retries: 1,
    })

    if (!result.success) {
      console.log(`[SEAMLESS_STATUS] correlationId=${correlationId} subscriptionId=${subscriptionId} result=REQUEST_FAIL code=${result.error?.code}`)
      return { success: false, error: result.error }
    }

    const subscription = result.data as SeamlessSubscription
    const rawStatus = subscription.status || 'UNKNOWN'
    const status = mapSubscriptionState(rawStatus)
    const iccid = extractIccid(subscription)

    console.log(`[SEAMLESS_STATUS] correlationId=${correlationId} subscriptionId=${subscriptionId} rawStatus=${rawStatus} normalized=${status} iccid=${iccid ? maskIccid(iccid) : 'none'}`)

    return { success: true, data: { status, iccid: iccid || undefined, iccids: iccid ? [iccid] : undefined } }
  }

  async getQRCode(lookupId: string): Promise<ConnectorResult<{ qrCodeUrl: string }>> {
    const correlationId = generateCorrelationId()
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured' } }

    console.log(`[SEAMLESS_QR] correlationId=${correlationId} lookupId=${lookupId}`)

    const result = await this.request('subscriptionQR', {
      method: 'GET', pathParams: { subscriptionId: lookupId }, timeoutMs: config.timeoutMs, retries: 1,
    })

    if (!result.success) {
      console.log(`[SEAMLESS_QR] correlationId=${correlationId} lookupId=${lookupId} result=REQUEST_FAIL code=${result.error?.code}`)
      return { success: false, error: result.error }
    }

    const qrData = result.data as SeamlessQRCode
    const qrCodeUrl = qrData.qrCodeUrl || qrData.lpa || ''

    if (!qrCodeUrl) {
      console.log(`[SEAMLESS_QR] correlationId=${correlationId} lookupId=${lookupId} result=NO_QR fields=${Object.keys(qrData).join(',')}`)
      return { success: false, error: { code: 'QR_NOT_FOUND', message: 'SeamlessOS returned no QR code URL' } }
    }

    console.log(`[SEAMLESS_QR] correlationId=${correlationId} lookupId=${lookupId} result=SUCCESS`)
    return { success: true, data: { qrCodeUrl } }
  }

  async getUsage(_iccid: string): Promise<ConnectorResult<UsageResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Usage implementation pending (Phase P2D-2)' } }
  }

  async suspendESIM(_subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Suspend implementation pending (Phase P2D-2)' } }
  }

  async resumeESIM(_subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Resume implementation pending (Phase P2D-2)' } }
  }

  async getRates(): Promise<ConnectorResult<RateResult[]>> {
    return { success: false, error: { code: 'UNSUPPORTED', message: 'SeamlessOS does not expose a standalone rates endpoint' } }
  }

  async topUpESIM(_params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Top-up implementation pending (Phase P2D-2)' } }
  }
}
