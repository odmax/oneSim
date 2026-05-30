import type { IProviderConnector, ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, TopUpESIMParams, TopUpESIMResult, UsageResult, StatusResult, RateResult, DiagnosticInfo } from './connector-interface'
import { classifyError } from './connector-interface'

interface RestCatalogConfig {
  apiBaseUrl: string
  apiToken?: string
  authUrl?: string
  environment?: string
}

async function fetchJson(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ data?: any; error?: { code: string; message: string }; status?: number }> {
  const timeout = opts?.timeoutMs || 15000
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    const response = await fetch(url, {
      method: opts?.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...opts?.headers },
      body: opts?.body,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    const status = response.status
    const text = await response.text()
    if (!response.ok) return { error: { code: `HTTP_${status}`, message: text.substring(0, 300) }, status }
    let data: any
    try { data = JSON.parse(text) } catch { return { error: { code: 'INVALID_JSON', message: 'Non-JSON response' }, status } }
    return { data, status }
  } catch (e: any) {
    if (e.name === 'AbortError') return { error: { code: 'TIMEOUT', message: 'Request timed out' } }
    const msg = e.message || ''
    let code = 'NETWORK_ERROR'
    if (msg.toLowerCase().includes('dns') || msg.toLowerCase().includes('enotfound') || msg.toLowerCase().includes('name resolution')) code = 'NETWORK_ERROR_DNS'
    else if (msg.toLowerCase().includes('econnrefused') || msg.toLowerCase().includes('connection refused')) code = 'NETWORK_ERROR_REFUSED'
    else if (msg.toLowerCase().includes('etimedout')) code = 'NETWORK_ERROR_TIMEOUT'
    else if (msg.toLowerCase().includes('tls') || msg.toLowerCase().includes('certificate')) code = 'NETWORK_ERROR_TLS'
    return { error: { code, message: e.message } }
  }
}

function normalizeUrl(url: string): string {
  if (!url) return url
  url = url.trim()
  const idx = url.indexOf('://')
  if (idx === -1) return url
  const scheme = url.substring(0, idx + 3)
  const rest = url.substring(idx + 3)
  const firstSlashIdx = rest.indexOf('/')
  let authority: string
  let path: string
  if (firstSlashIdx === -1) {
    authority = rest
    path = ''
  } else {
    authority = rest.substring(0, firstSlashIdx)
    path = rest.substring(firstSlashIdx)
  }
  path = path.replace(/\/{2,}/g, '/')
  return `${scheme}${authority}${path}`
}

