import type { IProviderConnector, ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, TopUpESIMParams, TopUpESIMResult, StatusResult, UsageResult, RateResult, DiagnosticInfo, EsimLifecycleResult, ConnectorCapabilities } from './connector-interface'
import { classifyError, classifyPurchaseWithoutIccid } from './connector-interface'

interface StandardConnectorConfig {
  providerId: string
  name?: string
  apiBaseUrl: string
  apiToken?: string
  authUrl?: string
  environment?: string
  planListPath?: string
  activationPath?: string
  statusPath?: string
  usagePath?: string
  suspendPath?: string
  resumePath?: string
  responseListKey?: string
  fieldMappings?: Record<string, string>
  endpointMappings?: Record<string, { method?: string; path?: string; body?: any }>
  requestMappings?: Record<string, any>
  config?: any
  tokenPlacement?: string
  authType?: string
}

async function apiFetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ data?: any; error?: { code: string; message: string }; status?: number }> {
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
    try { data = JSON.parse(text) } catch { return { error: { code: 'NON_JSON_RESPONSE', message: 'Non-JSON response' }, status } }
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

export class StandardProviderConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string
  private config: StandardConnectorConfig

  constructor(config: StandardConnectorConfig) {
    this.providerId = config.providerId
    this.name = config.name || 'Standard Provider'
    this.config = config
  }

  /**
   * Capabilities derived from the configured paths (Part 10): a capability is
   * supported only when the provider instance actually has a path for it.
   * Never enabled merely because the method exists.
   */
  get capabilities(): ConnectorCapabilities {
    return {
      installationLookup: false,
      installationDataAtPurchase: !!this.config.activationPath,
      installationLookupHistorical: false,
      statusLookup: !!this.config.statusPath,
      usageLookup: !!this.config.usagePath,
      topUp: false,
      suspend: !!this.config.suspendPath,
      resume: !!this.config.resumePath,
      balance: false,
      inventory: !!this.config.planListPath,
      catalogSync: !!this.config.planListPath,
      webhooks: false,
    }
  }

  async getTokenState(): Promise<import('./connector-interface').TokenState> {
    return { tokenPresent: !!this.config.apiToken, expiryPresent: false, expired: false, expiresSoon: false, tokenExpiry: null }
  }

  async ensureAuthenticated(): Promise<ConnectorResult<void>> {
    if (this.config.apiToken) return { success: true }
    return { success: false, error: { code: 'NO_TOKEN', message: 'No token. Authenticate first.' } }
  }

  async refreshAuthentication(): Promise<boolean> {
    return false
  }

  private get headers(): Record<string, string> {
    const token = this.config.apiToken
    const placement = this.config.tokenPlacement || 'HEADER'
    const authType = this.config.authType || 'bearer_token'
    if (placement === 'HEADER' && token) {
      if (authType === 'api_key') return { 'X-API-Key': token }
      if (authType === 'basic') return { 'Authorization': 'Basic ' + Buffer.from(':' + token).toString('base64') }
      return { 'Authorization': `Bearer ${token}` }
    }
    return {}
  }

  private tokenInPath(path?: string): boolean {
    return this.config.tokenPlacement === 'URL_PATH' && !!this.config.apiToken
  }

  private resolvePath(rawPath: string): string {
    const baseUrl = this.config.apiBaseUrl?.replace(/\/$/, '') || ''
    let path = rawPath
    if (this.tokenInPath()) {
      path = path.replace(/\{\{token\}\}/g, this.config.apiToken || '').replace(/\{token\}/g, this.config.apiToken || '').replace(/\{baseUrl\}/g, baseUrl)
    }
    if (path.startsWith('http')) return path
    return `${baseUrl}/${path.replace(/^\//, '')}`
  }

  private extractList(data: any, listKey?: string): any[] {
    if (Array.isArray(data)) return data
    if (listKey) {
      const parts = listKey.split('.')
      let cursor: any = data
      for (const part of parts) { if (cursor && typeof cursor === 'object') cursor = cursor[part]; else return [] }
      if (Array.isArray(cursor)) return cursor
    }
    const topKey = Object.keys(data || {}).find(k => Array.isArray(data[k]))
    if (topKey) return data[topKey]
    return []
  }

  private resolveTemplate(template: any): any {
    if (typeof template === 'number' || typeof template === 'boolean' || template === null) return template
    if (Array.isArray(template)) return template.map(v => this.resolveTemplate(v))
    if (typeof template === 'string') {
      const match = template.match(/^\{\{(.+?)\}\}$/)
      if (!match) return template
      const inner = match[1]
      const pipeIdx = inner.indexOf('|')
      const expr = pipeIdx >= 0 ? inner.substring(0, pipeIdx) : inner
      const defVal = pipeIdx >= 0 ? inner.substring(pipeIdx + 1) : ''
      const dotIdx = expr.indexOf('.')
      const namespace = dotIdx >= 0 ? expr.substring(0, dotIdx) : null
      const varName = dotIdx >= 0 ? expr.substring(dotIdx + 1) : expr

      let val: any = undefined
      if (namespace === 'config') {
        val = (this.config.config as any)?.[varName]
      }
      if (val == null || val === '') val = defVal
      if (typeof val === 'string' && val.includes(',')) {
        return val.split(',').map((s: string) => s.trim()).filter(Boolean)
      }
      const num = Number(val)
      if (!isNaN(num) && String(val).trim() !== '') return num
      return val ?? defVal
    }
    if (typeof template === 'object') {
      const resolved: any = {}
      for (const [key, value] of Object.entries(template)) {
        resolved[key] = this.resolveTemplate(value)
      }
      return resolved
    }
    return template
  }

  private mapPlan(item: any): ConnectorPlan {
    const fm = this.config.fieldMappings || {}
    const sku = this.resolveField(item, fm.sku || 'sku', '')
    const id = fm.id ? this.resolveField(item, fm.id, '') : sku
    const name = this.resolveField(item, fm.name || 'name', item.name || 'Plan')
    const dataGB = parseFloat(this.resolveField(item, fm.data_gb || 'data_gb', '0'))
    const days = parseInt(this.resolveField(item, fm.validity_days || 'validity_days', '30'))
    const price = parseFloat(this.resolveField(item, fm.price_usd || 'price_usd', '0'))
    return {
      id: String(id || sku), name: String(name),
      data_gb: Math.max(1, dataGB || 1), validity_days: Math.max(1, days || 30),
      price_usd: price || 0, currency: 'USD',
      sku: String(sku || id), raw_data: item,
    }
  }

  private resolveField(obj: any, path: string, fallback: string): string {
    const val = path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj)
    return val !== undefined ? String(val) : fallback
  }

  async authenticate(credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    const authUrl = credentials.authUrl || this.config.authUrl
    const username = credentials.username
    const password = credentials.password
    if (authUrl && username && password) {
      return this.soapAuthenticate(authUrl, username, password)
    }
    const token = credentials.apiToken || this.config.apiToken || ''
    if (!token) return { success: false, error: { code: 'NO_TOKEN', message: 'No API token provided' } }
    return { success: true, data: { token, accountInfo: {} } }
  }

  private async soapAuthenticate(authUrl: string, username: string, password: string): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getaccounts xmlns="http://tempuri.org/">
      <strUserName>${username}</strUserName>
      <strPassword>${password}</strPassword>
    </getaccounts>
  </soap:Body>
