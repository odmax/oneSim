import { decryptToken } from '@/lib/encryption'
import type {
  ProviderAdapter, ProviderResult, ProviderPlan,
  ActivateESIMParams, ActivateESIMResult, UsageResult, RateResult,
  TopUpESIMParams, TopUpESIMResult,
  CredentialField, ProviderCapability, AuthResult,
  WebhookPayload,
} from './adapter-types'

interface ProviderRecord {
  id: string
  name?: string
  code?: string
  type: string
  adapterStrategy?: string | null
  apiBaseUrl?: string | null
  authUrl?: string | null
  apiToken?: string | null
  tokenPlacement?: string | null
  planListPath?: string | null
  activationPath?: string | null
  statusPath?: string | null
  usagePath?: string | null
  suspendPath?: string | null
  resumePath?: string | null
  responseListKey?: string | null
  fieldMappings?: any
  authType?: string | null
  config?: any
  environment?: string | null
}

function resolvePath(path: string, token: string, baseUrl: string): string {
  let resolved = path.replace(/\{token\}/g, token).replace(/\{baseUrl\}/g, baseUrl)
  if (!resolved.startsWith('http')) resolved = `${baseUrl.replace(/\/$/, '')}/${resolved.replace(/^\//, '')}`
  return resolved
}

function extractByPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj)
}

function resolveToken(token: string | null | undefined, placement: string | null | undefined): string {
  return token || ''
}

export class GenericProtocolAdapter implements ProviderAdapter {
  readonly providerId: string
  readonly name: string
  private provider: ProviderRecord
  private token: string
  private timeoutMs = 15000

  constructor(provider: ProviderRecord) {
    this.provider = provider
    this.providerId = provider.id
    this.name = provider.name || provider.code || 'Generic'
    this.token = decryptToken(provider.apiToken) || ''
  }

  setApiKey(token: string): void {
    this.token = token
  }

  getCredentialFields(): CredentialField[] {
    const p = this.provider
    if (p.authUrl) {
      return [
        { name: 'username', label: 'Username / Email', type: 'text', required: true, placeholder: 'API username' },
        { name: 'password', label: 'Password', type: 'password', required: true, placeholder: 'API password' },
        { name: 'environment', label: 'Environment', type: 'select', required: false, placeholder: 'Select environment', options: [{ value: 'staging', label: 'Staging' }, { value: 'production', label: 'Production' }] },
      ]
    }
    return [
      { name: 'apiToken', label: 'API Token / Secret', type: 'password', required: true, placeholder: 'Provider API token' },
      { name: 'apiBaseUrl', label: 'API Base URL', type: 'text', required: true, placeholder: 'https://api.provider.com' },
    ]
  }

  getCapabilities(): ProviderCapability[] {
    const p = this.provider
    return [
      { key: 'eSIM', label: 'eSIM Activation', supported: !!p.activationPath },
      { key: 'QR', label: 'QR Code', supported: false },
      { key: 'Usage', label: 'Usage Tracking', supported: !!p.usagePath },
      { key: 'SuspendResume', label: 'Suspend / Resume', supported: !!(p.suspendPath && p.resumePath) },
      { key: 'TopUp', label: 'Top-Up', supported: false },
      { key: 'Pooling', label: 'Pooling', supported: false },
      { key: 'Webhooks', label: 'Webhook Push', supported: false },
    ]
  }

  async authenticate(credentials: Record<string, string>): Promise<ProviderResult<AuthResult>> {
    // If authUrl is configured and username/password provided, do SOAP-based authentication
    const authUrl = credentials.authUrl || this.provider.authUrl
    const username = credentials.username
    const password = credentials.password
    if (authUrl && username && password) {
      return this.soapAuthenticate(authUrl, username, password, credentials.environment)
    }

    // Passthrough for simple token-based auth
    return {
      success: true,
      data: { token: credentials.apiToken || credentials.token || this.token, accountInfo: { credentials } },
    }
  }

