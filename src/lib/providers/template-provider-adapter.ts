import { prisma } from '@/lib/prisma'
import type { ProviderAdapter, ProviderPlan, ProviderResult } from './adapter-types'
import type { IProviderConnector, ConnectorPlan } from './connectors/connector-interface'

interface EndpointConfig {
  method: string
  path: string
}

// Global capability aliases: canonical name → alternative keys to try
const CAPABILITY_ALIASES: Record<string, string[]> = {
  GET_WALLET: ['WALLET_BALANCE'],
  GET_COUNTRIES: ['COUNTRY_REGION_DETAILS'],
  GET_STATUS: ['GET_ESIM_STATUS'],
  GET_USAGE: ['USAGE'],
}
// Build reverse map: alias → canonical
const ALIAS_TO_CANONICAL: Record<string, string> = {}
for (const [canonical, aliases] of Object.entries(CAPABILITY_ALIASES)) {
  for (const alias of aliases) ALIAS_TO_CANONICAL[alias] = canonical
}

function resolveAlias(capability: string): string {
  return ALIAS_TO_CANONICAL[capability] || capability
}

function resolveEndpoint(mappings: Record<string, string> | null | undefined, capability: string, defaultPath?: string | null): EndpointConfig | null {
  // Try exact key first, then aliases
  const keys = [capability, ...(CAPABILITY_ALIASES[capability] || [])]
  for (const key of keys) {
    const entry = mappings?.[key]
    if (entry) {
      const parts = entry.split(' ')
      if (parts.length === 2) return { method: parts[0].toUpperCase(), path: parts[1] }
      return { method: 'POST', path: entry }
    }
  }
  if (defaultPath) return { method: 'POST', path: defaultPath }
  return null
}

function buildUrl(baseUrl: string, path: string): string {
  if (path.startsWith('http')) return path
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

function applyAuthHeaders(headers: Record<string, string>, token: string | null, tokenPlacement: string, authType: string): void {
  if (!token) return
  switch (tokenPlacement) {
    case 'BEARER_HEADER':
      headers['Authorization'] = `Bearer ${token}`; break
    case 'API_KEY_HEADER':
      headers['X-API-Key'] = token; break
    case 'BASIC_AUTH':
      headers['Authorization'] = `Basic ${Buffer.from(`:${token}`).toString('base64')}`; break
  }
}

function extractToken(data: any, tokenPath?: string): string | null {
  if (tokenPath) {
    const parts = tokenPath.split('.')
    let current = data
    for (const p of parts) { if (current) current = current[p] }
    return current ? String(current) : null
  }
  return data.token || data.accessToken || data.access_token
    || data.data?.token || data.data?.access_token
    || data.response?.token || data.result?.access_token
    || data.result?.token || null
}

function findFirstArray(obj: any, depth = 0, maxDepth = 5): any[] | null {
  if (depth > maxDepth) return null
  if (Array.isArray(obj)) return obj
  if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) {
      if (Array.isArray(val)) return val
      const found = findFirstArray(val, depth + 1, maxDepth)
      if (found) return found
    }
  }
  return null
}

function extractList(data: any, listKey?: string): any[] {
  if (Array.isArray(data)) return data
  if (listKey) {
    const parts = listKey.split('.')
    let current = data
    for (const p of parts) { if (current) current = current[p] }
    if (Array.isArray(current)) return current
  }
  const resp = data?.response
  if (resp?.data) {
    if (Array.isArray(resp.data)) return resp.data
    const firstArr = Object.values(resp.data).find(v => Array.isArray(v))
    if (firstArr) return firstArr as any[]
  }
  const firstArr = Object.values(data).find(v => Array.isArray(v))
  if (firstArr) return firstArr as any[]
  // Recursive search into nested objects (handles { isSuccess, data: { plans: [...] } })
  const deepArr = findFirstArray(data)
  if (deepArr) return deepArr
  return []
}

async function rawFetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ data?: any; error?: { code: string; message: string }; status?: number }> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    const response = await fetch(url, {
      method: opts?.method || 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
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
    return { error: { code: 'NETWORK_ERROR', message: e.message } }
  }
}

export class TemplateProviderAdapter implements ProviderAdapter {
  readonly providerId: string
  readonly name: string
  private token: string | null = null
  private provider: any
  private config: any

