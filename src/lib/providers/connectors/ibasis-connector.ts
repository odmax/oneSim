import { prisma } from '@/lib/prisma'
import { decryptToken } from '@/lib/encryption'
import { recordHealthEvent } from '@/lib/services/providers/health-monitor'
import type { IbasisInventorySim } from '@/lib/providers/mappers/ibasis-sim-mapper'
import { maskActivationCode, maskIccid } from '@/lib/providers/mappers/ibasis-sim-mapper'
import type { IbasisSubscriberInput, MappedIbasisSubscriber } from '@/lib/providers/mappers/ibasis-subscriber-mapper'
import { toIbasisSubscriberPayload, mapIbasisSubscriber } from '@/lib/providers/mappers/ibasis-subscriber-mapper'
import type { MappedIbasisSubscription, MappedIbasisActivationStatus } from '@/lib/providers/mappers/ibasis-subscription-mapper'
import { mapIbasisSubscription, mapIbasisActivationStatus } from '@/lib/providers/mappers/ibasis-subscription-mapper'
import type {
  IProviderConnector, ConnectorResult, ConnectorPlan, DiagnosticInfo,
  ActivateESIMParams, ActivateESIMResult, UsageResult, StatusResult,
  RateResult, TopUpESIMParams, TopUpESIMResult, TokenState, EsimLifecycleResult,
} from './connector-interface'

/**
 * iBASIS Consumer Offer API connector.
 *
 * Phase 1 scope: authentication via a static API token and safe connection
 * testing against the inventory endpoint. Purchasing, plan sync, status,
 * suspend/resume and QR retrieval are declared capabilities but are wired in
 * later phases.
 *
 * Authentication is done by sending the configured token in an
 * `Authorization: Token <token>` header (never `Bearer`).
 *
 * The base URL and all behavior come from provider database configuration
 * (provider.config / provider.apiBaseUrl / provider.apiToken) — nothing is
 * hard-coded in source.
 */

interface IbasisConfig {
  baseUrl: string
  apiToken: string
  requestTimeoutMs: number
  environment: string
  defaultCurrency: string
  inventoryPath: string
  inventoryPageSize: number
  retailPlansPath: string
  retailPlanDetailPath: string
  retailPlansPageSize: number
  syncTimeoutMs: number
  subscribersPath: string
  subscriptionsPath: string
  subscriptionActivationsPath: string
}

export type NormalizedProviderErrorCode = 'AUTH_ERROR' | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'RATE_LIMIT' | 'PROVIDER_ERROR' | 'NETWORK_ERROR'

export interface NormalizedProviderError {
  code: NormalizedProviderErrorCode
  message: string
}

interface IbasisRequestResult {
  success: boolean
  status?: number
  data?: any
  error?: { code: string; message: string }
  latencyMs?: number
}

/** A page of the iBASIS SIM inventory (`GET {inventoryPath}`). */
export interface IbasisInventoryPage {
  items: IbasisInventorySim[]
  total: number
  next: string | null
  previous: string | null
}

export interface IbasisInventoryQuery {
  type?: string
  status?: string
  after?: string
  limit?: number
  /** When provided, fetches this absolute pagination URL directly (from a previous `next`/`previous`). */
  nextUrl?: string
}

export interface IbasisRetailPlan {
  id?: string
  name?: string
  quota?: {
    data?: number | string
    voice?: number | string
    messages?: number | string
    credit?: number | string
    'unlimited minutes'?: boolean
    'unlimited messages'?: boolean
  }
  currency?: string
  duration?: number | string
  duration_type?: number | string
}

const DEFAULT_INVENTORY_PATH = '/api/v1/inventory/sims'
const DEFAULT_RETAIL_PLANS_PATH = '/api/v1/plans'
const DEFAULT_RETAIL_PLAN_DETAIL_PATH = '/api/v1/plans/{plan id}'
const DEFAULT_SUBSCRIBERS_PATH = '/api/v1/subscribers'
const DEFAULT_SUBSCRIPTIONS_PATH = '/api/v1/subscriptions'
const DEFAULT_SUBSCRIPTION_ACTIVATIONS_PATH = '/api/v1/subscriptions/activations'
const DEFAULT_REQUEST_TIMEOUT_MS = 15000
const DEFAULT_PAGE_SIZE = 1
const DEFAULT_RETAIL_PAGE_SIZE = 50
const DEFAULT_SYNC_TIMEOUT_MS = 30000
const MAX_RETAIL_PLANS = 500
const TOKEN_HEADER_PREFIX = 'Token '

