/**
 * Telna Connect Flex connector — DOCUMENTED READ-ONLY SURFACE ONLY.
 *
 * Matches the official Connect Flex API (host https://ppo-api.telna.com, auth
 * `Authorization: Bearer <KeyID>`). This connector deliberately implements ONLY
 * the documented, non-mutating operations:
 *   - testConnection / discovery : GET /v1/ordering/products
 *   - usage                     : GET /v1/diagnostic/usages
 *   - installation lookup       : GET /v1/diagnostic/euicc-profiles/{iccid}
 *
 * Purchase (POST /v1/ordering/work-orders), suspend/resume/top-up are declared
 * in the endpoint map but are NOT wired (mutating / not yet verified), so this
 * connector will never issue a billable provider call.
 *
 * MIGRATION NOTE: existing `TELNA` providers (legacy developer-api.telna.com
 * /core/*, /inventory/*, /pcr/*, /usage/*) are left untouched. New / migrated
 * providers use `adapterStrategy: 'TELNA_FLEX'`. Legacy records are never
 * auto-switched; switch only on an explicit admin action after a live read-only
 * health check succeeds.
 */
import { prisma } from '@/lib/prisma'
import { decryptToken } from '@/lib/encryption'
import { buildTelnaFlexUrl, telnaFlexEndpointPath } from './telna-flex-endpoints'
import type { IProviderConnector, ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, TopUpESIMParams, TopUpESIMResult, UsageResult, StatusResult, RateResult, TokenState, EsimLifecycleResult, ConnectorCapabilities, ConnectorAuthProfile, InstallationLookupInput, InstallationLookupResult, ConnectorInstallDataOutput } from './connector-interface'
import { hasUsableInstallData } from '@/lib/esim/installation-data'

interface FlexConfig {
  apiBaseUrl: string
  keyId: string
  authorizationMode: 'BEARER' | 'RAW'
}