  constructor(provider: any) {
    this.providerId = provider.id
    this.name = provider.name || provider.code || 'Template Provider'
    this.provider = provider
    this.config = (provider.config || {}) as Record<string, any>
  }

  private get endpointMappings(): Record<string, string> | null {
    return this.provider.endpointMappings || this.config?.endpointMappings || null
  }

  private get baseUrl(): string {
    return this.provider.apiBaseUrl || ''
  }

  private get tokenPlacement(): string {
    return this.provider.tokenPlacement || 'BEARER_HEADER'
  }

  private getField(path?: string): any {
    if (!path) return undefined
    const parts = path.split('.')
    let current = this.config
    for (const p of parts) { if (current) current = current[p]; else return undefined }
    return current
  }

  /**
   * Build request body for a capability using requestMappings with variable substitution.
   * Supports {{variableName}} and {{variableName|defaultValue}} syntax.
   * Variables are resolved from: provider.config, provider record fields, environment.
   */
  private buildRequestBody(capability: string): any {
    const reqMap = this.provider.requestMappings || {}
    const mapping = reqMap[capability]
    if (!mapping || typeof mapping !== 'object') return {}

    const resolveVar = (tmpl: string): string | number | boolean => {
      const match = tmpl.match(/^\{\{(.+?)\}\}$/)
      if (!match) return tmpl
      const parts = match[1].split('|')
      const varName = parts[0]
      const defaultValue = parts[1] || ''
      const val = this.config?.[varName]
        ?? this.provider[varName]
        ?? process.env[varName]
        ?? defaultValue
      return val ?? ''
    }

    const resolveValue = (val: any): any => {
      // Preserve number and boolean literals from the mapping
      if (typeof val === 'number') return val
      if (typeof val === 'boolean') return val
      if (Array.isArray(val)) return val.map(v => resolveValue(v))
      // Template variables resolve as strings (from config/form)
      if (typeof val === 'string' && val.match(/^\{\{(.+?)\}\}$/)) return resolveVar(String(val))
      // Static strings passed through
      return String(val)
    }

    const body: any = {}
    for (const [key, val] of Object.entries(mapping)) {
      body[key] = resolveValue(val)
    }
    return body
  }

  private async callCapabilityWithBody(capability: string): Promise<{ data?: any; error?: { code: string; message: string; details?: any } }> {
    const ep = resolveEndpoint(this.endpointMappings, capability)
    if (!ep) return { error: { code: 'NOT_SUPPORTED', message: `Capability ${capability} not configured` } }
    const url = buildUrl(this.baseUrl, ep.path)
    const headers: Record<string, string> = {}
    applyAuthHeaders(headers, this.token, this.tokenPlacement, this.provider.authType || 'bearer_token')
    const body = this.buildRequestBody(capability)
    console.log('[TemplateProviderAdapter] CALL_WITH_BODY', {
      capability,
      url,
      method: ep.method,
      hasToken: !!this.token,
      tokenPlacement: this.tokenPlacement,
      authType: this.provider.authType,
      headers: Object.keys(headers),
      body,
    })
    const fetchOpts: any = { method: ep.method, headers }
    // Only send body for methods that support it
    if (['POST', 'PUT', 'PATCH'].includes(ep.method.toUpperCase())) {
      fetchOpts.body = JSON.stringify(body)
    }
    const result = await rawFetch(url, fetchOpts)
    if (result.error) {
      const responsePreview = result.data ? JSON.stringify(result.data).substring(0, 200) : ''
      return { error: { code: result.error.code, message: `${capability} failed: ${ep.method} ${url} returned ${result.status || 'error'}: ${result.error.message}${responsePreview ? ` | Response: ${responsePreview}` : ''}`, details: { capability, url, method: ep.method, status: result.status, responseBody: responsePreview } } }
    }
    return { data: result.data }
  }

  private async callCapability(capability: string, body?: any): Promise<{ data?: any; error?: { code: string; message: string }; status?: number }> {
    const ep = resolveEndpoint(this.endpointMappings, capability)
    if (!ep) return { error: { code: 'NOT_SUPPORTED', message: `Capability ${capability} not configured for this provider` } }
    const url = buildUrl(this.baseUrl, ep.path)
    const headers: Record<string, string> = {}
    applyAuthHeaders(headers, this.token, this.tokenPlacement, this.provider.authType || 'bearer_token')
    return rawFetch(url, { method: ep.method, headers, body: body ? JSON.stringify(body) : undefined })
  }