  private async soapAuthenticate(
    authUrl: string,
    username: string,
    password: string,
    environment?: string,
  ): Promise<ProviderResult<AuthResult>> {
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getaccounts xmlns="http://tempuri.org/">
      <strUserName>${username}</strUserName>
      <strPassword>${password}</strPassword>
    </getaccounts>
  </soap:Body>
</soap:Envelope>`

    const startMs = Date.now()

    try {
      const res = await fetch(authUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': '"http://tempuri.org/getaccounts"',
        },
        body: soapEnvelope,
      })

      const xml = await res.text()
      const accounts = this.parseGetAccountsResponse(xml)
      const firstAccount = accounts.length > 0 ? accounts[0] : null

      if (!firstAccount) {
        return {
          success: false,
          error: { code: 'AUTH_FAILED', message: 'No accounts returned — bad credentials?' },
        }
      }

      return {
        success: true,
        data: {
          token: firstAccount.token,
          accountInfo: {
            accounts,
            account: firstAccount,
            user: {
              userId: firstAccount.userId,
              uaid: firstAccount.uaid,
            },
          },
        },
      }
    } catch (e: any) {
      return {
        success: false,
        error: { code: 'AUTH_NETWORK_ERROR', message: `SOAP auth failed: ${e.message}` },
      }
    }
  }

  private parseGetAccountsResponse(xml: string): Array<{
    account: string
    accountName: string
    token: string
    uaid: string
    userId: string
  }> {
    const accounts: Array<{ account: string; accountName: string; token: string; uaid: string; userId: string }> = []
    const accountBlocks = xml.split(/<Account[ >]/i).slice(1)

    for (const block of accountBlocks) {
      const endTag = block.indexOf('</Account>')
      const content = endTag > -1 ? block.substring(0, endTag) : block

      const extract = (tag: string): string => {
        const match = content.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'))
        return match ? match[1].trim() : ''
      }

      const account = extract('Account')
      const accountName = extract('AccountName') || extract('Name')
      const uaid = extract('UAID') || extract('Uaid')
      const token = extract('Token') || extract('token')
      const userId = extract('UserId') || extract('UserID')

      if (account || token) {
        accounts.push({ account, accountName, uaid, userId, token })
      }
    }

    return accounts
  }

  async testConnection(): Promise<ProviderResult<{ message: string; latencyMs?: number }>> {
    const result = await this.syncPlans()
    if (!result.success) return { success: false, error: result.error }
    return {
      success: true,
      data: { message: `Connected. ${(result.data || []).length} plans found.`, latencyMs: 0 },
    }
  }

  async syncPlans(): Promise<ProviderResult<ProviderPlan[]>> {
    const p = this.provider
    const planListPath = p.planListPath || '/plans'
    const baseUrl = p.apiBaseUrl || ''
    const token = this.token
    const tokenPlacement = p.tokenPlacement || 'URL_PATH'

    if (!baseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }

    const url = this.buildRequestUrl(planListPath, baseUrl, token, tokenPlacement)
    const headers: Record<string, string> = {}
    this.applyTokenHeaders(headers, token, tokenPlacement)

    const { data, error, status, contentType } = await this.rawFetch(url, { headers })

    if (error) return { success: false, error }
    if (!data) return { success: false, error: { code: 'EMPTY_RESPONSE', message: 'Empty response from provider' } }

    const listKey = p.responseListKey || 'data'
    const items = this.extractList(data, listKey)

    if (!Array.isArray(items)) {
      return { success: false, error: { code: 'INVALID_RESPONSE', message: `Response key "${listKey}" did not yield an array` } }
    }

    const fieldMap = (p.fieldMappings || {}) as Record<string, string>
    const plans: ProviderPlan[] = items.map((item: any) => this.mapFields(item, fieldMap))

    return { success: true, data: plans }
  }

  async activateESIM(_params: ActivateESIMParams): Promise<ProviderResult<ActivateESIMResult>> {
    const path = this.provider.activationPath
    if (!path) return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Activation not supported by this provider' } }
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Generic activation not yet implemented' } }
  }

  async getActivationStatus(_activationId: string): Promise<ProviderResult<{ status: string; iccids?: string[] }>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented for generic adapter' } }
  }

  async suspendESIM(_subscriptionId: string): Promise<ProviderResult<void>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Suspend not supported by this provider' } }
  }

  async resumeESIM(_subscriptionId: string): Promise<ProviderResult<void>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Resume not supported by this provider' } }
  }

  async getUsage(_iccid: string): Promise<ProviderResult<UsageResult>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Usage tracking not supported by this provider' } }
  }

  async getRates(): Promise<ProviderResult<RateResult[]>> {
    return { success: true, data: [] }
  }

  async getQRCode(_iccid: string): Promise<ProviderResult<{ qrCodeUrl: string }>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'QR code not supported by this provider' } }
  }

  async topUpESIM(_params: TopUpESIMParams): Promise<ProviderResult<TopUpESIMResult>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Top-up not supported by this provider' } }
  }

  async handleWebhook(_payload: WebhookPayload): Promise<ProviderResult<{ handled: boolean; action?: string }>> {
    return { success: true, data: { handled: true, action: 'acknowledged' } }
  }

  // ─── Internal helpers ──────────────────────────────────────────

  private buildRequestUrl(path: string, baseUrl: string, token: string, placement: string): string {
    const finalPath = placement === 'URL_PATH' ? path.replace(/\{token\}/g, token) : path
    if (finalPath.startsWith('http')) return finalPath
    return `${baseUrl.replace(/\/$/, '')}/${finalPath.replace(/^\//, '')}`
  }

  private applyTokenHeaders(headers: Record<string, string>, token: string, placement: string): void {
    switch (placement) {
      case 'BEARER_HEADER':
        headers['Authorization'] = `Bearer ${token}`
        break
      case 'API_KEY_HEADER':
        headers['X-API-Key'] = token
        break
      case 'BASIC_AUTH':
        headers['Authorization'] = `Basic ${Buffer.from(`:${token}`).toString('base64')}`
        break
    }
  }

  private extractList(data: any, listKey: string): any[] {
    if (Array.isArray(data)) return data

    const resp = data?.response
    if (resp?.data) {
      if (Array.isArray(resp.data)) return resp.data
      if (typeof resp.data === 'object') {
        const fromKey = listKey
        if (fromKey && Array.isArray(resp.data[fromKey])) return resp.data[fromKey]
        const firstArr = Object.values(resp.data).find(v => Array.isArray(v))
        if (firstArr) return firstArr as any[]
      }
    }

    const pathResult = extractByPath(data, listKey)
    if (Array.isArray(pathResult)) return pathResult

    if (typeof data === 'object') {
      const firstArr = Object.values(data).find(v => Array.isArray(v))
      if (firstArr) return firstArr as any[]
    }

    return []
  }

  private mapFields(item: any, fieldMap: Record<string, string>): ProviderPlan {
    const get = (key: string) => {
      const field = fieldMap[key]
      return field ? extractByPath(item, field) ?? item[key] ?? item[field] : item[key] ?? item[field]
    }

    const sku = get('sku') || item.bundle_code || item.bundleCode || item.sku || item.id || ''
    const id = get('providerPlanId') || sku || item.id || item.bundle_template_id || ''
    const name = get('name') || item.bundle_name || item.bundleName || item.name || item.planName || ''
    const allowance = parseFloat(get('dataAllowance') ?? item.rate_group_allowance ?? item.dataGB ?? item.data_gb ?? 0)
    const unit = (get('dataUnit') || item.rate_group_allow_qtyp || 'GB').toUpperCase()
    const dataGB = unit === 'GB' ? allowance : unit === 'MB' ? Math.round(allowance / 1024) : allowance
    const days = parseInt(get('validityDays') ?? item.rate_group_allow_days ?? item.validity_days ?? item.validityDays ?? 30)
    const version = get('templateVersion') || item.template_version || item.templateVersion || ''
    const price = parseFloat(get('price_usd') ?? item.price_usd ?? item.priceUSD ?? item.price ?? 0)

    return {
      id: String(id),
      name: String(name),
      data_gb: Math.max(1, dataGB || 1),
      validity_days: Math.max(1, days || 30),
      price_usd: price,
      currency: 'USD',
      sku: String(sku || id),
      templateVersion: String(version),
      raw_data: item,
    }
  }

  private async rawFetch(
    url: string,
    opts?: { headers?: Record<string, string>; method?: string; body?: string }
  ): Promise<{ data?: any; error?: { code: string; message: string }; status?: number; contentType?: string }> {
    const method = opts?.method || 'GET'
    const safeUrl = url.replace(/\/[A-Za-z0-9+/=_-]{20,}([?\s]|$)/g, '/••••••$1')

    console.error(`[GenericProtocolAdapter] ${method} ${safeUrl}`)
    console.error(`[GenericProtocolAdapter] Provider: ${this.name} (${this.providerId})`)
    console.error(`[GenericProtocolAdapter] Strategy: ${this.provider.adapterStrategy || this.provider.type}`)

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
        body: opts?.body,
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      const contentType = response.headers.get('content-type') || ''
      const status = response.status
      let rawBody: string

      if (contentType.includes('json')) {
        rawBody = JSON.stringify(await response.json())
      } else {
        rawBody = await response.text()
      }

      console.error(`[GenericProtocolAdapter] Status: ${status}`)
      console.error(`[GenericProtocolAdapter] Content-Type: ${contentType}`)
      console.error(`[GenericProtocolAdapter] Response length: ${rawBody.length}`)

      if (!response.ok) {
        if (status === 401) return { error: { code: 'TOKEN_EXPIRED', message: 'Token expired or invalid' }, status, contentType }
        return { error: { code: `HTTP_${status}`, message: `HTTP ${status}: ${rawBody.substring(0, 200)}` }, status, contentType }
      }

      if (!contentType.includes('json')) {
        console.error(`[GenericProtocolAdapter] Non-JSON response: ${rawBody.substring(0, 200)}`)
        return { data: null, status, contentType }
      }

      let data: any
      try { data = JSON.parse(rawBody) } catch {
        return { error: { code: 'INVALID_JSON', message: 'Invalid JSON response' }, status, contentType }
      }

      const respKeys = data ? Object.keys(data) : []
      console.error(`[GenericProtocolAdapter] Top-level response keys: ${respKeys.join(', ')}`)

      return { data, status, contentType }
    } catch (error: any) {
      if (error.name === 'AbortError') return { error: { code: 'TIMEOUT', message: 'Request timed out' } }
      console.error(`[GenericProtocolAdapter] Fetch error: ${error.message}`)
      return { error: { code: 'NETWORK_ERROR', message: error.message } }
    }
  }
}