export class TelnaFlexConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string

  constructor(providerId: string, name: string | undefined) {
    this.providerId = providerId
    this.name = name || 'Telna Connect Flex'
  }

  capabilities: ConnectorCapabilities = {
    installationLookup: true,
    installationDataAtPurchase: false, // purchase not wired
    installationLookupHistorical: true, // read-only GET /v1/diagnostic/euicc-profiles/{iccid}
    statusLookup: false,
    usageLookup: true,
    topUp: false,
    suspend: false,
    resume: false,
    balance: false,
    inventory: false,
    webhooks: false,
  }

  /** Connect Flex uses a static KeyID via Authorization: Bearer — no runtime login. */
  authProfile: ConnectorAuthProfile = {
    mode: 'STATIC_KEY_ID',
    requiresRuntimeAuthentication: false,
    canVerifyCredentials: true,
    supportsRefresh: false,
    credentialField: 'apiToken',
    actionLabel: 'Save & Verify',
  }

  private async loadConfig(): Promise<FlexConfig | null> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return null
    const keyId = decryptToken(provider.apiToken)
    if (!keyId) return null
    const cfg = (provider.config as Record<string, unknown>) || {}
    return {
      apiBaseUrl: (provider.apiBaseUrl || 'https://ppo-api.telna.com').replace(/\/+$/, ''),
      keyId,
      authorizationMode: cfg.authorizationMode === 'RAW' ? 'RAW' : 'BEARER',
    }
  }

  private async request(endpoint: 'products' | 'usages' | 'euiccProfiles', opts: {
    pathParams?: Record<string, string | number>
    query?: Record<string, string | number | undefined>
    method?: 'GET'
  } = {}): Promise<{ success: boolean; status?: number; data?: any; error?: { code: string; message: string } }> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not found or KeyID not configured' } }

    const method = opts.method || 'GET'
    const url = buildTelnaFlexUrl(config.apiBaseUrl, endpoint, opts.pathParams, opts.query)
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...(config.authorizationMode === 'RAW' ? { 'Authorization': config.keyId } : { 'Authorization': `Bearer ${config.keyId}` }),
    }
    const path = telnaFlexEndpointPath(endpoint)

    console.log(`[TELNA_FLEX_REQUEST] method=${method} path=${path} authorizationMode=${config.authorizationMode} hasToken=true`)
    const start = Date.now()

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(url, { method, headers, signal: controller.signal })
      clearTimeout(timeoutId)
      const status = response.status
      const text = await response.text()
      const latencyMs = Date.now() - start
      console.log(`[TELNA_FLEX_RESPONSE] method=${method} path=${path} status=${status} latencyMs=${latencyMs}`)

      if (status === 401 || status === 403) {
        return { success: false, status, error: { code: status === 401 ? 'HTTP_401' : 'HTTP_403', message: status === 401 ? 'Authentication rejected — check KeyID' : 'KeyID lacks permission' } }
      }
      if (status === 404) {
        return { success: false, status, error: { code: 'HTTP_404', message: 'Endpoint or base path not found — verify Telna Flex base URL / endpoint (not an authentication failure)' } }
      }
      if (status === 429) {
        return { success: false, status, error: { code: 'HTTP_429', message: 'Rate limited — too many requests' } }
      }
      if (status >= 400 && status < 500) return { success: false, status, error: { code: `HTTP_${status}`, message: text.substring(0, 300) } }
      if (status >= 500) return { success: false, status, error: { code: `HTTP_${status}`, message: 'Provider server error' } }

      let json: any = null
      try { json = JSON.parse(text || '{}') } catch { json = null }
      return { success: true, status, data: json }
    } catch (e: any) {
      const code = e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR'
      return { success: false, error: { code, message: code === 'TIMEOUT' ? 'Request timed out' : `Flex request failed: ${String(e?.message || '').slice(0, 200)}` } }
    }
  }

  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>> {
    const result = await this.request('products', { query: { count: 1, offset: 0 } })
    if (result.success) return { success: true, data: { message: 'Connected to Telna Connect Flex' } }
    return { success: false, error: result.error }
  }

  async diagnoseConnection(): Promise<ConnectorResult<any>> {
    return this.testConnection()
  }

  async authenticate(_credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Telna Connect Flex uses a pre-configured KeyID, not runtime authentication' } }
  }

  async getTokenState(): Promise<TokenState> {
    return { tokenPresent: true, expiryPresent: false, expired: false, expiresSoon: false, tokenExpiry: null }
  }

  async ensureAuthenticated(): Promise<ConnectorResult<void>> {
    const cfg = await this.loadConfig()
    if (!cfg) return { success: false, error: { code: 'NO_TOKEN', message: 'KeyID not configured' } }
    return { success: true }
  }

  async refreshAuthentication(): Promise<boolean> {
    return false
  }

  /** Discovery: GET /v1/ordering/products. Response shape is defensive (best-effort field mapping; shape unverified live). */
  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    const result = await this.request('products')
    if (!result.success) return { success: false, error: result.error }
    const raw = result.data || {}
    const items: any[] = Array.isArray(raw) ? raw : (Array.isArray(raw.data) ? raw.data : (Array.isArray(raw.items) ? raw.items : []))
    const plans: ConnectorPlan[] = items
      .map((p: any): ConnectorPlan | null => {
        if (!p || typeof p !== 'object') return null
        const id = p.product_id || p.productId || p.id
        const name = p.name || p.internal_name || p.product_name || p.internalName
        if (!id || !name) return null
        const price = p.price?.net_price ?? p.price?.amount ?? p.price?.netPrice ?? p.net_price ?? p.amount
        const dataGbRaw = p.features?.data_mb ?? p.features?.dataMb ?? p.data_mb ?? p.dataGb ?? p.dataGB
        return {
          id: String(id),
          name: String(name),
          data_gb: dataGbRaw != null ? Math.round(Number(dataGbRaw) / 1024) : 0,
          validity_days: p.validity_days ?? p.validityDays ?? 30,
          price_usd: price != null ? Number(price) : 0,
          currency: p.price?.currency || p.currency || 'USD',
        }
      })
      .filter((p): p is ConnectorPlan => p !== null)
    return { success: true, data: plans }
  }

  /** Read-only historical installation lookup: GET /v1/diagnostic/euicc-profiles/{iccid}. Shape unverified → classify conservatively. */
  async lookupInstallationData(input: InstallationLookupInput): Promise<InstallationLookupResult> {
    if (!input.iccid) {
      return { success: false, state: 'PERMANENT_FAILURE', errorCode: 'IDENTIFIER_MISSING', diagnostics: { methodUsed: 'euicc_profiles', identifierType: 'none' } }
    }
    const result = await this.request('euiccProfiles', { pathParams: { iccid: input.iccid } })
    if (!result.success) {
      if (result.error?.code === 'HTTP_401' || result.error?.code === 'HTTP_403') {
        return { success: false, state: 'PERMANENT_FAILURE', errorCode: 'PROVIDER_AUTH_FAILED', diagnostics: { methodUsed: 'euicc_profiles', identifierType: 'iccid' } }
      }
      return { success: false, state: 'NOT_AVAILABLE_YET', errorCode: result.error?.code === 'HTTP_404' ? 'PROVIDER_HTTP_ERROR' : 'PROVIDER_TIMEOUT', diagnostics: { methodUsed: 'euicc_profiles', identifierType: 'iccid' } }
    }
    // Shape unverified — only promote known install fields if the response carries
    // them; otherwise report NOT_AVAILABLE_YET with an explicit note (not
    // NOT_SUPPORTED — the endpoint exists, its shape is simply unconfirmed live).
    const data: ConnectorInstallDataOutput = {
      ...(result.data?.qr_code_link ? { qrCodeUrl: String(result.data.qr_code_link) } : {}),
      ...(result.data?.activation_code ? { activationCode: String(result.data.activation_code) } : {}),
      ...(result.data?.smdp_address ? { smdpAddress: String(result.data.smdp_address) } : {}),
      ...(result.data?.matching_id ? { matchingId: String(result.data.matching_id) } : {}),
    }
    if (hasUsableInstallData(data)) {
      return { success: true, state: 'READY', data, diagnostics: { methodUsed: 'euicc_profiles', identifierType: 'iccid' } }
    }
    return {
      success: false,
      state: 'NOT_AVAILABLE_YET',
      errorCode: 'NO_INSTALL_DATA',
      diagnostics: { methodUsed: 'euicc_profiles', identifierType: 'iccid', note: 'GET /v1/diagnostic/euicc-profiles/{iccid} documented; response shape unverified — absence of install fields here is NOT proof the profile lacks them.' },
    }
  }

  /** Read-only usage: GET /v1/diagnostic/usages. Defensive mapping (shape unverified). */
  async getUsage(identifier: string | import('./connector-interface').StatusLookupIdentifier): Promise<ConnectorResult<UsageResult>> {
    const result = await this.request('usages')
    if (!result.success) return { success: false, error: result.error }
    const row = (Array.isArray(result.data) ? result.data[0] : result.data?.data?.[0]) || {}
    const iccid = row.iccid || (typeof identifier === 'string' ? identifier : (identifier as any)?.iccid) || ''
    return {
      success: true,
      data: {
        iccid: String(iccid),
        dataUsedMB: Number(row.data_used_mb ?? row.dataUsedMB ?? 0) || 0,
        ...(row.data_total_mb != null ? { dataTotalMB: Number(row.data_total_mb) } : {}),
        ...(row.data_remaining_mb != null ? { dataRemainingMB: Number(row.data_remaining_mb) } : {}),
        ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}),
      },
    }
  }

  resolveStatusLookup(): null {
    return null
  }

  /** Telna Connect Flex usage is keyed by ICCID. */
  resolveUsageLookup(esim: import('./connector-interface').StatusLookupEsim): string | null {
    return esim.iccid || null
  }

  async getStatus(_identifier: string | import('./connector-interface').StatusLookupIdentifier): Promise<ConnectorResult<StatusResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Status lookup not wired for Telna Connect Flex' } }
  }
  async activateESIM(_params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Purchase (POST /v1/ordering/work-orders) not wired — mutating' } }
  }
  async topUpESIM(_params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Top-up not wired for Telna Connect Flex' } }
  }
  async suspendESIM(_id: string | import('./connector-interface').StatusLookupIdentifier): Promise<ConnectorResult<EsimLifecycleResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Suspend not wired for Telna Connect Flex' } }
  }
  async resumeESIM(_id: string | import('./connector-interface').StatusLookupIdentifier): Promise<ConnectorResult<EsimLifecycleResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Resume not wired for Telna Connect Flex' } }
  }
  async getRates(): Promise<ConnectorResult<RateResult[]>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Rates not implemented' } }
  }
  async getQRCode(_iccid: string): Promise<ConnectorResult<import('./connector-interface').QRCodeResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Use lookupInstallationData' } }
  }
}