  async authenticate(credentials: Record<string, string>): Promise<ProviderResult<{ token: string; accountInfo?: any }>> {
    const ep = resolveEndpoint(this.endpointMappings, 'AUTH_LOGIN', this.provider.authUrl)
    if (!ep) return { success: false, error: { code: 'AUTH_NOT_CONFIGURED', message: 'AUTH_LOGIN not configured' } }

    // Build auth body from requestMappings or default
    const requestMap = this.provider.requestMappings || {}
    const authMapping = requestMap.AUTH_LOGIN

    // Collect credentials from all available sources
    const allCreds: Record<string, string> = {
      ...(this.config?.username ? { username: String(this.config.username) } : {}),
      ...(this.config?.password ? { password: String(this.config.password) } : {}),
      ...(this.provider.username ? { username: this.provider.username } : {}),
      ...(this.provider.password ? { password: this.provider.password } : {}),
      ...credentials,
    }

    console.log(`[TemplateProviderAdapter] Credential keys loaded: ${Object.keys(allCreds).filter(k => k !== 'password' && k !== 'apiKey' && k !== 'apiToken').join(', ')} ${allCreds.password ? '+ password ✓' : 'password ✗'}`)

    // Build body using requestMappings template or defaults
    let body: any
    if (authMapping && typeof authMapping === 'object') {
      body = {}
      for (const [key, val] of Object.entries(authMapping)) {
        const tmpl = String(val)
        if (tmpl.startsWith('{{') && tmpl.endsWith('}}')) {
          const varName = tmpl.slice(2, -2)
          const varValue = allCreds[varName] || allCreds[varName.toLowerCase()] || allCreds[varName.toUpperCase()] || ''
          body[key] = varValue
        } else {
          body[key] = tmpl
        }
      }
    } else {
      // Default body for credentials auth
      if (this.provider.authType === 'credentials') {
        body = { userName: allCreds.username || allCreds.userName || '', password: allCreds.password || '' }
      } else {
        body = { ...allCreds }
      }
    }

    // Validate required fields
    if (!body.userName && !body.username && !body.email && !body.apiKey && !body.apiToken) {
      const missing = !body.userName && !body.username ? 'username' : 'password'
      return { success: false, error: { code: 'MISSING_CREDENTIALS', message: `Missing required provider credentials: ${missing}` } }
    }

    console.log(`[TemplateProviderAdapter] AUTH_LOGIN ${ep.method} ${buildUrl(this.baseUrl, ep.path)} keys=${Object.keys(body).join(',')}`)

    const result = await this.callCapability('AUTH_LOGIN', body)
    if (result.error) return { success: false, error: result.error }
    if (!result.data) return { success: false, error: { code: 'EMPTY_AUTH', message: 'Empty auth response' } }

    // Log auth response structure (no token values)
    const respKeys = Object.keys(result.data)
    const nestedData = result.data?.data ? Object.keys(result.data.data) : []
    const nestedResponse = result.data?.response ? Object.keys(result.data.response) : []
    console.log('[AUTH_RESPONSE]', JSON.stringify({
      status: result.status,
      topKeys: respKeys.filter(k => !['token', 'access_token', 'apiKey', 'apiToken', 'password'].includes(k)),
      dataKeys: nestedData,
      responseKeys: nestedResponse,
    }))

    const tokenPath = this.config?.tokenPath || this.provider.responseMappings?.tokenPath
    const token = extractToken(result.data, tokenPath)

    // Validate token
    if (!token || token.length < 8) {
      const reason = !token ? 'No token found' : `Token too short (${token.length} chars)`
      console.log('[TOKEN_EXTRACT]', JSON.stringify({
        tokenPath: tokenPath || 'undefined (fallback)',
        found: !!token,
        length: token ? token.length : 0,
        topKeys: Object.keys(result.data).filter(k => !['token', 'access_token'].includes(k)),
      }))
      return { success: false, error: { code: 'NO_TOKEN', message: `Authentication succeeded but no valid token was found in response. ${reason}` } }
    }

    console.log('[TOKEN_EXTRACT]', JSON.stringify({
      tokenPath: tokenPath || 'undefined (fallback)',
      found: !!token,
      length: token.length,
    }))

    this.token = token

    // Step 2: If provider requires API key generation (e.g. Rakuten), generate it using the login token
    const genKeyEp = resolveEndpoint(this.endpointMappings, 'GENERATE_API_KEY')
    if (genKeyEp) {
      const clientId = this.config?.clientId || credentials.clientId || ''
      if (!clientId) {
        return { success: false, error: { code: 'MISSING_CLIENT_ID', message: 'Rakuten clientId is required to generate API key.' } }
      }

      console.log(`[TemplateProviderAdapter] GENERATE_API_KEY POST ${buildUrl(this.baseUrl, genKeyEp.path)}`)
      const genResult = await this.callCapability('GENERATE_API_KEY', {
        clientId,
        validityDays: parseInt(this.config?.validityDays || '365'),
        name: this.config?.apiKeyName || 'OneSim Integration',
        purpose: this.config?.purpose || 'OneSim provider integration',
      })

      if (genResult.error) {
        console.log('[GENERATE_API_KEY] Failed:', genResult.error.message)
        // Login token may still work for basic operations — don't fail auth entirely
        return { success: true, data: { token, accountInfo: { ...result.data, _apiKeyGenerationFailed: genResult.error.message } } }
      }

      if (genResult.data) {
        const apiKey = genResult.data.apiKey || genResult.data.result?.apiKey || genResult.data.data?.apiKey || null
        if (apiKey && apiKey.length >= 8) {
          console.log(`[GENERATE_API_KEY] API key generated (${apiKey.length} chars)`)
          this.token = apiKey
          return { success: true, data: { token: apiKey, accountInfo: { ...result.data, _apiKeyGenerated: true, _loginToken: token } } }
        }
        console.log('[GENERATE_API_KEY] Response had no usable apiKey key. Keys:', Object.keys(genResult.data))
      }
    }

    return { success: true, data: { token, accountInfo: result.data } }
  }