</soap:Envelope>`
    try {
      const res = await fetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '"http://tempuri.org/getaccounts"' },
        body: envelope,
      })
      const xml = await res.text()
      const accounts = this.parseSoapAccounts(xml)
      if (accounts.length === 0) return { success: false, error: { code: 'AUTH_FAILED', message: 'No accounts returned from SOAP auth' } }
      return { success: true, data: { token: accounts[0].token, accountInfo: { accounts, account: accounts[0] } } }
    } catch (e: any) {
      return { success: false, error: { code: 'AUTH_NETWORK_ERROR', message: `SOAP auth failed: ${e.message}` } }
    }
  }

  private parseSoapAccounts(xml: string): Array<{ account: string; accountName: string; token: string; uaid: string; userId: string }> {
    const accounts: Array<{ account: string; accountName: string; token: string; uaid: string; userId: string }> = []
    const blocks = xml.split(/<Account[ >]/i).slice(1)
    for (const block of blocks) {
      const end = block.indexOf('</Account>')
      const content = end > -1 ? block.substring(0, end) : block
      const extract = (tag: string): string => { const m = content.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i')); return m ? m[1].trim() : '' }
      const account = extract('Account')
      const accountName = extract('AccountName') || extract('Name')
      const token = extract('Token') || extract('token')
      const uaid = extract('UAID') || extract('Uaid')
      const userId = extract('UserId') || extract('UserID')
      if (account || token) accounts.push({ account, accountName, uaid, userId, token })
    }
    return accounts
  }

  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>> {
    const result = await this.syncPlans()
    if (!result.success) return { success: false, error: result.error }
    return { success: true, data: { message: `Connected. ${result.data?.length || 0} plans found.`, latencyMs: 0 } }
  }

  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    const baseUrl = this.config.apiBaseUrl || ''
    const path = this.config.planListPath || '/plans'
    const requestTimeoutMs = 15000
    const warnings: string[] = []
    const token = this.config.apiToken || ''
    const tokenPlacement = (this.config.tokenPlacement as any) || 'HEADER'
    const authType = this.config.authType || 'bearer_token'

    if (!baseUrl) {
      return {
        success: false,
        data: {
          connectorClass: 'StandardProviderConnector', method: 'GET', baseUrl, authUrl: this.config.authUrl || '',
          path, finalUrl: '—', tokenPlacement, authType, authHeaderPresent: false, tokenReplaced: false,
          responseStatus: null, responseContentType: null, responseBody: null,
          latencyMs: null, warnings: ['API Base URL not configured'],
          errorClassification: 'TOKEN_MISSING', requestTimeoutMs, retryAttempted: false, retryExplanation: null,
        },
        error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' },
      }
    }

    let finalUrl = this.resolvePath(path)
    let tokenReplaced = !!token

    // Replace {{token}} and {token} placeholders
    if (token && (finalUrl.includes('{{token}}') || finalUrl.includes('{token}'))) {
      finalUrl = finalUrl.replace(/\{\{token\}\}/g, token).replace(/\{token\}/g, token)
      tokenReplaced = true
    }
    if (!tokenReplaced && finalUrl.includes('{{token}}')) {
      warnings.push('Token was not replaced — {{token}} still in URL')
      finalUrl = finalUrl.replace('{{token}}', '')
    }
    if (!tokenReplaced && finalUrl.includes('{token}')) {
      warnings.push('Token was not replaced — {token} still in URL')
      finalUrl = finalUrl.replace(/\{token\}/g, '')
    }

    if (this.config.authUrl && baseUrl.replace(/\/$/, '') === this.config.authUrl.replace(/\/$/, '')) warnings.push('You are using Auth URL as Base URL')
    if (!this.config.planListPath) warnings.push('No plan list path configured')
    if (!token) warnings.push('No token found')

    try { new URL(baseUrl) } catch { warnings.push('Base URL is not a valid URL') }

    if (finalUrl.match(/:\/\/[^/]+\/\//)) warnings.push('Final URL contains double slash')

    const safeUrl = token ? finalUrl.replace(token, token.slice(0, 4) + '••••') : finalUrl
    const safePath = token ? path.replace(token, token.slice(0, 4) + '••••') : path
    const authHeaderPresent = !!token && tokenPlacement !== 'URL_PATH'

    const start = Date.now()
    const { data, error, status } = await apiFetch(finalUrl, { headers: this.headers, timeoutMs: requestTimeoutMs })
    const latencyMs = Date.now() - start

    let retryAttempted = false
    let retryExplanation: string | null = null
    let finalError = error
    let finalStatus = status
    let finalData = data

    // Retry on network error
    if (error && (error.code === 'NETWORK_ERROR' || error.code === 'NETWORK_ERROR_DNS' || error.code === 'NETWORK_ERROR_REFUSED' || error.code === 'NETWORK_ERROR_TIMEOUT' || error.code === 'NETWORK_ERROR_TLS' || error.code === 'TIMEOUT')) {
      retryAttempted = true
      const retryResult = await apiFetch(finalUrl, { headers: this.headers, timeoutMs: requestTimeoutMs * 2 })
      if (retryResult.error) {
        const retryClass = classifyError(retryResult.error)
        if (retryClass === 'HTTP_404') {
          retryExplanation = 'Provider became reachable, but endpoint path is not valid.'
          finalError = { code: 'HTTP_404', message: retryExplanation }
          finalStatus = 404
        } else if (retryClass === 'HTTP_400') {
          retryExplanation = 'Provider became reachable, but request was rejected (check credentials/format).'
          finalError = { code: 'HTTP_400', message: retryExplanation }
          finalStatus = retryResult.status
        } else {
          retryExplanation = `Retry failed with same error: ${retryResult.error.message?.substring(0, 100)}`
        }
      } else {
        retryExplanation = 'Provider became reachable after retry.'
        finalError = undefined
        finalStatus = retryResult.status
        finalData = retryResult.data
      }
    }

    const classification = finalError ? classifyError(finalError, warnings) : null
    const bodyPreview = finalError?.message ? escapeHtml(finalError.message.substring(0, 300)) : (finalData ? escapeHtml(JSON.stringify(finalData).substring(0, 300)) : null)

    return {
      success: !finalError,
      data: {
        connectorClass: 'StandardProviderConnector', method: 'GET', baseUrl, authUrl: this.config.authUrl || '',
        path: safePath, finalUrl: safeUrl, tokenPlacement, authType, authHeaderPresent, tokenReplaced,
        responseStatus: finalStatus || null,
        responseContentType: null,
        responseBody: bodyPreview,
        latencyMs, warnings,
        errorClassification: classification,
        requestTimeoutMs,
        retryAttempted,
        retryExplanation,
      },
      error: finalError || undefined,
    }
  }

  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    const path = this.config.planListPath
    if (!path) return { success: false, error: { code: 'NO_PATH', message: 'Plan list path not configured' } }

    // Resolve method and body from endpointMappings + requestMappings
    const ep = (this.config.endpointMappings || {}) as Record<string, any>
    const planEp = ep.GET_PLANS || ''
    const method = typeof planEp === 'string' && planEp.startsWith('POST') ? 'POST'
      : typeof planEp === 'object' && planEp.method ? planEp.method
      : 'GET'

    let body: string | undefined
    const rm = (this.config.requestMappings || {}) as Record<string, any>
    if (rm.GET_PLANS) {
      const resolved = this.resolveTemplate(rm.GET_PLANS)
      body = JSON.stringify(resolved)
      console.log(`[StandardConnector.syncPlans] configKeys=${Object.keys(this.config.config || {}).join(',')} partnerCode=${(this.config.config as any)?.partnerCode}`)
      console.log(`[StandardConnector.syncPlans] POST body: ${body.substring(0, 300)}`)
    }

    const { data, error } = await apiFetch(this.resolvePath(path), { method, headers: this.headers, body })
    if (error) return { success: false, error }
    const items = this.extractList(data, this.config.responseListKey)
    if (!Array.isArray(items)) return { success: false, error: { code: 'INVALID_RESPONSE', message: 'Plan list response did not contain an array' } }
    return { success: true, data: items.map((item: any) => this.mapPlan(item)) }
  }

  async activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    const path = this.config.activationPath
    if (!path) return { success: false, error: { code: 'NO_PATH', message: 'Activation path not configured' } }
    const ep = this.config.endpointMappings?.activate || {}
    const method = ep.method || 'POST'
    const body = JSON.stringify({
      sku: params.planId,
      email: params.subscriber.email,
      quantity: params.quantity,
      ...(ep.body || {}),
    })
    const { data, error } = await apiFetch(this.resolvePath(path), { method, headers: this.headers, body })
    if (error) return { success: false, error }
    const fm = this.config.fieldMappings || {}
    const iccidField = fm.iccid || 'iccid'
    const activationId = data.transaction_id || data.order_id || data.id || ''
    const iccids: string[] = data[iccidField] ? [String(data[iccidField])] : (Array.isArray(data.iccids) ? data.iccids.map(String) : [])

    if (iccids.length === 0) {
      const outcome = classifyPurchaseWithoutIccid(data.status, activationId)
      if (outcome.kind === 'PENDING') {
        return { success: true, data: { activationId: outcome.providerOrderId, iccids: [], status: outcome.status } }
      }
      if (outcome.kind === 'DEFINITIVE') {
        return { success: false, error: { code: 'NO_ICCIDS', message: `Provider reported purchase status ${data.status} without ICCIDs` } }
      }
      return {
        success: false,
        error: {
          code: 'NO_ICCIDS',
          message: 'Provider accepted the purchase but returned no ICCID — outcome is ambiguous and requires reconciliation',
          details: { retryable: false, ambiguous: true, upstreamConfirmed: true, ...(outcome.providerOrderId ? { providerOrderId: outcome.providerOrderId } : {}) },
        },
      }
    }

    return {
      success: true,
      data: {
        activationId,
        iccids,
        qrCodeUrl: data.qr_code_url || data.qrCodeUrl || '',
        status: data.status || 'ACTIVATED',
      },
    }
  }

  async getStatus(subscriptionId: string): Promise<ConnectorResult<StatusResult>> {
    const path = this.config.statusPath
    if (!path) return { success: false, error: { code: 'NO_PATH', message: 'Status path not configured' } }
    const resolved = this.resolvePath(path).replace(/\{subscriptionId\}/g, subscriptionId).replace(/\{id\}/g, subscriptionId)
    const { data, error } = await apiFetch(resolved, { headers: this.headers })
    if (error) return { success: false, error }
    return { success: true, data: { status: data.status || 'UNKNOWN', iccid: data.iccid || '', iccids: data.iccid ? [data.iccid] : [] } }
  }

  async getUsage(iccid: string): Promise<ConnectorResult<UsageResult>> {
    const path = this.config.usagePath
    if (!path) return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Usage path not configured' } }
    const resolved = this.resolvePath(path).replace(/\{iccid\}/g, iccid)
    const { data, error } = await apiFetch(resolved, { headers: this.headers })
    if (error) return { success: false, error }
    return { success: true, data: { iccid, dataUsedMB: data.data_used_mb || data.dataUsedMB || 0, timestamp: data.timestamp || '' } }
  }

  async suspendESIM(subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    const path = this.config.suspendPath
    if (!path) return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Suspend path not configured' } }
    const resolved = this.resolvePath(path).replace(/\{subscriptionId\}/g, subscriptionId).replace(/\{id\}/g, subscriptionId)
    const { error } = await apiFetch(resolved, { method: 'POST', headers: this.headers })
    if (error) return { success: false, error }
    return { success: true, data: { status: 'SUSPENDED', providerStatus: 'suspended' } }
  }

  async resumeESIM(subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    const path = this.config.resumePath
    if (!path) return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Resume path not configured' } }
    const resolved = this.resolvePath(path).replace(/\{subscriptionId\}/g, subscriptionId).replace(/\{id\}/g, subscriptionId)
    const { error } = await apiFetch(resolved, { method: 'POST', headers: this.headers })
    if (error) return { success: false, error }
    return { success: true, data: { status: 'ACTIVE', providerStatus: 'active' } }
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
}