function maskTokenInUrl(url: string, token: string | undefined): string {
  if (!token || token.length < 4) return url
  const masked = token.slice(0, 4) + '••••'
  return url.replace(token, masked)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

async function diagnoseFetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{
  status: number | null
  contentType: string | null
  body: string | null
  error?: { code: string; message: string }
}> {
  const timeout = opts?.timeoutMs || 15000
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    const response = await fetch(url, {
      method: opts?.method || 'GET',
      headers: opts?.headers,
      body: opts?.body,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    const status = response.status
    const contentType = response.headers.get('content-type') || null
    const body = await response.text()
    if (!response.ok) {
      const rawBody = body.substring(0, 300)
      const classified = isHtmlBody(rawBody) ? `HTML response — ${rawBody.length} chars` : rawBody
      return { status, contentType, body: rawBody, error: { code: `HTTP_${status}`, message: classified } }
    }
    return { status, contentType, body: body.substring(0, 300) }
  } catch (e: any) {
    if (e.name === 'AbortError') return { status: null, contentType: null, body: null, error: { code: 'TIMEOUT', message: 'Request timed out' } }
    const msg = e.message || ''
    let code = 'NETWORK_ERROR'
    if (msg.toLowerCase().includes('dns') || msg.toLowerCase().includes('enotfound') || msg.toLowerCase().includes('name resolution')) code = 'NETWORK_ERROR_DNS'
    else if (msg.toLowerCase().includes('econnrefused') || msg.toLowerCase().includes('connection refused')) code = 'NETWORK_ERROR_REFUSED'
    else if (msg.toLowerCase().includes('etimedout')) code = 'NETWORK_ERROR_TIMEOUT'
    else if (msg.toLowerCase().includes('tls') || msg.toLowerCase().includes('certificate')) code = 'NETWORK_ERROR_TLS'
    return { status: null, contentType: null, body: null, error: { code, message: e.message } }
  }
}

function isHtmlBody(body: string): boolean {
  const trimmed = body.trim()
  return trimmed.startsWith('<!') || trimmed.startsWith('<?xml') || trimmed.startsWith('<html') ||
         trimmed.startsWith('<HTML') || trimmed.includes('<body') || trimmed.includes('<BODY')
}

export class RestCatalogConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string
  protected config: RestCatalogConfig

  constructor(providerId: string, name: string | undefined, config: RestCatalogConfig) {
    this.providerId = providerId
    this.name = name || 'REST Catalog'
    this.config = config
  }

  protected get headers(): Record<string, string> {
    const h: Record<string, string> = {}
    if (this.config.apiToken) h['Authorization'] = `Bearer ${this.config.apiToken}`
    return h
  }

  protected baseUrl(path: string): string {
    if (path.startsWith('http')) return path
    return `${this.config.apiBaseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
  }

  async authenticate(credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    const token = credentials.apiToken || this.config.apiToken
    if (!token) return { success: false, error: { code: 'NO_TOKEN', message: 'No API token provided' } }
    return { success: true, data: { token, accountInfo: {} } }
  }

  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>> {
    const start = Date.now()
    const result = await this.syncPlans()
    if (!result.success) return { success: false, error: result.error }
    return { success: true, data: { message: `Connected. ${(result.data || []).length} plans found.`, latencyMs: Date.now() - start } }
  }

  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    return this.runDiagnostics('GET', '/plans', { headers: this.headers, tokenPlacement: 'HEADER', authType: 'bearer_token' })
  }

  protected async runDiagnostics(method: string, path: string, opts?: {
    headers?: Record<string, string>
    body?: string
    tokenPlacement?: 'URL_PATH' | 'HEADER' | 'QUERY_PARAM' | 'NONE'
    authType?: string
    requestTimeoutMs?: number
  }): Promise<ConnectorResult<DiagnosticInfo>> {
    const baseUrl = this.config.apiBaseUrl || ''
    const authUrl = this.config.authUrl || ''
    const token = this.config.apiToken || ''
    const tokenPlacement = opts?.tokenPlacement || 'HEADER'
    const authType = opts?.authType || 'bearer_token'
    const requestTimeoutMs = opts?.requestTimeoutMs || 15000
    const warnings: string[] = []
    const connectorClass = this.constructor.name

    if (!baseUrl) {
      return {
        success: false,
        data: {
          connectorClass, method, baseUrl, authUrl, path, finalUrl: '—',
          tokenPlacement, authType, authHeaderPresent: false, tokenReplaced: false,
          responseStatus: null, responseContentType: null, responseBody: null,
          latencyMs: null, warnings: ['API Base URL not configured'],
          errorClassification: 'TOKEN_MISSING', requestTimeoutMs, retryAttempted: false, retryExplanation: null,
        },
        error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' },
      }
    }

    if (!token) warnings.push('No token found')
    if (!path.startsWith('/')) warnings.push('Endpoint path does not start with /')

    try { new URL(baseUrl) } catch { warnings.push('Base URL is not a valid URL') }

    if (authUrl && baseUrl.toLowerCase().replace(/\/$/, '') === authUrl.toLowerCase().replace(/\/$/, '')) {
      warnings.push('You are using Auth URL as Base URL')
    }

    let raw = this.baseUrl(path)
    let finalUrl = normalizeUrl(raw)
    let tokenReplaced = !!token

    // Replace {{token}} and {token} placeholders with actual token before request
    if (token && (finalUrl.includes('{{token}}') || finalUrl.includes('{token}'))) {
      finalUrl = finalUrl.replace(/\{\{token\}\}/g, token).replace(/\{token\}/g, token)
      tokenReplaced = true
    }
    if (!tokenReplaced && finalUrl.includes('{{token}}')) {
      warnings.push('Token was not replaced — {{token}} still in URL')
      finalUrl = normalizeUrl(finalUrl.replace('{{token}}', ''))
    }
    if (!tokenReplaced && finalUrl.includes('{token}')) {
      warnings.push('Token was not replaced — {token} still in URL')
      finalUrl = normalizeUrl(finalUrl.replace(/\{token\}/g, ''))
    }

    if (finalUrl.match(/:\/\/[^/]+\/\//)) warnings.push('Final URL contains double slash')

    const safeUrl = maskTokenInUrl(finalUrl, token)
    const safePath = maskTokenInUrl(path, token)
    const headersUsed: Record<string, string> = { ...(opts?.headers || {}) }
    if (method !== 'GET') headersUsed['Content-Type'] = 'application/json'
    const authHeaderPresent = Object.keys(headersUsed).some(k => k.toLowerCase() === 'authorization')

    const start = Date.now()
    let { status, contentType, body, error } = await diagnoseFetch(finalUrl, {
      method,
      headers: Object.keys(headersUsed).length > 0 ? headersUsed : undefined,
      body: opts?.body,
      timeoutMs: requestTimeoutMs,
    })
    const latencyMs = Date.now() - start

    let retryAttempted = false
    let retryExplanation: string | null = null

    // If first request failed with network error, retry with normalized URL
    if (error && (error.code === 'NETWORK_ERROR' || error.code === 'NETWORK_ERROR_DNS' || error.code === 'NETWORK_ERROR_REFUSED' || error.code === 'NETWORK_ERROR_TIMEOUT' || error.code === 'NETWORK_ERROR_TLS' || error.code === 'TIMEOUT')) {
      retryAttempted = true
      const retryStart = Date.now()
      const retryResult = await diagnoseFetch(finalUrl, {
        method,
        headers: Object.keys(headersUsed).length > 0 ? headersUsed : undefined,
        body: opts?.body,
        timeoutMs: requestTimeoutMs * 2,
      })
      if (retryResult.error) {
        const retryClass = classifyError(retryResult.error)
        if (retryClass === 'HTTP_404') {
          retryExplanation = 'Provider became reachable, but endpoint path is not valid.'
          error = { code: 'HTTP_404', message: retryExplanation }
          status = retryResult.status
          contentType = retryResult.contentType
          body = retryResult.body
        } else if (retryClass === 'HTTP_400') {
          retryExplanation = 'Provider became reachable, but request was rejected (check credentials/format).'
          error = { code: 'HTTP_400', message: retryExplanation }
          status = retryResult.status
          contentType = retryResult.contentType
          body = retryResult.body
        } else {
          retryExplanation = `Retry failed with same error: ${retryResult.error.message?.substring(0, 100)}`
        }
      } else {
        retryExplanation = 'Provider became reachable after retry.'
        error = undefined
        status = retryResult.status
        contentType = retryResult.contentType
        body = retryResult.body
      }
    }

    const classification = error ? classifyError(error, warnings) : null

    if (classification === 'NON_JSON_RESPONSE' && body) {
      const isHtml = isHtmlBody(body)
      if (isHtml) {
        if (status) {
          error = { code: 'HTTP_404', message: `HTML response — endpoint not found (status ${status})` }
          warnings.push('Provider returned HTML instead of JSON — likely wrong endpoint path')
        }
      }
    }

    if (classification === 'HTTP_404' && body && isHtmlBody(body)) {
      warnings.push('Response body is HTML — expected JSON. Endpoint path may be wrong.')
    }

    // Sanitize body preview (escape HTML entities)
    const sanitizedBody = body ? escapeHtml(body.substring(0, 300)) : null

    return {
      success: !error,
      data: {
        connectorClass, method, baseUrl, authUrl, path: safePath, finalUrl: safeUrl,
        tokenPlacement, authType, authHeaderPresent, tokenReplaced,
        responseStatus: status, responseContentType: contentType,
        responseBody: sanitizedBody,
        latencyMs, warnings,
        errorClassification: classification,
        requestTimeoutMs,
        retryAttempted,
        retryExplanation,
      },
      error: error || undefined,
    }
  }

  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const { data, error } = await fetchJson(this.baseUrl('/plans'), { headers: this.headers })
    if (error) return { success: false, error }
    const items = this.extractList(data, 'data')
    if (!Array.isArray(items)) return { success: false, error: { code: 'INVALID_RESPONSE', message: 'Plans response did not contain an array' } }
    const plans: ConnectorPlan[] = items.map((item: any) => this.mapPlan(item))
    return { success: true, data: plans }
  }

  async activateESIM(_params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Activate not implemented for REST catalog connector' } }
  }

  async getStatus(_subscriptionId: string): Promise<ConnectorResult<StatusResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Status not implemented for REST catalog connector' } }
  }

  async getUsage(_iccid: string): Promise<ConnectorResult<UsageResult>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Usage not supported' } }
  }

  async suspendESIM(_subscriptionId: string): Promise<ConnectorResult<void>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Suspend not supported' } }
  }

  async resumeESIM(_subscriptionId: string): Promise<ConnectorResult<void>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Resume not supported' } }
  }

  async getRates(): Promise<ConnectorResult<RateResult[]>> {
    return { success: true, data: [] }
  }

  async getQRCode(_iccid: string): Promise<ConnectorResult<{ qrCodeUrl: string }>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'QR code not supported' } }
  }

  async topUpESIM(_params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Top-up not supported by this connector' } }
  }

  protected extractList(data: any, listKey: string): any[] {
    if (Array.isArray(data)) return data
    const resp = data?.response
    if (resp?.data) {
      if (Array.isArray(resp.data)) return resp.data
      if (typeof resp.data === 'object' && listKey && Array.isArray(resp.data[listKey])) return resp.data[listKey]
    }
    const pathResult = this.extractByPath(data, listKey)
    if (Array.isArray(pathResult)) return pathResult
    if (typeof data === 'object') {
      const firstArr = Object.values(data).find(v => Array.isArray(v))
      if (firstArr) return firstArr as any[]
    }
    return []
  }

  protected extractByPath(obj: any, path: string): any {
    return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj)
  }

  protected mapPlan(item: any): ConnectorPlan {
    const sku = item.sku || item.bundle_code || item.bundleCode || item.id || ''
    const id = item.providerPlanId || sku || item.id || ''
    const name = item.name || item.bundle_name || item.bundleName || item.planName || ''
    const allowance = parseFloat(item.dataGB ?? item.data_gb ?? item.rate_group_allowance ?? 0)
    const unit = (item.dataUnit || item.rate_group_allow_qtyp || 'GB').toUpperCase()
    const dataGB = unit === 'GB' ? allowance : unit === 'MB' ? Math.round(allowance / 1024) : allowance
    const days = parseInt(item.validity_days ?? item.validityDays ?? item.rate_group_allow_days ?? 30)
    const price = parseFloat(item.price_usd ?? item.priceUSD ?? item.price ?? 0)
    return {
      id: String(id), name: String(name), data_gb: Math.max(1, dataGB || 1),
      validity_days: Math.max(1, days || 30), price_usd: price, currency: 'USD',
      sku: String(sku || id), raw_data: item,
    }
  }
}