  getCredentialFields() { return [] }
  getCapabilities() { return [] }

async testConnection(): Promise<ProviderResult<{ message: string; latencyMs?: number }>> {
  const start = Date.now()
  const authResult = await this.authenticate({})
  if (!authResult.success) return { success: false, error: authResult.error }

  // Try safe read-only capabilities in priority order (with alias fallback via resolveEndpoint)
  const safeCaps = ['GET_PLANS', 'GET_WALLET', 'GET_COUNTRIES']
  let capResult: { data?: any; error?: { code: string; message: string; details?: any } } | null = null

  for (const cap of safeCaps) {
    capResult = await this.callCapabilityWithDetail(cap)
    if (!capResult.error) break
    if (capResult.error.code === 'NOT_SUPPORTED') continue
    // If we got a real HTTP error, include it in the message but try next
  }

  const latencyMs = Date.now() - start

  if (!capResult || capResult.error) {
    const msg = capResult?.error?.message
    if (msg?.includes('NOT_SUPPORTED') || msg?.includes('not configured')) {
      return { success: true, data: { message: 'Authentication passed. No read-only test capability configured.', latencyMs } }
    }
    return { success: true, data: { message: `Authenticated. Capability test: ${msg || 'no capabilities configured'}`, latencyMs } }
  }
  return { success: true, data: { message: 'Connected. Auth + capability test passed.', latencyMs } }
}

private async callCapabilityWithDetail(capKey: string, body?: any): Promise<{ data?: any; error?: { code: string; message: string; details?: any } }> {
  const ep = resolveEndpoint(this.endpointMappings, capKey)
  if (!ep) return { error: { code: 'NOT_SUPPORTED', message: `Capability ${capKey} not configured` } }
  const url = buildUrl(this.baseUrl, ep.path)
  const headers: Record<string, string> = {}
  applyAuthHeaders(headers, this.token, this.tokenPlacement, this.provider.authType || 'bearer_token')

  const result = await rawFetch(url, { method: ep.method, headers, body: body ? JSON.stringify(body) : undefined })
  if (result.error) {
    return { error: { code: result.error.code, message: `${capKey} failed: ${ep.method} ${url} returned ${result.status || 'error'}: ${result.error.message}`, details: { capability: capKey, url, method: ep.method, status: result.status } } }
  }
  return { data: result.data }
}