function generateCorrelationId(): string {
  return `ibs-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
}

/** Masks a token for safe logging/diagnostics. Never log the raw token. */
export function maskToken(token: string | null | undefined): string {
  if (!token) return ''
  if (token.length <= 8) return '••••'
  return `${token.slice(0, 4)}••••${token.slice(-4)}`
}

/**
 * Maps any iBASIS request error into the normalized provider error set:
 * AUTH_ERROR | VALIDATION_ERROR | NOT_FOUND | RATE_LIMIT | PROVIDER_ERROR | NETWORK_ERROR.
 */
export function normalizeProviderError(err: { code?: string; message?: string } | null | undefined): NormalizedProviderError {
  const code = err?.code || 'PROVIDER_ERROR'
  const message = err?.message || 'iBASIS provider error'

  if (code === 'AUTH_ERROR') return { code: 'AUTH_ERROR', message }
  if (code === 'NETWORK_ERROR' || code === 'TIMEOUT') return { code: 'NETWORK_ERROR', message }
  if (code === 'NON_JSON_RESPONSE') return { code: 'PROVIDER_ERROR', message }
  if (code === 'HTTP_400' || code === 'HTTP_422' || code === 'VALIDATION_ERROR') return { code: 'VALIDATION_ERROR', message }
  if (code === 'HTTP_404' || code === 'NOT_FOUND') return { code: 'NOT_FOUND', message }
  if (code === 'HTTP_429' || code === 'RATE_LIMIT') return { code: 'RATE_LIMIT', message }
  if (code === 'NOT_CONFIGURED') return { code: 'PROVIDER_ERROR', message }
  return { code: 'PROVIDER_ERROR', message }
}

function looksLikeHtml(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase()
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<head')
}

/** Recursively redacts eSIM activation codes before surfacing responses in diagnostics. */
function redactResponseForDiagnostics(data: any): any {
  if (!data || typeof data !== 'object') return data
  if (Array.isArray(data)) return data.map(redactResponseForDiagnostics)
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(data)) {
    if (k === 'activation_code' && typeof v === 'string') {
      out[k] = maskActivationCode(v)
    } else if (v && typeof v === 'object') {
      out[k] = redactResponseForDiagnostics(v)
    } else {
      out[k] = v
    }
  }
  return out
}

export class IbasisConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string = 'iBASIS'

  constructor(providerId: string) {
    this.providerId = providerId
  }

  private async loadConfig(): Promise<IbasisConfig | null> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return null
    const cfg = (provider.config as any) || {}
    const apiToken = provider.apiToken ? decryptToken(provider.apiToken) : cfg.apiToken || null
    if (!apiToken) return null
    const baseUrl = (cfg.baseUrl || provider.apiBaseUrl || '').replace(/\/+$/, '')
    if (!baseUrl) return null
    return {
      baseUrl,
      apiToken,
      requestTimeoutMs: Number(cfg.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS,
      environment: cfg.environment || provider.environment || 'staging',
      defaultCurrency: cfg.defaultCurrency || 'USD',
      inventoryPath: cfg.inventoryPath || DEFAULT_INVENTORY_PATH,
      inventoryPageSize: Number(cfg.inventoryPageSize) || DEFAULT_PAGE_SIZE,
      retailPlansPath: cfg.retailPlansPath || DEFAULT_RETAIL_PLANS_PATH,
      retailPlanDetailPath: cfg.retailPlanDetailPath || DEFAULT_RETAIL_PLAN_DETAIL_PATH,
      retailPlansPageSize: Number(cfg.retailPlansPageSize) || DEFAULT_RETAIL_PAGE_SIZE,
      syncTimeoutMs: Number(cfg.syncTimeoutMs) || DEFAULT_SYNC_TIMEOUT_MS,
      subscribersPath: cfg.subscribersPath || DEFAULT_SUBSCRIBERS_PATH,
      subscriptionsPath: cfg.subscriptionsPath || DEFAULT_SUBSCRIPTIONS_PATH,
      subscriptionActivationsPath: cfg.subscriptionActivationsPath || DEFAULT_SUBSCRIPTION_ACTIVATIONS_PATH,
    }
  }

  private async request(
    path: string,
    options: {
      queryParams?: Record<string, string | number>
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
      body?: unknown
    } = {},
  ): Promise<IbasisRequestResult> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'iBASIS not configured (baseUrl and apiToken required)' } }
    }

    const method = options.method || 'GET'
    // Absolute URLs (e.g. `next`/`previous` pagination links) are fetched directly.
    const absoluteUrl = path.startsWith('http://') || path.startsWith('https://')
    const urlObj = new URL(absoluteUrl ? path : config.baseUrl + path)
    if (options.queryParams) {
      for (const [k, v] of Object.entries(options.queryParams)) {
        if (v !== undefined && v !== null && v !== '') urlObj.searchParams.set(k, String(v))
      }
    }
    const finalUrl = urlObj.toString()
    const correlationId = generateCorrelationId()
    const startMs = Date.now()

    const headers: Record<string, string> = {
      Authorization: `${TOKEN_HEADER_PREFIX}${config.apiToken}`,
      Accept: 'application/json',
    }
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs)
      const response = await fetch(finalUrl, { method, headers, body, signal: controller.signal })
      clearTimeout(timeout)
      const latencyMs = Date.now() - startMs
      const rawText = await response.text()

      let data: any = null
      let parseFailed = false
      if (rawText.trim().length > 0) {
        try { data = JSON.parse(rawText) } catch { parseFailed = true }
      }

      console.log(`[IBASIS_REQUEST] correlationId=${correlationId} method=${method} path=${path} status=${response.status} latencyMs=${latencyMs} parseFailed=${parseFailed} tokenMasked=${maskToken(config.apiToken)}`)

      if (parseFailed) {
        const html = looksLikeHtml(rawText)
        return {
          success: false, status: response.status, latencyMs,
          error: {
            code: 'NON_JSON_RESPONSE',
            message: html
              ? `iBASIS returned HTML instead of JSON (status ${response.status})`
              : `iBASIS returned malformed JSON (status ${response.status})`,
          },
        }
      }

      // A valid JSON body OR an authenticated empty result means connected.
      if (response.ok) return { success: true, status: response.status, data, latencyMs }

      if (response.status === 401 || response.status === 403) {
        return {
          success: false, status: response.status, latencyMs,
          error: { code: 'AUTH_ERROR', message: `iBASIS authentication failed (HTTP ${response.status})` },
        }
      }

      return {
        success: false, status: response.status, latencyMs, data,
        error: { code: `HTTP_${response.status}`, message: `iBASIS returned HTTP ${response.status}` },
      }
    } catch (e: any) {
      const latencyMs = Date.now() - startMs
      const causeCode = e?.cause?.code || ''
      let code = 'NETWORK_ERROR'
      let msg: string
      if (e?.name === 'AbortError') {
        code = 'TIMEOUT'
        msg = `iBASIS request timed out after ${config.requestTimeoutMs}ms`
      } else if (causeCode === 'ENOTFOUND') {
        msg = 'iBASIS host not found (DNS failure)'
      } else if (causeCode === 'ECONNREFUSED') {
        msg = 'iBASIS refused the connection'
      } else {
        msg = `iBASIS request failed: ${e?.message?.substring(0, 200)}`
      }
      console.log(`[IBASIS_ERROR] correlationId=${correlationId} path=${path} code=${code} latencyMs=${latencyMs} error=${msg}`)
      return { success: false, error: { code, message: msg }, latencyMs }
    }
  }

  async authenticate(): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    return { success: false, error: { code: 'UNSUPPORTED', message: 'iBASIS uses a static API token — configure apiToken directly' } }
  }

  async getTokenState(): Promise<TokenState> {
    const config = await this.loadConfig()
    return { tokenPresent: !!config?.apiToken, expiryPresent: false, expired: false, expiresSoon: false, tokenExpiry: null }
  }

  async ensureAuthenticated(): Promise<ConnectorResult<void>> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'iBASIS provider not configured (baseUrl and apiToken required)' } }
    return { success: true }
  }

  async refreshAuthentication(): Promise<boolean> {
    return false
  }

  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }

    const result = await this.request(config.inventoryPath, { queryParams: { limit: config.inventoryPageSize } })

    await recordHealthEvent(this.providerId, { eventType: 'CONNECTION_TEST', success: result.success, message: result.error?.message || 'Connected', durationMs: result.latencyMs }).catch(() => {})

    if (result.success) {
      await prisma.provider.update({
        where: { id: this.providerId },
        data: { lastSuccessfulConnection: new Date(), lastError: null, errorCount: 0 },
      }).catch(() => {})
      return { success: true, data: { message: `Connected (${result.latencyMs}ms)`, latencyMs: result.latencyMs } }
    }

    await prisma.provider.update({
      where: { id: this.providerId },
      data: { lastFailedConnection: new Date(), lastError: (result.error?.message || 'Connection failed').substring(0, 500), errorCount: { increment: 1 } },
    }).catch(() => {})
    return { success: false, error: result.error }
  }

  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    const config = await this.loadConfig()
    if (!config) {
      return {
        success: false,
        data: {
          connectorClass: 'IbasisConnector', method: 'GET', baseUrl: '', authUrl: '', path: DEFAULT_INVENTORY_PATH, finalUrl: '',
          tokenPlacement: 'HEADER', authType: 'API_TOKEN', authHeaderPresent: false, tokenReplaced: false,
          responseStatus: null, responseContentType: null, responseBody: null, latencyMs: null,
          warnings: ['Provider not configured (baseUrl and apiToken required)'],
        },
        error: { code: 'NOT_CONFIGURED', message: 'Provider not configured' },
      }
    }

    const path = config.inventoryPath
    const finalUrl = `${config.baseUrl}${path}`
    const result = await this.request(path, { queryParams: { limit: config.inventoryPageSize } })

    return {
      success: result.success,
      data: {
        connectorClass: 'IbasisConnector', method: 'GET', baseUrl: config.baseUrl, authUrl: '', path, finalUrl,
        tokenPlacement: 'HEADER', authType: 'API_TOKEN', authHeaderPresent: true, tokenReplaced: false,
        responseStatus: result.status ?? null,
        responseContentType: result.status ? 'application/json' : null,
        responseBody: result.data ? JSON.stringify(redactResponseForDiagnostics(result.data)).substring(0, 300) : null,
        latencyMs: result.latencyMs ?? null,
        warnings: [],
        requestTimeoutMs: config.requestTimeoutMs,
      },
      error: result.error,
    }
  }

  /**
   * Fetches one page of the SIM inventory (`GET {inventoryPath}`).
   * Pagination is driven by the `next`/`previous` URLs returned by iBASIS;
   * pass a URL back in via `query.nextUrl` to walk pages.
   */
  async listInventorySims(query: IbasisInventoryQuery = {}): Promise<ConnectorResult<IbasisInventoryPage>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }

    const result = query.nextUrl
      ? await this.request(query.nextUrl)
      : await this.request(config.inventoryPath, {
          queryParams: {
            limit: query.limit ?? config.inventoryPageSize,
            ...(query.type ? { type: query.type } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.after ? { after: query.after } : {}),
          },
        })

    if (!result.success) return { success: false, error: result.error }

    const data = result.data
    const rawResults = Array.isArray(data?.results) ? data.results : null
    if (!rawResults) {
      return {
        success: false,
        error: { code: 'INVALID_RESPONSE', message: 'iBASIS inventory response missing "results" array' },
      }
    }

    const items: IbasisInventorySim[] = rawResults.map((r: any) => ({
      iccid: typeof r?.iccid === 'string' ? r.iccid : '',
      type: typeof r?.type === 'string' ? r.type : undefined,
      carrier: typeof r?.carrier === 'string' ? r.carrier : undefined,
      status: typeof r?.status === 'string' ? r.status : undefined,
      activation_code: typeof r?.activation_code === 'string' ? r.activation_code : undefined,
    }))

    return {
      success: true,
      data: {
        items,
        total: typeof data?.count === 'number' ? data.count : items.length,
        next: typeof data?.next === 'string' && data.next ? data.next : null,
        previous: typeof data?.previous === 'string' && data.previous ? data.previous : null,
      },
    }
  }

  private normalizeRetailPlan(raw: any, defaultCurrency: string): ConnectorPlan | null {
    if (!raw || typeof raw !== 'object') return null
    const id = raw.id
    const name = raw.name
    if (id === undefined || id === null || String(id).trim() === '' || !name) return null

    const quota = raw.quota && typeof raw.quota === 'object' ? raw.quota : {}
    const dataBytes = typeof quota.data === 'string' ? parseFloat(quota.data) : typeof quota.data === 'number' ? quota.data : 0
    const dataGB = Math.max(1, Math.round((isFinite(dataBytes) ? dataBytes : 0) / 1024 ** 3))

    const rawDuration = typeof raw.duration === 'string' ? parseInt(raw.duration, 10) : typeof raw.duration === 'number' ? raw.duration : 0
    const durationType = typeof raw.duration_type === 'string' ? parseInt(raw.duration_type, 10) : typeof raw.duration_type === 'number' ? raw.duration_type : 0
    // duration_type 0 = fixed days; monthly types (1, 2) ignore duration — default to 30 days.
    const validityDays = durationType === 0 && isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 30

    const currency = typeof raw.currency === 'string' && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : defaultCurrency

    return {
      id: String(id),
      name: String(name),
      data_gb: dataGB,
      validity_days: validityDays,
      // iBASIS retail plans do not expose a price — leave 0 so costStatus stays MISSING.
      price_usd: 0,
      currency,
      description: String(name),
      sku: String(id),
      raw_data: raw,
    }
  }

  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }

    const listResult = await this.request(config.retailPlansPath, { queryParams: { limit: config.retailPlansPageSize } })
    if (!listResult.success) return { success: false, error: listResult.error }

    const rawIds = listResult.data?.plans
    if (!Array.isArray(rawIds)) {
      return {
        success: false,
        error: { code: 'INVALID_RESPONSE', message: 'iBASIS retail plans response missing "plans" array' },
      }
    }

    const planIds = rawIds
      .filter((id: any) => id !== null && id !== undefined && String(id).trim() !== '')
      .slice(0, MAX_RETAIL_PLANS)
      .map((id: any) => String(id))

    const plans: ConnectorPlan[] = []
    const failures: string[] = []

    for (const planId of planIds) {
      const detailResult = await this.request(
        config.retailPlanDetailPath.replace('{plan id}', encodeURIComponent(planId)),
      )
      if (!detailResult.success) {
        failures.push(planId)
        continue
      }
      const normalized = this.normalizeRetailPlan(detailResult.data, config.defaultCurrency)
      if (normalized) plans.push(normalized)
    }

    if (failures.length > 0) {
      console.log(`[IBASIS_PLAN_SYNC] planIds=${planIds.length} fetched=${plans.length} failed=${failures.length} failedIds=${failures.join(',')}`)
    }

    if (planIds.length > 0 && plans.length === 0 && failures.length === planIds.length) {
      return {
        success: false,
        error: {
          code: 'PARTIAL_FAILURE',
          message: `Failed to fetch any of ${planIds.length} retail plan details`,
        },
      }
    }

    return { success: true, data: plans }
  }

  // ── Phase 3: Subscriber & Subscription lifecycle ──────────────────────────

  /** Creates a subscriber on iBASIS (`POST {subscribersPath}`). */
  async createSubscriber(input: IbasisSubscriberInput): Promise<ConnectorResult<{ providerSubscriberId: string }>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }
    const result = await this.request(config.subscribersPath, { method: 'POST', body: toIbasisSubscriberPayload(input) })
    if (!result.success) {
      const normalized = normalizeProviderError(result.error)
      const detail = result.data && ((result.data as any).detail || (result.data as any).message || (result.data as any).error)
      return {
        success: false,
        error: { code: normalized.code, message: detail ? `iBASIS: ${String(detail)}` : normalized.message },
      }
    }
    const id = result.data?.id
    if (id === undefined || id === null || String(id).trim() === '') {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'iBASIS subscriber create response missing "id"' } }
    }
    return { success: true, data: { providerSubscriberId: String(id) } }
  }

  /** Fetches a subscriber (`GET {subscribersPath}/{id}`). */
  async getSubscriber(providerSubscriberId: string): Promise<ConnectorResult<MappedIbasisSubscriber>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }
    const result = await this.request(`${config.subscribersPath}/${encodeURIComponent(providerSubscriberId)}`)
    if (!result.success) return { success: false, error: normalizeProviderError(result.error) }
    const mapped = mapIbasisSubscriber(result.data)
    if (!mapped) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'iBASIS subscriber response missing "id"' } }
    }
    return { success: true, data: mapped }
  }

  /** Updates a subscriber (`PATCH {subscribersPath}/{id}`). */
  async updateSubscriber(providerSubscriberId: string, patch: IbasisSubscriberInput): Promise<ConnectorResult<MappedIbasisSubscriber>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }
    const result = await this.request(`${config.subscribersPath}/${encodeURIComponent(providerSubscriberId)}`, {
      method: 'PATCH',
      body: toIbasisSubscriberPayload(patch, true),
    })
    if (!result.success) return { success: false, error: normalizeProviderError(result.error) }
    const mapped = mapIbasisSubscriber(result.data)
    if (!mapped) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'iBASIS subscriber response missing "id"' } }
    }
    return { success: true, data: mapped }
  }

  /** Searches subscribers (`GET {subscribersPath}`) — returns a page of subscriber IDs. */
  async searchSubscribers(
    query: { username?: string; email?: string; firstName?: string; lastName?: string; nextUrl?: string; limit?: number } = {},
  ): Promise<ConnectorResult<{ items: string[]; total: number; next: string | null; previous: string | null }>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }
    const result = query.nextUrl
      ? await this.request(query.nextUrl)
      : await this.request(config.subscribersPath, {
          queryParams: {
            limit: query.limit ?? 50,
            ...(query.username ? { username: query.username } : {}),
            ...(query.email ? { email: query.email } : {}),
            ...(query.firstName ? { first_name: query.firstName } : {}),
            ...(query.lastName ? { last_name: query.lastName } : {}),
          },
        })
    if (!result.success) return { success: false, error: normalizeProviderError(result.error) }

    const rawResults = Array.isArray(result.data?.results) ? result.data.results : null
    if (!rawResults) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'iBASIS subscriber search response missing "results" array' } }
    }
    const items = rawResults
      .filter((id: any) => id !== null && id !== undefined && String(id).trim() !== '')
      .map((id: any) => String(id))
    return {
      success: true,
      data: {
        items,
        total: typeof result.data?.count === 'number' ? result.data.count : items.length,
        next: typeof result.data?.next === 'string' && result.data.next ? result.data.next : null,
        previous: typeof result.data?.previous === 'string' && result.data.previous ? result.data.previous : null,
      },
    }
  }

  /** Creates a subscription (`POST {subscriptionActivationsPath}`). No purchase/payment involved. */
  async createSubscription(params: {
    subscriberId: string
    retailPlanId: string
    devices: Array<{ device: string; type: 'iccid' | 'imei' }>
    activationType?: 'immediate' | 'scheduled'
    serviceAddressId?: string
  }): Promise<ConnectorResult<{ activationId: string; status: string }>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }
    if (!params.subscriberId || !params.retailPlanId || !Array.isArray(params.devices) || params.devices.length === 0) {
      return { success: false, error: { code: 'VALIDATION_ERROR', message: 'createSubscription requires subscriberId, retailPlanId and at least one device' } }
    }

    const body: Record<string, unknown> = {
      subscriber: params.subscriberId,
      retail_plan: params.retailPlanId,
      activation_type: params.activationType || 'immediate',
      devices: params.devices.map((d) => ({ device: d.device, type: d.type })),
    }
    if (params.serviceAddressId) body.service_address = params.serviceAddressId

    const result = await this.request(config.subscriptionActivationsPath, { method: 'POST', body })
    if (!result.success) return { success: false, error: normalizeProviderError(result.error) }

    const id = result.data?.id
    if (id === undefined || id === null || String(id).trim() === '') {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'iBASIS subscription create response missing "id"' } }
    }
    // Activation is asynchronous — status starts as PENDING until polled.
    return { success: true, data: { activationId: String(id), status: 'PENDING' } }
  }

  /** Fetches a subscription (`GET {subscriptionsPath}/{id}`). */
  async getSubscription(providerSubscriptionId: string): Promise<ConnectorResult<MappedIbasisSubscription>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }
    const result = await this.request(`${config.subscriptionsPath}/${encodeURIComponent(providerSubscriptionId)}`)
    if (!result.success) return { success: false, error: normalizeProviderError(result.error) }
    const mapped = mapIbasisSubscription(result.data)
    if (!mapped) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'iBASIS subscription response missing "id"' } }
    }
    return { success: true, data: mapped }
  }

  /** Fetches subscription status only (`GET {subscriptionsPath}/{id}` → normalized status). */
  async getSubscriptionStatus(providerSubscriptionId: string): Promise<ConnectorResult<{ status: string; providerStatus: string; iccid?: string | null; subscriberId?: string | null }>> {
    const result = await this.getSubscription(providerSubscriptionId)
    if (!result.success) return { success: false, error: result.error }
    return {
      success: true,
      data: {
        status: result.data!.status,
        providerStatus: result.data!.providerStatus,
        iccid: result.data!.iccid,
        subscriberId: result.data!.subscriberId,
      },
    }
  }

  /** Polls an activation (`GET {subscriptionActivationsPath}/{activationId}`) — returns subscription id once completed. */
  async getActivationStatus(activationId: string): Promise<ConnectorResult<MappedIbasisActivationStatus>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }
    const result = await this.request(`${config.subscriptionActivationsPath}/${encodeURIComponent(activationId)}`)
    if (!result.success) return { success: false, error: normalizeProviderError(result.error) }
    const mapped = mapIbasisActivationStatus(result.data, activationId)
    if (!mapped) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'iBASIS activation status response missing "status"' } }
    }
    return { success: true, data: mapped }
  }

  async validatePurchase(): Promise<{ valid: boolean; reason?: string }> {
    const config = await this.loadConfig()
    if (!config) return { valid: false, reason: 'Provider not configured (baseUrl and apiToken required)' }
    return { valid: true }
  }

  /** SIM inventory statuses that are eligible to be allocated for a new activation. */
  private static readonly ALLOCATABLE_SIM_STATUSES = ['inventory', 'available', 'ready', 'new']

  /** Fetches one page of assignable SIMs from iBASIS inventory. */
  private async listAssignableSims(limit?: number): Promise<ConnectorResult<{ iccid: string; activationCode: string | null; carrier: string | null }[]>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }

    const page = await this.listInventorySims({ limit: limit ?? config.inventoryPageSize })
    if (!page.success || !page.data) {
      return { success: false, error: page.error || { code: 'PROVIDER_ERROR', message: 'Failed to fetch iBASIS inventory during allocation' } }
    }

    const items = (page.data.items || [])
      .filter((s) => !s.status || IbasisConnector.ALLOCATABLE_SIM_STATUSES.includes(String(s.status).toLowerCase()))
      .filter((s) => !!s.iccid)
      .map((s) => ({ iccid: String(s.iccid), activationCode: s.activation_code || null, carrier: s.carrier || null }))

    return { success: true, data: items }
  }

  /**
   * Selects a single assignable SIM from inventory (no persistence). Used for
   * validation/admin checks. See `reserveSim` for the reservation-with-retry flow.
   */
  async allocateSim(): Promise<ConnectorResult<{ iccid: string; activationCode: string | null; carrier: string | null }>> {
    const listed = await this.listAssignableSims()
    if (!listed.success || !listed.data) return { success: false, error: listed.error || { code: 'PROVIDER_ERROR', message: 'Failed to fetch iBASIS inventory during allocation' } }
    const chosen = listed.data[0]
    if (!chosen) return { success: false, error: { code: 'NO_AVAILABLE_SIMS', message: 'No allocatable SIMs available in iBASIS inventory' } }
    return { success: true, data: chosen }
  }

  /**
   * Reserves a SIM locally against a purchase, retrying on `@unique` ICCID
   * conflicts (P2002) so a duplicate ICCID can never be double-allocated.
   * Allocation is a provider inventory read; the local eSIM insert is the lock.
   */
  private async reserveSim(orderId: string | undefined, packageSnapshot: { packageName?: string; packageDataGB?: number; packageValidityDays?: number } | undefined, maxAttempts = 8): Promise<ConnectorResult<{ iccid: string; activationCode: string | null; carrier: string | null }>> {
    const validityDays = Number((packageSnapshot as any)?.validityDays) || 30
    const triedIccids = new Set<string>()

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const listed = await this.listAssignableSims()
      if (!listed.success || !listed.data) return { success: false, error: listed.error || { code: 'PROVIDER_ERROR', message: 'Failed to fetch iBASIS inventory during reservation' } }

      const next = listed.data.find((s) => !triedIccids.has(s.iccid))
      if (!next) {
        // Inventory page exhausted without a free ICCID to try — stop.
        return { success: false, error: { code: 'NO_AVAILABLE_SIMS', message: 'No allocatable SIMs available in iBASIS inventory' } }
      }
      triedIccids.add(next.iccid)

      try {
        const reservation: any = {
          purchaseId: orderId || '',
          iccid: next.iccid,
          imsi: null,
          status: 'PROCESSING',
          providerStatus: 'RESERVED',
          providerActivationId: '',
          activationCode: next.activationCode || null,
          qrCodeUrl: null,
          providerSubscriberId: null,
          providerSubscriptionId: null,
          packageName: packageSnapshot?.packageName || '',
          packageDataGB: packageSnapshot?.packageDataGB ?? 0,
          packageValidityDays: packageSnapshot?.packageValidityDays ?? validityDays,
          packageSnapshot: (packageSnapshot as any) ?? undefined,
          expiresAt: new Date(Date.now() + validityDays * 86400000),
        }
        if (!orderId) delete reservation.purchaseId
        await prisma.eSIM.create({ data: reservation })
        return { success: true, data: { iccid: next.iccid, activationCode: next.activationCode, carrier: next.carrier } }
      } catch (e: any) {
        const code = String(e?.code || '').toUpperCase()
        const msg = String(e?.message || '').toLowerCase()
        // Duplicate ICCID — another concurrent allocation won; try the next assignable SIM.
        if (code === 'P2002' || msg.includes('unique') || msg.includes('already')) continue
        console.log(`[IBASIS] reserveSim local create failed for iccid=${next.iccid.slice(-8)}: ${e?.message || e}`)
        return { success: false, error: { code: 'PROVIDER_ERROR', message: 'Failed to reserve SIM locally' } }
      }
    }

    return { success: false, error: { code: 'NO_AVAILABLE_SIMS', message: 'No allocatable SIMs available after retries' } }
  }

  /** Validates that a specific SIM (by ICCID) is eligible for activation. */
  async validateDevice(iccid: string): Promise<{ valid: boolean; reason?: string }> {
    const config = await this.loadConfig()
    if (!config) return { valid: false, reason: 'Provider not configured (baseUrl and apiToken required)' }
    if (!iccid || String(iccid).trim() === '') return { valid: false, reason: 'ICCID is required' }

    const page = await this.listInventorySims({})
    if (!page.success || !page.data) return { valid: false, reason: page.error?.message || 'Failed to query iBASIS inventory' }

    const match = (page.data.items || []).find((s) => s.iccid === iccid)
    if (!match) return { valid: false, reason: 'SIM not found in inventory' }
    if (match.status && !IbasisConnector.ALLOCATABLE_SIM_STATUSES.includes(String(match.status).toLowerCase())) {
      return { valid: false, reason: `SIM is ${match.status} and not available for activation` }
    }
    return { valid: true }
  }

  /**
   * Creates a subscription (provider activation) via `POST {subscriptionActivationsPath}`.
   * The create-subscription call is idempotent-safe at the provider via an external id reference
   * where supported; the OneSim orchestrator never silently retries this call on failure.
   */
  async activateSubscription(params: {
    subscriberId: string
    retailPlanId: string
    devices: Array<{ device: string; type: 'iccid' | 'imei' }>
    activationType?: 'immediate' | 'scheduled'
    serviceAddressId?: string
  }): Promise<ConnectorResult<{ activationId: string; status: string }>> {
    return this.createSubscription(params)
  }

  /** Cancels a pending provider activation (`DELETE {subscriptionActivationsPath}/{id}`). */
  async cancelActivation(activationId: string): Promise<ConnectorResult<void>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }
    if (!activationId) return { success: false, error: { code: 'VALIDATION_ERROR', message: 'activationId is required' } }

    const result = await this.request(`${config.subscriptionActivationsPath}/${encodeURIComponent(activationId)}`, { method: 'DELETE' })
    if (!result.success) {
      // A 404 means the activation no longer exists — treat as success.
      if (result.status === 404) return { success: true }
      return { success: false, error: normalizeProviderError(result.error) }
    }
    return { success: true }
  }

  /**
   * Reserves a SIM against the OneSim purchase, then activates on the provider.
   *
   * Flow:
   *   1. reserveSim — allocate an assignable ICCID from inventory and persist an
   *      ESIM row (PROCESSING/RESERVED). Retries on `@unique` ICCID conflicts so a
   *      duplicate ICCID can never be double-allocated; the ICCID @unique constraint
   *      is the allocation lock.
   *   2. createSubscriber — ensure the iBASIS subscriber exists (reuse on conflict).
   *   3. createSubscription — provider activation. A DEFINITE failure reverts the
   *      local reservation (freeing the ICCID for reallocation); a NETWORK_ERROR is
   *      uncertain (the provider may have accepted it) so the ESIM is flagged for
   *      reconciliation instead of being deleted.
   *
   * The result is asynchronous (status PENDING): the provider-operation job polls
   * getStatus and finalizes via completeProviderOperation, which flips the reserved
   * ESIM to ACTIVE once the provider confirms network activation.
   */
  async activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }

    // Resolve package context for the reserved eSIM (best-effort; completion is idempotent).
    let pkgForReservation: { packageName?: string; packageDataGB?: number; packageValidityDays?: number } | undefined
    if (params.orderId) {
      const order = await prisma.eSIMPurchase.findUnique({
        where: { id: params.orderId },
        select: { packageName: true, packageDataGB: true, packageValidityDays: true, packageSnapshot: true },
      })
      const validityDays = (order?.packageSnapshot as any)?.validityDays ?? order?.packageValidityDays ?? 30
      pkgForReservation = {
        packageName: order?.packageName || undefined,
        packageDataGB: order?.packageDataGB ?? undefined,
        packageValidityDays: order?.packageValidityDays ?? Number(validityDays ?? 30),
      }
    }

    // 1. Reserve a SIM locally (allocation + persistence, with P2002 retry).
    const reservation = await this.reserveSim(params.orderId, pkgForReservation)
    if (!reservation.success || !reservation.data) {
      return { success: false, error: reservation.error }
    }
    const { iccid, activationCode, carrier } = reservation.data

    const releaseReservation = async () => {
      if (!params.orderId) return
      await prisma.eSIM.deleteMany({ where: { purchaseId: params.orderId, iccid } }).catch(() => {})
    }
    const flagReconciliation = async () => {
      if (!params.orderId) return
      await prisma.eSIM
        .updateMany({ where: { purchaseId: params.orderId, iccid }, data: { providerStatus: 'RECONCILIATION_REQUIRED' } })
        .catch(() => {})
    }

    // 2. Ensure the subscriber exists (reuse an existing one on conflict).
    const username = params.externalId || params.subscriber.email
    let providerSubscriberId: string | null = null
    const created = await this.createSubscriber({
      username,
      email: params.subscriber.email,
      firstName: params.subscriber.first_name,
      lastName: params.subscriber.last_name,
    })
    if (created.success && created.data) {
      providerSubscriberId = created.data.providerSubscriberId
    } else if (params.subscriber.email) {
      const msg = (created.error?.message || '').toLowerCase()
      const isConflict = ['VALIDATION_ERROR', 'HTTP_400', 'HTTP_409', 'PROVIDER_ERROR'].includes(created.error?.code || '')
      if (isConflict && (msg.includes('exist') || msg.includes('duplicate'))) {
        const search = await this.searchSubscribers({ email: params.subscriber.email })
        if (search.success && search.data && search.data.items.length > 0) {
          providerSubscriberId = search.data.items[0]
        } else {
          await releaseReservation()
          return { success: false, error: created.error }
        }
      } else if (created.error?.code === 'NETWORK_ERROR') {
        // Subscriber creation uncertain — keep the SIM reserved for reconciliation.
        await flagReconciliation()
        return { success: false, error: created.error }
      } else {
        await releaseReservation()
        return { success: false, error: created.error }
      }
    } else {
      await releaseReservation()
      return { success: false, error: created.error }
    }

    // 3. Create the subscription (provider activation). Never silently retried on failure.
    const subscription = await this.createSubscription({
      subscriberId: providerSubscriberId,
      retailPlanId: params.planId,
      devices: [{ device: iccid, type: 'iccid' }],
      activationType: 'immediate',
    })
    if (!subscription.success || !subscription.data) {
      if (subscription.error?.code === 'NETWORK_ERROR') {
        // Uncertain: provider may have created the activation. Keep SIM reserved + reconciled.
        await flagReconciliation()
        return { success: false, error: subscription.error }
      }
      // Definite failure — release the ICCID for reallocation.
      await releaseReservation()
      return { success: false, error: subscription.error }
    }

    const activationId = subscription.data.activationId

    // 4. Attach the provider activation reference + subscriber to the reserved eSIM.
    if (params.orderId) {
      await prisma.eSIM
        .updateMany({
          where: { purchaseId: params.orderId, iccid },
          data: {
            providerActivationId: activationId,
            providerSubscriberId: providerSubscriberId || undefined,
            providerStatus: 'PROCESSING',
            providerResponse: { carrier: carrier || null, activationStatus: 'PENDING', allocationAt: new Date().toISOString() } as any,
            lastStatusSyncAt: new Date(),
          },
        })
        .catch((e: any) => console.log(`[IBASIS] attach ref failed for iccid=${maskIccid(iccid)}: ${e?.message || e}`))
    }

    return {
      success: true,
      data: {
        activationId,
        iccids: [iccid],
        imsis: [],
        activationCodes: activationCode ? [activationCode] : [],
        qrCodeUrl: undefined,
        status: 'PENDING',
      },
    }
  }

  /**
   * Polls an activation and resolves to the normalized lifecycle status + ICCID.
   * Used by the provider-operation job to decide completion. While the provider
   * reports PENDING/PROVISIONING no ICCID is returned yet.
   */
  async getStatus(activationId: string): Promise<ConnectorResult<StatusResult>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }

    const activation = await this.getActivationStatus(activationId)
    if (!activation.success || !activation.data) {
      return { success: false, error: activation.error }
    }

    const activationIccids = activation.data.iccids || []

    // Once the provider returns a subscription id, fetch full detail for the ICCID + terminal status.
    if (activation.data.providerSubscriptionId) {
      const sub = await this.getSubscription(activation.data.providerSubscriptionId)
      if (sub.success && sub.data) {
        return {
          success: true,
          data: {
            status: sub.data.status,
            iccids: sub.data.iccid ? [sub.data.iccid] : activationIccids,
            iccid: sub.data.iccid || undefined,
          },
        }
      }
      // Fall through and report based on the activation status.
    }

    return {
      success: true,
      data: { status: activation.data.status, iccids: activationIccids },
    }
  }

  async getUsage(_iccid: string): Promise<ConnectorResult<UsageResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Usage implementation pending (Phase 2)' } }
  }

  async suspendESIM(subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }
    if (!subscriptionId || String(subscriptionId).trim() === '') {
      return { success: false, error: { code: 'VALIDATION_ERROR', message: 'subscriptionId is required' } }
    }

    const result = await this.request(`${config.subscriptionsPath}/${encodeURIComponent(subscriptionId)}/suspend`, { method: 'PUT', body: {} })
    if (!result.success) {
      return { success: false, error: normalizeProviderError(result.error) }
    }
    return { success: true, data: { status: 'SUSPENDED', providerStatus: 'suspended' } }
  }

  async resumeESIM(subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }
    if (!subscriptionId || String(subscriptionId).trim() === '') {
      return { success: false, error: { code: 'VALIDATION_ERROR', message: 'subscriptionId is required' } }
    }

    const result = await this.request(`${config.subscriptionsPath}/${encodeURIComponent(subscriptionId)}/restore`, { method: 'PUT', body: {} })
    if (!result.success) {
      return { success: false, error: normalizeProviderError(result.error) }
    }
    return { success: true, data: { status: 'ACTIVE', providerStatus: 'active' } }
  }

  /** Cancels an entire subscription (`DELETE {subscriptionsPath}/{id}`). Irreversible. */
  async cancelSubscription(subscriptionId: string): Promise<ConnectorResult<void>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }
    if (!subscriptionId || String(subscriptionId).trim() === '') {
      return { success: false, error: { code: 'VALIDATION_ERROR', message: 'subscriptionId is required' } }
    }

    const result = await this.request(`${config.subscriptionsPath}/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE', body: {} })
    if (!result.success) {
      const code = result.error?.code || ''
      if (code === 'HTTP_404' || code === 'NOT_FOUND') {
        return { success: true } // Already cancelled — idempotent
      }
      return { success: false, error: normalizeProviderError(result.error) }
    }
    return { success: true }
  }

  async getRates(): Promise<ConnectorResult<RateResult[]>> {
    return { success: false, error: { code: 'UNSUPPORTED', message: 'iBASIS does not expose a standalone rates endpoint' } }
  }

  async getQRCode(_iccid: string): Promise<ConnectorResult<{ qrCodeUrl: string }>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'QR retrieval pending (Phase 2)' } }
  }

  async topUpESIM(_params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Top-up implementation pending (Phase 2)' } }
  }
}
