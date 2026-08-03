import { prisma } from '@/lib/prisma'
import type { ProviderAdapter, ProviderPlan, ProviderResult } from './adapter-types'
import type { IProviderConnector, ConnectorPlan, EsimLifecycleResult } from './connectors/connector-interface'

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
  // Normalize: strip "Bearer " prefix if token already contains it
  const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token
  switch (tokenPlacement) {
    case 'BEARER_HEADER':
      headers['Authorization'] = `Bearer ${cleanToken}`; break
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

const FALLBACK_LIST_KEYS = ['data', 'result', 'plans', 'items', 'list', 'records', 'package_templates']

function extractList(data: any, listKey?: string): any[] {
  if (Array.isArray(data)) return data

  // Try configured list key first
  if (listKey) {
    const parts = listKey.split('.')
    let current = data
    for (const p of parts) { if (current) current = current[p] }
    if (Array.isArray(current)) return current
  }

  // Try fallback list keys from responseMappings
  const fallbackPaths = ['getInformation', 'getPlanInformation', 'planInformation', 'plans', 'result.plans', 'result.items', 'result.package_templates']
  for (const path of fallbackPaths) {
    const parts = path.split('.')
    let current = data
    for (const p of parts) { if (current) current = current[p] }
    if (Array.isArray(current)) return current
  }

  // Try known response wrapper patterns
  if (data?.result) {
    if (Array.isArray(data.result)) return data.result
    // Try result.{knownKey}
    for (const key of FALLBACK_LIST_KEYS) {
      if (Array.isArray(data.result[key])) return data.result[key]
    }
  }
  if (data?.data) {
    if (Array.isArray(data.data)) return data.data
    for (const key of FALLBACK_LIST_KEYS) {
      if (Array.isArray(data.data[key])) return data.data[key]
    }
  }
  if (data?.response?.data) {
    if (Array.isArray(data.response.data)) return data.response.data
  }

  // Try the first array found in the response object
  const firstArr = Object.values(data).find(v => Array.isArray(v))
  if (firstArr) return firstArr as any[]
  // Recursive search into nested objects
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
  private authContext: Record<string, any> = {}

  constructor(provider: any) {
    this.providerId = provider.id
    this.name = provider.name || provider.code || 'Template Provider'
    this.provider = provider
    this.config = (provider.config || {}) as Record<string, any>
    // Decrypt persisted token so authenticated requests include Authorization header
    if (provider.apiToken) {
      try {
        const { decryptToken } = require('@/lib/encryption')
        this.token = decryptToken(provider.apiToken) || null
      } catch { this.token = null }
    }
    console.log(`[TEMPLATE_ADAPTER_CONFIG] code=${provider.code} configKeys=${Object.keys(this.config).join(',')} partnerCode=${this.config.partnerCode} flag=${this.config.flag} tokenPresent=${!!this.token} tokenPlacement=${provider.tokenPlacement}`)
  }

  async getTokenState(): Promise<{ tokenPresent: boolean; expiryPresent: boolean; expired: boolean; expiresSoon: boolean }> {
    const tokenExpiry = this.config?.tokenExpiry || null
    const tokenPresent = !!this.token
    let expired = false
    let expiresSoon = false
    if (tokenExpiry) {
      if (typeof tokenExpiry === 'number') {
        expired = Date.now() >= tokenExpiry * 1000
        expiresSoon = !expired && Date.now() >= (tokenExpiry * 1000) - 5 * 60 * 1000
      } else if (typeof tokenExpiry === 'string') {
        const parsed = Date.parse(tokenExpiry)
        if (!isNaN(parsed)) {
          expired = Date.now() >= parsed
          expiresSoon = !expired && Date.now() >= parsed - 5 * 60 * 1000
        }
      }
    }
    return { tokenPresent, expiryPresent: !!tokenExpiry, expired, expiresSoon }
  }

  async ensureAuthenticated(): Promise<ProviderResult<void>> {
    const state = await this.getTokenState()
    if (state.tokenPresent && !state.expired && !state.expiresSoon) return { success: true }
    const username = this.config?.username
    const password = this.config?.password
    if (username && password) {
      const result = await this.authenticate({ username, password })
      if (result.success) return { success: true }
    }
    if (this.token) return { success: true }
    return { success: false, error: { code: 'NO_TOKEN', message: 'No token. Authenticate first.' } }
  }

  async refreshAuthentication(): Promise<boolean> {
    const username = this.config?.username
    const password = this.config?.password
    if (!username || !password) return false
    const result = await this.authenticate({ username, password })
    return result.success
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
  private getCapabilityMapping(capability: string): any {
    // Priority: provider record's requestMappings > provider.config.requestBodies > provider.config.defaultRequestBody > template's defaultRequestMappings
    const reqMap = this.provider.requestMappings || {}
    let mapping = reqMap[capability]

    if (!mapping || typeof mapping !== 'object') {
      mapping = this.config?.requestBodies?.[capability]
    }
    if (!mapping || typeof mapping !== 'object') {
      mapping = this.config?.defaultRequestBody?.[capability]
    }
    if (!mapping || typeof mapping !== 'object') {
      const tpl = this.provider.providerTemplate || this.provider.template
      if (tpl?.requestMappings) {
        mapping = tpl.requestMappings[capability]
      }
    }
    if (!mapping || typeof mapping !== 'object') return {}
    return mapping
  }

  private buildRequestBody(capability: string): any {
    const mapping = this.getCapabilityMapping(capability)
    if (!mapping || typeof mapping !== 'object') return {}

    const numericFields: string[] = this.config?.numericFields || []
    const arrayFields: string[] = this.config?.arrayFields || []

    /**
     * Resolves a {{variable}} expression with namespace support:
     *   {{auth.partnerCode}}     → authContext
     *   {{config.flag|5}}        → provider.config (with default)
     *   {{credentials.username}} → this.config
     *   {{partnerCode}}          → backward compat: config > auth > credentials
     */
    const resolveVar = (tmpl: string, fieldName?: string): any => {
      const match = tmpl.match(/^\{\{(.+?)\}\}$/)
      if (!match) return tmpl

      const inner = match[1]
      const pipeIdx = inner.indexOf('|')
      const rawExpr = pipeIdx >= 0 ? inner.substring(0, pipeIdx) : inner
      const defaultValue = pipeIdx >= 0 ? inner.substring(pipeIdx + 1) : ''

      // Parse namespace: "auth.partnerCode" or "config.flag" or plain "partnerCode"
      const dotIdx = rawExpr.indexOf('.')
      const namespace = dotIdx >= 0 ? rawExpr.substring(0, dotIdx) : null
      const varName = dotIdx >= 0 ? rawExpr.substring(dotIdx + 1) : rawExpr

      // Resolve value based on namespace
      let val: any = undefined
      if (namespace === 'auth') {
        // Auth namespace checks config first (override), then auth context
        val = this.config?.[varName] ?? this.authContext?.[varName]
      } else if (namespace === 'config') {
        val = this.config?.[varName]
      } else if (namespace === 'credentials') {
        val = this.config?.[varName] ?? this.provider[varName]
      } else {
        // Plain variable: backward compat priority: config > auth > provider > env
        val = this.config?.[varName]
          ?? this.authContext?.[varName]
          ?? this.provider[varName]
          ?? process.env[varName]
      }

      if (val == null || val === '') {
        val = defaultValue
      }

      // Numeric coercion
      if (fieldName && numericFields.includes(fieldName) && val !== '' && val != null) {
        const num = Number(val)
        if (!isNaN(num)) return num
      }

      // Array coercion: comma-separated string → array
      if (fieldName && arrayFields.includes(fieldName)) {
        if (typeof val === 'string' && val.includes(',')) {
          return val.split(',').map((s: string) => s.trim()).filter(Boolean)
        }
        if (typeof val === 'string' && val.length > 0 && !val.includes(',')) {
          return [val.trim()]
        }
        if (Array.isArray(val)) return val
        if (defaultValue && defaultValue.includes(',')) {
          return defaultValue.split(',').map((s: string) => s.trim()).filter(Boolean)
        }
        return defaultValue ? [defaultValue] : []
      }

      // Return raw value — preserving original type (number, string, array, etc.)
      return val ?? ''
    }

    const resolveValue = (val: any, key?: string): any => {
      if (typeof val === 'number') return val
      if (typeof val === 'boolean') return val
      if (Array.isArray(val)) return val.map(v => resolveValue(v))
      if (typeof val === 'string' && val.match(/^\{\{(.+?)\}\}$/)) return resolveVar(String(val), key)
      if (typeof val === 'object' && val !== null) {
        const result: any = {}
        for (const [k, v] of Object.entries(val)) result[k] = resolveValue(v, k)
        return result
      }
      if (val === null) return null
      return val
    }

    const body: any = {}
    for (const [key, val] of Object.entries(mapping)) {
      body[key] = resolveValue(val, key)
    }
    return body
  }

  private async callCapabilityWithBody(capability: string): Promise<{ data?: any; error?: { code: string; message: string; details?: any }; status?: number }> {
    const ep = resolveEndpoint(this.endpointMappings, capability)
    if (!ep) return { error: { code: 'NOT_SUPPORTED', message: `Capability ${capability} not configured` } }
    const url = buildUrl(this.baseUrl, ep.path)
    const headers: Record<string, string> = {}
    applyAuthHeaders(headers, this.token, this.tokenPlacement, this.provider.authType || 'bearer_token')
    const body = this.buildRequestBody(capability)
    console.log(`[CALL_WITH_BODY] capability=${capability} partnerCode=${body.partnerCode} flag=${body.flag} countryCode=${body.countryCode} multiplecountrycode=${JSON.stringify(body.multiplecountrycode)}`)
    console.log(`[AIRHUB_AUTH_HEADER] capability=${capability} tokenAvailable=${!!this.token} authHeaderPresent=${!!this.token} scheme=Bearer placement=${this.tokenPlacement}`)

    // Validate required fields for GET_PLANS
    if (capability === 'GET_PLANS') {
      if (body.partnerCode == null) return { error: { code: 'MISSING_PARTNER_CODE', message: 'partnerCode is required in provider.config' } }
      if (body.flag == null) return { error: { code: 'MISSING_FLAG', message: 'flag is required in provider.config' } }
      if (body.countryCode === undefined) return { error: { code: 'MISSING_COUNTRY_CODE', message: 'countryCode is required in provider.config' } }
      if (!body.multiplecountrycode || !Array.isArray(body.multiplecountrycode) || body.multiplecountrycode.length === 0) return { error: { code: 'MISSING_MULTIPLE_COUNTRY_CODE', message: 'multiplecountrycode must be a non-empty array in provider.config' } }
    }

    console.log('[TemplateProviderAdapter] CALL_WITH_BODY', {
      capability,
      url,
      method: ep.method,
      hasToken: !!this.token,
      tokenPlacement: this.tokenPlacement,
      authType: this.provider.authType,
      headers: Object.keys(headers),
      body,
      bodyTypes: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, Array.isArray(v) ? `array[${v.length}]` : typeof v])),
    })
    const fetchOpts: any = { method: ep.method, headers }
    if (['POST', 'PUT', 'PATCH'].includes(ep.method.toUpperCase())) {
      fetchOpts.body = JSON.stringify(body)
    }
    console.log(`[AIRHUB_FINAL_HEADERS] capability=${capability} headerNames=${Object.keys(headers).join(',')} hasAuthorization=${!!headers['Authorization']} scheme=${headers['Authorization'] ? headers['Authorization'].split(' ')[0] : 'none'}`)
    const result = await rawFetch(url, fetchOpts)
    const responsePreview = result.data ? JSON.stringify(result.data).substring(0, 300) : ''
    if (result.error) {
      return { error: { code: result.error.code, message: `${capability} failed: ${ep.method} ${url} returned ${result.status || 'error'}: ${result.error.message}${responsePreview ? ` | Response: ${responsePreview}` : ''}`, details: { capability, url, method: ep.method, status: result.status, responseBody: responsePreview } }, status: result.status }
    }
    return { data: result.data, status: result.status }
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

    // Extract auth context values from login response for use in subsequent requests
    const authData = result.data
    this.authContext = {
      partnerCode: authData?.partnerCode ?? authData?.data?.partnerCode ?? authData?.result?.partnerCode,
      userID: authData?.userID ?? authData?.data?.userID ?? authData?.result?.userID,
      userName: authData?.userName ?? authData?.data?.userName ?? authData?.result?.userName,
      role: authData?.role ?? authData?.data?.role ?? authData?.result?.role,
    }
    if (this.authContext.partnerCode != null) {
      console.log(`[TemplateProviderAdapter] Auth context: partnerCode=${this.authContext.partnerCode}`)
    }

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
        const msg = genResult.error.message || ''
        const statusMatch = msg.match(/HTTP_(\d+)/)
        const httpStatus = statusMatch ? statusMatch[1] : 'unknown'
        console.log('[GENERATE_API_KEY] Failed:', msg)
        return {
          success: false,
          error: {
            code: 'API_KEY_GENERATION_FAILED',
            message: `Rakuten API key generation failed: HTTP ${httpStatus}${msg.includes('403') ? '. Your Rakuten staging account may not have API key generation enabled.' : `. ${msg.slice(0, 200)}`}`,
          },
        }
      }

      if (genResult.data) {
        const apiKey = genResult.data.apiKey || genResult.data.result?.apiKey || genResult.data.data?.apiKey || null
        if (apiKey && apiKey.length >= 8) {
          console.log(`[GENERATE_API_KEY] API key generated (${apiKey.length} chars)`)
          this.token = apiKey
          return { success: true, data: { token: apiKey, accountInfo: { ...result.data, _apiKeyGenerated: true, _loginToken: token } } }
        }
        console.log('[GENERATE_API_KEY] No usable API key in response. Keys:', Object.keys(genResult.data))
        return { success: false, error: { code: 'API_KEY_EXTRACTION_FAILED', message: 'Rakuten API key generation returned a response but no apiKey was found. Check the API key generation endpoint response format.' } }
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

    // Check for provider-level isSuccess: false (AirHub pattern)
    if (result.data.isSuccess === false) {
      const providerMsg = result.data.message || result.data.errorMessage || 'Unknown provider error'
      console.log('[GET_PLANS] Provider returned isSuccess=false message=' + providerMsg)
      return { success: false, error: { code: 'PROVIDER_ERROR', message: `Provider returned failure: ${providerMsg}` } }
    }

    // Check for errorCode pattern (AirHub: errorCode != 0 means failure)
    if (result.data.errorCode != null && result.data.errorCode !== 0) {
      const errMsg = result.data.message || result.data.errorMessage || `Error code: ${result.data.errorCode}`
      console.log('[GET_PLANS] Provider returned errorCode=' + result.data.errorCode + ' message=' + errMsg)
      return { success: false, error: { code: 'PROVIDER_ERROR', message: `Provider returned failure: ${errMsg}` } }
    }

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

  private extractField(path: string | undefined, data: any): string | undefined {
    if (!path) return undefined
    const parts = path.split('.')
    let current = data
    for (const p of parts) {
      if (current && typeof current === 'object') current = current[p]
      else return undefined
    }
    return current != null ? String(current) : undefined
  }

  private extractReservationId(data: any, responseMappings: any): string | null {
    const primaryPath = responseMappings?.reservationIdPath
    const id = this.extractField(primaryPath, data)
    if (id && id.length > 0) return id

    const fallbacks: string[] = responseMappings?.reservationIdFallbackPaths || ['result.id', 'result.reservation_id']
    for (const fb of fallbacks) {
      const val = this.extractField(fb, data)
      if (val && val.length > 0) return val
    }

    return null
  }

  private async doSingleStepPurchase(params: import('./adapter-types').ActivateESIMParams): Promise<ProviderResult<import('./adapter-types').ActivateESIMResult>> {
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
    const iccids = this.extractIccids(d, params.quantity)
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

  private async doTwoStepPurchase(params: import('./adapter-types').ActivateESIMParams): Promise<ProviderResult<import('./adapter-types').ActivateESIMResult>> {
    const rm = this.provider.requestMappings || {}
    const responseMappings = this.provider.responseMappings || {}
    const initBody = this.buildRequestBody('INITIATE_PURCHASE')
    const body = { ...initBody, planCode: params.planId, quantity: params.quantity }

    console.log('[TWO_STEP] Step 1: INITIATE_PURCHASE planId=' + params.planId)

    // Step 1: Initiate purchase
    const initResult = await this.callCapability('INITIATE_PURCHASE', body)
    if (initResult.error) {
      console.log('[TWO_STEP] INITIATE_PURCHASE failed:', initResult.error.message)
      return { success: false, error: initResult.error }
    }
    if (!initResult.data) return { success: false, error: { code: 'EMPTY_INIT', message: 'Empty initiate purchase response' } }

    const initData = initResult.data
    console.log('[TWO_STEP] INITIATE_PURCHASE response keys:', Object.keys(initData))

    const reservationId = this.extractReservationId(initData, responseMappings)
    const iccid = this.extractField(responseMappings?.iccidPath, initData) || this.extractField('result.iccid', initData) || ''
    const initStatus = this.extractField(responseMappings?.reservationExpiresAtPath, initData)

    console.log('[TWO_STEP] Init result:', { reservationId, iccid, initStatus })

    if (!reservationId) {
      return { success: false, error: { code: 'NO_RESERVATION_ID', message: 'Provider reservationId missing; cannot fulfill purchase. Initiate response did not include a reservation identifier.' } }
    }

    if (!iccid) {
      return { success: false, error: { code: 'NO_ICCIDS', message: 'Provider did not return ICCID during initiation' } }
    }

    // Step 2: Fulfill purchase
    const fulfillEp = resolveEndpoint(this.endpointMappings, 'FULFILL_PURCHASE')
    if (!fulfillEp) {
      // No fulfill endpoint — mark as reserved only
      console.log('[TWO_STEP] No FULFILL_PURCHASE endpoint — returning reserved state')
      return {
        success: true,
        data: {
          activationId: reservationId,
          iccids: [iccid],
          status: 'RESERVED',
          reservationId,
        },
      }
    }

    // Substitute reservationId in the fulfill path
    const fulfillPath = fulfillEp.path.replace('{{reservationId}}', reservationId).replace('{reservationId}', reservationId)
    const fulfillUrl = buildUrl(this.baseUrl, fulfillPath)
    const headers: Record<string, string> = {}
    applyAuthHeaders(headers, this.token, this.tokenPlacement, this.provider.authType || 'bearer_token')

    console.log('[TWO_STEP] Step 2: FULFILL_PURCHASE ' + fulfillEp.method + ' ' + fulfillUrl)

    const fulfillResult = await rawFetch(fulfillUrl, { method: fulfillEp.method, headers })
    if (fulfillResult.error) {
      console.log('[TWO_STEP] FULFILL_PURCHASE failed:', fulfillResult.error.message)
      // Attempt cancellation
      await this.cancelReservation(reservationId)
      return { success: false, error: fulfillResult.error }
    }
    if (!fulfillResult.data) {
      await this.cancelReservation(reservationId)
      return { success: false, error: { code: 'EMPTY_FULFILL', message: 'Empty fulfill purchase response' } }
    }

    const fulfillData = fulfillResult.data
    console.log('[TWO_STEP] FULFILL_PURCHASE response keys:', Object.keys(fulfillData))

    const fulfillIccid = this.extractField(responseMappings?.iccidPath, fulfillData) || this.extractField('result.iccid', fulfillData) || iccid
    const activationCode = this.extractField(responseMappings?.activationCodePath, fulfillData) || this.extractField('result.activationCode', fulfillData) || ''
    const packageId = this.extractField(responseMappings?.packageIdPath || responseMappings?.providerOrderIdPath, fulfillData) || this.extractField('result.packageId', fulfillData) || ''
    const fulfillStatus = this.extractField('result.status', fulfillData) || 'ACTIVE'

    // Generate QR from activationCode if present (Rakuten does not return QR)
    let qrCodeUrl: string | undefined
    if (activationCode) {
      qrCodeUrl = activationCode.startsWith('http') ? activationCode : undefined
    }

    console.log('[TWO_STEP] Fulfill result:', { iccid: fulfillIccid, activationCode: activationCode ? activationCode.slice(0, 20) + '...' : null, packageId, status: fulfillStatus })

    return {
      success: true,
      data: {
        activationId: packageId || reservationId,
        iccids: [fulfillIccid],
        activationCodes: activationCode ? [activationCode] : undefined,
        qrCodeUrl,
        status: fulfillStatus,
        reservationId,
      },
    }
  }

  private async cancelReservation(reservationId: string): Promise<void> {
    const cancelEp = resolveEndpoint(this.endpointMappings, 'CANCEL_PURCHASE')
    if (!cancelEp) {
      console.log('[TWO_STEP] No CANCEL_PURCHASE endpoint — reservation ' + reservationId + ' may remain active')
      return
    }
    const cancelPath = cancelEp.path.replace('{{reservationId}}', reservationId).replace('{reservationId}', reservationId)
    const cancelUrl = buildUrl(this.baseUrl, cancelPath)
    const headers: Record<string, string> = {}
    applyAuthHeaders(headers, this.token, this.tokenPlacement, this.provider.authType || 'bearer_token')
    try {
      await rawFetch(cancelUrl, { method: cancelEp.method, headers })
      console.log('[TWO_STEP] Reservation ' + reservationId + ' cancelled')
    } catch (e: any) {
      console.log('[TWO_STEP] Failed to cancel reservation ' + reservationId + ': ' + e.message)
    }
  }

  private extractIccids(d: any, minCount: number): string[] {
    if (Array.isArray(d.iccids)) return d.iccids
    if (d.iccid) return [d.iccid]
    if (d.data?.iccid) return [d.data.iccid]
    if (d.data?.iccids) return d.data.iccids
    if (d.esim?.iccid) return [d.esim.iccid]
    if (d.order?.iccids) return d.order.iccids
    if (d.result?.iccid) return [d.result.iccid]
    return []
  }

  async activateESIM(params: import('./adapter-types').ActivateESIMParams): Promise<ProviderResult<import('./adapter-types').ActivateESIMResult>> {
    const authResult = await this.authenticate({})
    if (!authResult.success) return { success: false, error: authResult.error }

    const purchaseWorkflow = this.config?.purchaseWorkflow || this.config?.purchase_workflow || 'SINGLE_STEP'
    console.log('[TemplateProviderAdapter] activateESIM workflow=' + purchaseWorkflow + ' planId=' + params.planId)

    if (purchaseWorkflow === 'TWO_STEP_RESERVATION_FULFILLMENT') {
      return this.doTwoStepPurchase(params)
    }

    return this.doSingleStepPurchase(params)
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

  async suspendESIM(_subscriptionId: string): Promise<ProviderResult<EsimLifecycleResult>> {
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Suspend not supported by template provider' } }
  }

  async resumeESIM(_subscriptionId: string): Promise<ProviderResult<EsimLifecycleResult>> {
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