  async syncPlans(): Promise<ProviderResult<ProviderPlan[]>> {
    // Ensure authenticated
    const authResult = await this.authenticate({})
    if (!authResult.success) return { success: false, error: authResult.error }

    const result = await this.callCapabilityWithBody('GET_PLANS')

    console.log('[GET_PLANS_RESULT]', {
      hasError: !!result.error,
      hasData: !!result.data,
      error: result.error || null,
      dataType: result.data ? typeof result.data : null,
    })
    if (result.data) {
      console.log('[GET_PLANS_RAW]', JSON.stringify(result.data).substring(0, 5000))
    }
    if (result.error) {
      console.log('[GET_PLANS_ERROR]', JSON.stringify(result.error))
    }

    if (result.error) return { success: false, error: result.error }
    if (!result.data) return { success: false, error: { code: 'EMPTY', message: 'Empty plans response' } }

    const listKey = this.provider.responseListKey || this.config?.responseListKey || 'data'
    const ep = this.endpointMappings
    const rm = (this.provider.requestMappings || {}) as any
    console.log('[syncPlans] diag', { listKey, GET_PLANS_EP: ep?.GET_PLANS, hasRM_GET_PLANS: !!rm.GET_PLANS, rawResponseKeys: Object.keys(result.data), responseStatus: 200 })
    console.log('[GET_PLANS_EXTRACT]', { listKey, responseListKey: this.provider.responseListKey })

    const items = extractList(result.data, listKey)
    console.log('[syncPlans] extractedPlans=' + items.length)
    if (items.length > 0) {
      const first = { ...items[0] }
      // Truncate long values for safe logging
      for (const [k, v] of Object.entries(first)) { if (typeof v === 'string' && v.length > 100) first[k] = v.substring(0, 100) + '...' }
      console.log('[syncPlans] firstPlan', JSON.stringify(first).substring(0, 500))
    }
    const fieldMap = (this.provider.fieldMappings || {}) as Record<string, string>

    const plans: ProviderPlan[] = items.map((item: any) => {
      const get = (key: string) => {
        const mapped = fieldMap[key]
        return mapped ? item[mapped] ?? item[key] ?? item[fieldMap[key]] : item[key] ?? item[key]
      }
      // Compute dataGB from data_amount + data_unit (e.g., capacity=50, capacityUnit=GB → 50)
      const dataAmount = get('data_amount') || item.capacity || ''
      const dataUnit = (get('data_unit') || item.capacityUnit || item.rate_group_allow_qtyp || 'GB').toUpperCase()
      const rawGb = parseFloat(get('data_gb') ?? item.rate_group_allowance ?? item.dataGB ?? item.data_gb ?? 0)
      const amountGb = parseFloat(dataAmount) || 0
      const allowance = amountGb > 0 ? amountGb : rawGb
      const dataGB = dataUnit === 'GB' ? allowance : dataUnit === 'MB' ? Math.round(allowance / 1024) : allowance
      return {
        id: String(get('sku') || item.id || item.planCode || item.bundle_template_id || ''),
        name: String(get('name') || item.planName || item.bundle_name || item.name || ''),
        data_gb: Math.max(1, dataGB || 1),
        validity_days: Math.max(1, parseInt(get('validity_days') ?? item.validity ?? item.validityDays ?? item.rate_group_allow_days ?? 30)),
        price_usd: parseFloat(get('price_usd') ?? item.retailPrice ?? item.priceUSD ?? item.price ?? 0),
        currency: item.currency || 'USD',
        description: item.description || item.planDescription || '',
        sku: String(get('sku') || item.planCode || item.sku || item.id || ''),
        raw_data: item,
      }
    })

    return { success: true, data: plans }
  }

  async activateESIM(params: import('./adapter-types').ActivateESIMParams): Promise<ProviderResult<import('./adapter-types').ActivateESIMResult>> {
    const authResult = await this.authenticate({})
    if (!authResult.success) return { success: false, error: authResult.error }

    // Build body from requestMappings, override with standard params
    const reqBody = this.buildRequestBody('PURCHASE_ESIM')
    const body = { ...reqBody, planCode: params.planId, quantity: params.quantity }
    if (params.subscriber.email) body.email = params.subscriber.email

    const ep = resolveEndpoint(this.endpointMappings, 'PURCHASE_ESIM')
    if (!ep) return { success: false, error: { code: 'NOT_SUPPORTED', message: 'PURCHASE_ESIM not configured' } }
    const url = buildUrl(this.baseUrl, ep.path)
    const headers: Record<string, string> = {}
    applyAuthHeaders(headers, this.token, this.tokenPlacement, this.provider.authType || 'bearer_token')

    const result = await rawFetch(url, { method: ep.method, headers, body: JSON.stringify(body) })
    if (result.error) return { success: false, error: result.error }
    if (!result.data) return { success: false, error: { code: 'EMPTY', message: 'Empty purchase response' } }

    const d = result.data
    const iccids: string[] = (() => {
      if (Array.isArray(d.iccids)) return d.iccids
      if (d.iccid) return [d.iccid]
      if (d.data?.iccid) return [d.data.iccid]
      if (d.data?.iccids) return d.data.iccids
      if (d.esim?.iccid) return [d.esim.iccid]
      if (d.order?.iccids) return d.order.iccids
      if (d.result?.iccid) return [d.result.iccid]
      return []
    })()

    if (iccids.length < params.quantity) {
      return { success: false, error: { code: 'NO_ICCIDS', message: `Provider returned ${iccids.length} ICCIDs, need ${params.quantity}` } }
    }

    return {
      success: true,
      data: {
        activationId: d.orderId || d.order_id || d.transactionId || d.id || d.data?.orderId || '',
        iccids,
        imsis: d.imsis || (d.imsi ? [d.imsi] : undefined),
        activationCodes: d.activationCodes || (d.activationCode ? [d.activationCode] : d.data?.activationCode ? [d.data.activationCode] : d.lpa ? [d.lpa] : undefined),
        qrCodeUrl: d.qrCodeUrl || d.qr_code_url || d.data?.qrCodeUrl || d.data?.qr_code_url || undefined,
        status: d.status || d.orderStatus || 'ACTIVATED',
      },
    }
  }

  async getActivationStatus(activationId: string): Promise<ProviderResult<{ status: string; iccids?: string[] }>> {
    const result = await this.callCapability('GET_ORDER_DETAILS', { orderId: activationId })
    if (result.error) return { success: false, error: result.error }
    const d = result.data
    return {
      success: true,
      data: {
        status: d.status || d.orderStatus || d.data?.status || 'UNKNOWN',
        iccids: d.iccids || (d.iccid ? [d.iccid] : undefined),
      },
    }
  }

  async suspendESIM(_subscriptionId: string): Promise<ProviderResult<void>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Suspend not supported by template provider' } }
  }

  async resumeESIM(_subscriptionId: string): Promise<ProviderResult<void>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Resume not supported by template provider' } }
  }

  async getUsage(_iccid: string): Promise<ProviderResult<import('./adapter-types').UsageResult>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Usage not supported by this provider' } }
  }

  async getRates(): Promise<ProviderResult<import('./adapter-types').RateResult[]>> {
    return { success: true, data: [] }
  }

  async getQRCode(_iccid: string): Promise<ProviderResult<{ qrCodeUrl: string }>> {
    const result = await this.callCapability('GET_ACTIVATION_CODE', { iccid: _iccid })
    if (!result.error && result.data) {
      const qr = result.data.qrCodeUrl || result.data.qr_code_url || result.data.data?.qrCodeUrl || ''
      return { success: true, data: { qrCodeUrl: qr } }
    }
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'QR code not available' } }
  }

  async topUpESIM(params: import('./adapter-types').TopUpESIMParams): Promise<ProviderResult<import('./adapter-types').TopUpESIMResult>> {
    const result = await this.callCapability('RENEW_ESIM', { iccid: params.iccid, planCode: params.planId, quantity: params.quantity })
    if (result.error) return { success: false, error: result.error }
    const d = result.data
    return {
      success: true,
      data: {
        providerReference: d.orderId || d.transactionId || d.id || '',
        dataAddedMB: d.dataAddedMB || undefined,
        validityDaysAdded: d.validityDaysAdded || undefined,
        status: d.status || 'COMPLETED',
      },
    }
  }

  async handleWebhook(_payload: import('./adapter-types').WebhookPayload): Promise<ProviderResult<{ handled: boolean; action?: string }>> {
    return { success: true, data: { handled: true, action: 'acknowledged' } }
  }
}