/**
 * US-Matrix eSIM API connector — provider-neutral integration.
 *
 * Contract: US-Matrix eSIM API - Client Integration (OpenAPI 3.0, v1.0.0).
 * Official Swagger: https://api-esim.usmatrix.com/api/v1/docs-to-client/
 *
 * AUTH (LOGIN_TOKEN runtime exchange — NOT a static token):
 *   POST /api/v1/whitelist/signin  { email, password } → { token }
 *   Subsequent requests: Authorization: Bearer <token>
 *   Documented response has NO expiry field → supportsRefresh=false.
 *
 * SAFE VERIFICATION:
 *   After login, GET /api/v1/clients/current (read-only identity check).
 *
 * This connector deliberately implements ONLY documented read-only operations:
 *   - GET /api/v1/clients/current   (connection verification)
 *   - GET /api/v1/packages          (catalog discovery → syncPlans)
 *   - GET /api/v1/esims             (eSIM inventory; EsimDTO carries
 *                                    smDpAddress + activationCode + qrcodeString)
 *
 * Installation data:
 *   - installationLookupHistorical : GET /api/v1/esims?iccid=… returns EsimDTO
 *     with smDpAddress / activationCode / qrcodeString (documented fields) →
 *     READ-ONLY historical recovery.
 *   - installationDataAtPurchase   : 'UNKNOWN' (AssignPackageResponseDTO carries
 *     the same fields, but the canonical billable purchase flow is unverified —
 *     never claimed NOT_SUPPORTED without evidence).
 *
 * Mutating operations are declared in the endpoint map for path-accuracy but are
 * NOT wired: add-esims / assign-package / qrcode (flag-update only, never a QR
 * generator) / suspend / unsuspend / transfer / package + client mutations.
 * POST /esims/qrcode is never called for historical QR reconciliation.
 *
 * No provider-name branches exist outside this connector + factory + template
 * wiring. Generic admin/business/background code derives behavior from
 * authProfile / capabilities / adapterStrategy.
 */
import { prisma } from '@/lib/prisma'
import { decryptToken, encryptToken } from '@/lib/encryption'
import { usMatrixEndpointPath, buildUsMatrixUrl, normalizeUsMatrixBaseUrl, type UsMatrixEndpoint, type UsMatrixPaginated, type UsMatrixPackage, type UsMatrixEsim, type UsMatrixSigninRequest, type UsMatrixSigninResponse, type AssignPackageRequestDTO, type AssignPackageResponseDTO, type GetPackageUsageRequestDTO, type GetPackageUsageResponseDTO, type RateGroupDTO, type SuspendEsimRequestDTO, type UnsuspendEsimRequestDTO, type RemoveEsimFromPackageRequestDTO, type AvailabilityCountRequestDTO, type CountryDTO, type ListCountriesResponseDTO } from './usmatrix-endpoints'
import type { IProviderConnector, ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, TopUpESIMParams, TopUpESIMResult, UsageResult, StatusResult, RateResult, TokenState, EsimLifecycleResult, ConnectorCapabilities, ConnectorAuthProfile, InstallationLookupInput, InstallationLookupResult, ConnectorInstallDataOutput, DiagnosticInfo, StatusLookupEsim, StatusLookupIdentifier } from './connector-interface'
import { hasUsableInstallData } from '@/lib/esim/installation-data'

interface UsMatrixConfig {
  apiBaseUrl: string
  token: string | null
  timeoutMs: number
  /** Optional US-Matrix client UUID for whitelisted backend integrations. */
  clientId?: string | null
}

function maskToken(token: string): string {
  if (!token || token.length < 8) return token || ''
  return token.slice(0, 4) + '••••' + token.slice(-4)
}

function maskIccid(iccid: string | null | undefined): string {
  if (!iccid) return ''
  if (iccid.length <= 8) return '••••'
  return `${iccid.slice(0, 4)}••••${iccid.slice(-4)}`
}

/**
 * Conservative extraction of the matching-id component from an LPA QR payload
 * or activation code (format `1$<smdp>$<matching-id>` or `LPA:1$<smdp>$<id>`).
 * Returns null when the shape is not an LPA-style string — never invents a
 * matching id from arbitrary activation codes.
 */
export function extractMatchingId(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = String(value).replace(/^LPA:/i, '')
  const parts = cleaned.split('$')
  if (parts.length !== 3) return null
  const candidate = parts[2]?.trim()
  return candidate ? candidate : null
}

function redactForDiagnostics(data: unknown, maxLen = 300): string | null {
  if (data == null) return null
  try {
    return JSON.stringify(data).substring(0, maxLen)
  } catch {
    return String(data).substring(0, maxLen)
  }
}

export class UsMatrixConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string

  constructor(providerId: string, name: string | undefined) {
    this.providerId = providerId
    this.name = name || 'US-Matrix'
  }

  /** US-Matrix connector-declared internal capabilities (runtime truth). */
  capabilities: ConnectorCapabilities = {
    installationLookup: true,
    // AssignPackageResponseDTO (201) carries install fields → purchase returns install data.
    installationDataAtPurchase: true,
    installationLookupHistorical: true, // GET /esims?iccid=… EsimDTO install fields
    statusLookup: false, // GET /esims status enum (free/assigned/suspended) is allocation state, not proven OneSIM lifecycle
    usageLookup: false, // POST /packages/usage requires packageEsimId — NOT returned by ANY documented response; keep getUsage() defensive but unadvertised
    topUp: false, // no documented top-up endpoint; assign-package is not top-up
    suspend: true, // PUT /esims/suspend (eSIM-level) — wired
    resume: true, // PUT /esims/unsuspend (eSIM-level) — wired
    balance: false, // no wallet/balance endpoint documented
    inventory: true, // GET /esims
    webhooks: false, // no webhook surface in this client API
  }

  /** Runtime LOGIN_TOKEN: email/password → Bearer token via POST /whitelist/signin. */
  authProfile: ConnectorAuthProfile = {
    mode: 'LOGIN_TOKEN',
    requiresRuntimeAuthentication: true,
    canVerifyCredentials: true,
    supportsRefresh: false, // no documented token expiry/refresh
    actionLabel: 'Save & Authenticate',
  }

  private async loadConfig(): Promise<UsMatrixConfig | null> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return null
    const cfg = (provider.config as Record<string, unknown>) || {}
    const token = provider.apiToken ? decryptToken(provider.apiToken) : (typeof cfg.token === 'string' ? cfg.token : null)
    return {
      apiBaseUrl: normalizeUsMatrixBaseUrl(provider.apiBaseUrl || 'https://api-esim.usmatrix.com'),
      token: token || null,
      timeoutMs: Number(cfg.requestTimeoutMs) || 15000,
      clientId: typeof cfg.clientId === 'string' && cfg.clientId ? cfg.clientId : null,
    }
  }

  private async request(endpoint: UsMatrixEndpoint, opts: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    pathParams?: Record<string, string | number>
    query?: Record<string, string | number | boolean | undefined>
    body?: unknown
    requireAuth?: boolean
  } = {}): Promise<{ success: boolean; status?: number; data?: any; error?: { code: string; message: string } }> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not found' } }

    const method = opts.method || 'GET'
    let url = buildUsMatrixUrl(config.apiBaseUrl, endpoint, opts.pathParams)
    if (opts.query) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
      }
      const qs = params.toString()
      if (qs) url += `?${qs}`
    }

    const headers: Record<string, string> = { 'Accept': 'application/json' }
    if (opts.requireAuth !== false && config.token) {
      headers['Authorization'] = `Bearer ${config.token}`
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

    const path = usMatrixEndpointPath(endpoint)
    console.log(`[USMATRIX_REQUEST] method=${method} path=${path} auth=${config.token ? 'Bearer(hasToken)' : 'none'} bodyFields=${opts.body && typeof opts.body === 'object' ? Object.keys(opts.body as object).join(',') : ''}`)
    const start = Date.now()

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs)
      const response = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      const status = response.status
      const text = await response.text()
      const latencyMs = Date.now() - start
      console.log(`[USMATRIX_RESPONSE] method=${method} path=${path} status=${status} latencyMs=${latencyMs}`)

      // 201 (created), 204 (no content) and any 2xx are success for US-Matrix.
      if (status >= 200 && status < 300) {
        let json: any = null
        if (text.trim()) {
          try { json = JSON.parse(text) } catch { json = null }
        }
        return { success: true, status, data: json }
      }

      if (status === 401) {
        return { success: false, status, error: { code: 'HTTP_401', message: 'Authentication rejected — invalid credentials or token' } }
      }
      if (status === 403) {
        return { success: false, status, error: { code: 'HTTP_403', message: 'Forbidden — IP not whitelisted or permission denied' } }
      }
      if (status === 404) {
        return { success: false, status, error: { code: 'HTTP_404', message: 'Resource not found — verify US-Matrix base URL / endpoint (not an authentication failure)' } }
      }
      if (status === 422) {
        return { success: false, status, error: { code: 'HTTP_422', message: 'Business-rule validation failed' } }
      }
      if (status === 429) {
        return { success: false, status, error: { code: 'HTTP_429', message: 'Rate limited — too many requests' } }
      }
      if (status >= 400 && status < 500) return { success: false, status, error: { code: `HTTP_${status}`, message: text.substring(0, 300) } }
      if (status >= 500) return { success: false, status, error: { code: `HTTP_${status}`, message: 'Provider server error' } }

      let json: any = null
      if (text.trim()) {
        try { json = JSON.parse(text) } catch { json = null }
      }
      return { success: true, status, data: json }
    } catch (e: any) {
      const code = e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR'
      return { success: false, error: { code, message: code === 'TIMEOUT' ? 'Request timed out' : `US-Matrix request failed: ${String(e?.message || '').slice(0, 200)}` } }
    }
  }

  /** Runtime login: POST /api/v1/whitelist/signin with the documented DTO fields. */
  async authenticate(credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not found' } }

    // Documented SigninRequestDTO fields ONLY: email + password (never guessed).
    const email = (credentials.email || credentials.username || '').trim()
    const password = (credentials.password || '').trim()
    if (!email || !password) {
      return { success: false, error: { code: 'CREDENTIALS_MISSING', message: 'Email and password are required' } }
    }

    const body: UsMatrixSigninRequest = { email, password }
    const result = await this.request('signin', { method: 'POST', body, requireAuth: false })
    if (!result.success) return { success: false, error: result.error }

    const data = result.data as UsMatrixSigninResponse | null
    const token = data?.token || ''
    if (!token) return { success: false, error: { code: 'NO_TOKEN', message: 'No token returned from signin' } }

    // Persist the runtime token (encrypted at rest) so subsequent requests work.
    await prisma.provider.update({
      where: { id: this.providerId },
      data: { apiToken: encryptToken(token), lastSuccessfulConnection: new Date(), lastError: null, errorCount: 0 },
    }).catch(() => {})

    return {
      success: true,
      data: { token, accountInfo: { authMethod: 'whitelist_signin' } },
    }
  }

  async getTokenState(): Promise<TokenState> {
    const config = await this.loadConfig()
    return {
      tokenPresent: !!config?.token,
      expiryPresent: false, // no documented expiry
      expired: false,
      expiresSoon: false,
      tokenExpiry: null,
    }
  }

  async ensureAuthenticated(): Promise<ConnectorResult<void>> {
    const config = await this.loadConfig()
    if (!config?.token) return { success: false, error: { code: 'NO_TOKEN', message: 'Not authenticated — run Save & Authenticate' } }
    return { success: true }
  }

  async refreshAuthentication(): Promise<boolean> {
    // No documented token expiry/refresh — never guess.
    return false
  }

  /** Login → GET /api/v1/clients/current. No provider mutation. */
  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not found' } }
    if (!config.token) return { success: false, error: { code: 'NO_TOKEN', message: 'Not authenticated — run Save & Authenticate first' } }

    const start = Date.now()
    const result = await this.request('currentClient')
    const latencyMs = Date.now() - start
    if (!result.success) return { success: false, error: result.error }

    await prisma.provider.update({
      where: { id: this.providerId },
      data: result.success ? { lastSuccessfulConnection: new Date(), lastError: null, errorCount: 0 } : {},
    }).catch(() => {})

    return { success: true, data: { message: `Connected to US-Matrix (${latencyMs}ms)`, latencyMs } }
  }

  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    const config = await this.loadConfig()
    const path = usMatrixEndpointPath('currentClient')
    const result = await this.request('currentClient')
    return {
      success: result.success,
      data: {
        connectorClass: 'UsMatrixConnector',
        method: 'GET',
        baseUrl: config?.apiBaseUrl || '',
        authUrl: buildUsMatrixUrl(config?.apiBaseUrl || '', 'signin'),
        path,
        finalUrl: config ? buildUsMatrixUrl(config.apiBaseUrl, 'currentClient') : '',
        tokenPlacement: 'HEADER',
        authType: 'LOGIN_TOKEN',
        authHeaderPresent: !!config?.token,
        tokenReplaced: false,
        responseStatus: result.status ?? null,
        responseContentType: result.status ? 'application/json' : null,
        responseBody: result.success ? redactForDiagnostics(result.data) : null,
        latencyMs: null,
        warnings: [],
        errorClassification: result.success ? null : (result.error?.code || 'UNKNOWN'),
      },
      error: result.error,
    }
  }

  // ── Catalog discovery (read-only) ──────────────────────────────────────

  /** GET /api/v1/packages — defensive mapping from the documented package shape. */
  async listPackages(): Promise<ConnectorResult<{ items: UsMatrixPackage[]; total: number }>> {
    const result = await this.request('packages', { query: { page: 1, perPage: 100 } })
    if (!result.success) return { success: false, error: result.error }
    const page = result.data as UsMatrixPaginated<UsMatrixPackage> | null
    const items = Array.isArray(page?.data) ? page.data : (Array.isArray(result.data) ? result.data : [])
    return {
      success: true,
      data: { items, total: page?.meta?.totalItems ?? items.length },
    }
  }

  /** Catalog sync → ConnectorPlan[]. Read-only GET /api/v1/packages. */
  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    const list = await this.listPackages()
    if (!list.success || !list.data) return { success: false, error: list.error }

    const plans: ConnectorPlan[] = (list.data.items || [])
      .map((p): ConnectorPlan | null => {
        if (!p?.id || !p.name) return null
        return {
          id: String(p.id),
          name: String(p.name),
          data_gb: p.dataLimit != null ? Number(p.dataLimit) : (p.limit ?? 0),
          validity_days: 30, // no validity field documented; conservative default
          price_usd: p.price != null ? Number(p.price) : 0,
          currency: 'USD', // documented as USD; no currency field in the API
          description: String(p.name),
          sku: p.code ? String(p.code) : String(p.id),
          raw_data: p,
        }
      })
      .filter((p): p is ConnectorPlan => p !== null)

    return { success: true, data: plans }
  }

  // ── eSIM inventory (read-only) ─────────────────────────────────────────

  /** GET /api/v1/esims?iccid=… — EsimDTO carries install fields. */
  async listEsims(query: { iccid?: string; status?: string; page?: number; perPage?: number } = {}): Promise<ConnectorResult<{ items: UsMatrixEsim[]; total: number }>> {
    const result = await this.request('esims', {
      query: {
        page: query.page || 1,
        perPage: query.perPage || 100,
        ...(query.iccid ? { iccid: query.iccid } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
    })
    if (!result.success) return { success: false, error: result.error }
    const page = result.data as UsMatrixPaginated<UsMatrixEsim> | null
    const items = Array.isArray(page?.data) ? page.data : (Array.isArray(result.data) ? result.data : [])
    return {
      success: true,
      data: { items, total: page?.meta?.totalItems ?? items.length },
    }
  }

  /** Historical installation recovery via documented EsimDTO install fields. */
  async lookupInstallationData(input: InstallationLookupInput): Promise<InstallationLookupResult> {
    if (!input.iccid) {
      return { success: false, state: 'PERMANENT_FAILURE', errorCode: 'IDENTIFIER_MISSING', diagnostics: { methodUsed: 'esims', identifierType: 'none' } }
    }
    const result = await this.listEsims({ iccid: input.iccid })
    if (!result.success || !result.data) {
      if (result.error?.code === 'HTTP_401' || result.error?.code === 'HTTP_403') {
        return { success: false, state: 'PERMANENT_FAILURE', errorCode: 'PROVIDER_AUTH_FAILED', diagnostics: { methodUsed: 'esims', identifierType: 'iccid' } }
      }
      return { success: false, state: 'NOT_AVAILABLE_YET', errorCode: result.error?.code === 'HTTP_404' ? 'PROVIDER_HTTP_ERROR' : (result.error?.code || 'PROVIDER_TIMEOUT'), diagnostics: { methodUsed: 'esims', identifierType: 'iccid' } }
    }

    const sim = (result.data.items || []).find((s) => s.iccid === input.iccid)
    if (!sim) {
      return { success: false, state: 'NOT_AVAILABLE_YET', errorCode: 'NO_INSTALL_DATA', diagnostics: { methodUsed: 'esims', identifierType: 'iccid', note: 'No matching eSIM in inventory (GET /api/v1/esims).' } }
    }

    // EsimDTO (documented): smDpAddress / activationCode / qrcodeString (LPA).
    const data: ConnectorInstallDataOutput = {
      ...(sim.smDpAddress ? { smdpAddress: String(sim.smDpAddress) } : {}),
      ...(sim.activationCode ? { activationCode: String(sim.activationCode) } : {}),
      ...(sim.qrcodeString ? { qrCode: String(sim.qrcodeString) } : {}),
    }
    if (hasUsableInstallData(data)) {
      return {
        success: true,
        state: 'READY',
        data,
        diagnostics: { methodUsed: 'esims', identifierType: 'iccid', httpMethod: 'GET', endpointName: 'esims', responseKeys: Object.keys(sim) },
      }
    }
    return {
      success: false,
      state: 'NOT_AVAILABLE_YET',
      errorCode: 'NO_INSTALL_DATA',
      diagnostics: { methodUsed: 'esims', identifierType: 'iccid', httpMethod: 'GET', endpointName: 'esims', responseKeys: Object.keys(sim), note: 'EsimDTO found but no install fields present.' },
    }
  }

  // ── Purchase / activation ─────────────────────────────────────────────────

  /**
   * Canonical purchase via POST /api/v1/esims/assign-package (documented,
   * synchronous, success = 201). AssignPackageRequestDTO { package, client? }.
   * The returned AssignPackageResponseDTO carries the eSIM + install data.
   *
   * Billable/mutating: NEVER retried on ambiguous network timeout. The OneSIM
   * orchestrator owns idempotency/duplicate protection (providerPurchaseKey,
   * provider-attempt dedupe). This connector performs exactly ONE request.
   */
  async activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not found' } }
    if (!config.token) return { success: false, error: { code: 'NO_TOKEN', message: 'Not authenticated — run Save & Authenticate first' } }

    // params.planId is OneSIM's ProviderPackage.providerPlanId (the US-Matrix
    // package UUID). Never send a local OneSIM id upstream.
    if (!params.planId) return { success: false, error: { code: 'INVALID_REQUEST', message: 'Provider package id (planId) is required for purchase' } }

    const body: AssignPackageRequestDTO = { package: String(params.planId) }
    // Optional client UUID for whitelisted backend integrations — only when configured.
    if (typeof (config as any).clientId === 'string' && (config as any).clientId) {
      body.client = String((config as any).clientId)
    }

    const result = await this.request('esimAssignPackage', { method: 'POST', body })
    if (!result.success) return { success: false, error: result.error }

    const resp = result.data as AssignPackageResponseDTO | null
    if (!resp || !resp.id || !resp.iccid) {
      return { success: false, error: { code: 'INVALID_RESPONSE', message: 'AssignPackageResponseDTO missing id/iccid' } }
    }

    const rawMetadata: Record<string, any> = {
      providerEsimId: String(resp.id),
      profile: resp.profile != null ? String(resp.profile) : null,
      assignedAt: new Date().toISOString(),
    }

    return {
      success: true,
      data: {
        // The provider eSIM id is the canonical provider reference for future lookups.
        activationId: String(resp.id),
        iccids: [String(resp.iccid)],
        iccidOrSimId: String(resp.id),
        activationCodes: resp.activationCode ? [String(resp.activationCode)] : [],
        // qrcodeString is the QR/LPA payload — map to qrCode, NOT qrCodeUrl.
        qrCode: resp.qrcodeString ? String(resp.qrcodeString) : undefined,
        smdpAddress: resp.smDpAddress ? String(resp.smDpAddress) : undefined,
        // Do not conflate matchingId with the full activation code — extract the
        // matching id component from the LPA payload when it is present.
        matchingId: extractMatchingId(resp.qrcodeString || resp.activationCode) || undefined,
        // 'READY' = package assigned + installation credentials delivered. This is
        // the neutral "provisioned / ready to install" state — NOT device ACTIVE
        // (US-Matrix assign-package does not prove network activation). 'READY' is
        // NOT in the global AWAITING_STATUSES list, so the orchestrator completes
        // synchronously (correct: the endpoint returns the final assigned eSIM).
        status: 'READY',
        rawMetadata,
      },
    }
  }

  /**
   * Validate purchase readiness: configured + authenticated. Called before any
   * wallet hold / dispatch. No provider call — config-only.
   */
  async validatePurchase(): Promise<{ valid: boolean; reason?: string }> {
    const config = await this.loadConfig()
    if (!config) return { valid: false, reason: 'US-Matrix provider not configured' }
    if (!config.token) return { valid: false, reason: 'Not authenticated — run Save & Authenticate first' }
    return { valid: true }
  }

  /**
   * Resolve the provider eSIM UUID for an identifier. US-Matrix suspend/resume
   * accept eSIM UUIDs or ICCIDs; usage needs packageEsimId (separate resolver).
   */
  private resolveEsimIdentifier(identifier: string | StatusLookupIdentifier): string {
    if (typeof identifier === 'string') return identifier
    return identifier.iccid || ''
  }

  /** POST /api/v1/esims/suspend — documented SuspendEsimRequestDTO { esims: [] }. */
  async suspendESIM(identifier: string | StatusLookupIdentifier): Promise<ConnectorResult<EsimLifecycleResult>> {
    const esim = this.resolveEsimIdentifier(identifier)
    if (!esim) return { success: false, error: { code: 'INVALID_REQUEST', message: 'eSIM UUID or ICCID required to suspend' } }
    const body: SuspendEsimRequestDTO = { esims: [esim] }
    const result = await this.request('esimSuspend', { method: 'PUT', body })
    if (!result.success) return { success: false, error: result.error }
    return { success: true, data: { status: 'SUSPENDED', providerStatus: 'suspended', message: 'eSIM suspended' } }
  }

  /** PUT /api/v1/esims/unsuspend — documented UnsuspendEsimRequestDTO { esims: [] }. */
  async resumeESIM(identifier: string | StatusLookupIdentifier): Promise<ConnectorResult<EsimLifecycleResult>> {
    const esim = this.resolveEsimIdentifier(identifier)
    if (!esim) return { success: false, error: { code: 'INVALID_REQUEST', message: 'eSIM UUID or ICCID required to unsuspend' } }
    const body: UnsuspendEsimRequestDTO = { esims: [esim] }
    const result = await this.request('esimUnsuspend', { method: 'PUT', body })
    if (!result.success) return { success: false, error: result.error }
    return { success: true, data: { status: 'ACTIVE', providerStatus: 'active', message: 'eSIM unsuspended' } }
  }

  /**
   * POST /api/v1/packages/usage — keyed by packageEsimId (the package-eSIM
   * association UUID). Resolved from stored provider metadata (rawMetadata /
   * providerResponse). NEVER sends local esim.id / package id / ICCID.
   */
  async getUsage(identifier: string | StatusLookupIdentifier): Promise<ConnectorResult<UsageResult>> {
    if (typeof identifier !== 'string') {
      return { success: false, error: { code: 'IDENTIFIER_MISSING', message: 'US-Matrix usage requires a provider packageEsimId' } }
    }
    // packageEsimId must be a provider association UUID, not a local id or ICCID.
    if (!identifier || identifier === '' || /^\d{16,22}$/.test(identifier)) {
      return { success: false, error: { code: 'INVALID_IDENTIFIER', message: 'US-Matrix usage requires the provider packageEsimId (package-eSIM association UUID)' } }
    }
    const body: GetPackageUsageRequestDTO = { packageEsimId: identifier }
    const result = await this.request('packageUsage', { method: 'POST', body })
    if (!result.success) return { success: false, error: result.error }

    const resp = result.data as GetPackageUsageResponseDTO | null
    const detail = resp?.package
    const group: RateGroupDTO | undefined = Array.isArray(detail?.rate_groups) ? detail.rate_groups[0] : undefined
    if (!detail || !group) {
      return { success: false, error: { code: 'INVALID_RESPONSE', message: 'GetPackageUsageResponseDTO missing package/rate_groups' } }
    }

    const allowance = Number(group.rate_group_allowance) || 0
    const usage = Number(group.rate_group_usage) || 0
    const isGB = /gb/i.test(group.rate_group_allow_qtyp || '')
    const toMB = (v: number) => isGB ? v * 1024 : v
    const dataTotalMB = toMB(allowance)
    const dataUsedMB = Math.round(toMB(usage))
    const dataRemainingMB = dataTotalMB > 0 ? Math.max(0, Math.round(dataTotalMB - dataUsedMB)) : undefined
    const percentageUsed = dataTotalMB > 0 ? Math.min(100, Math.max(0, Math.round((dataUsedMB / dataTotalMB) * 100))) : undefined

    return {
      success: true,
      data: {
        iccid: identifier,
        dataUsedMB,
        dataTotalMB: dataTotalMB > 0 ? dataTotalMB : undefined,
        dataRemainingMB,
        percentageUsed,
        expiresAt: group.rate_group_expire ? String(group.rate_group_expire) : undefined,
        status: detail.status || undefined,
        rawMetadata: {
          package_status: detail.package_status,
          rate_group_id: group.rate_group_id,
          rate_group_starttime: group.rate_group_starttime,
          rate_group_expire: group.rate_group_expire,
          rate_group_days_used: group.rate_group_days_used,
        },
      },
    }
  }

  // ── Read-only helpers (availability / countries) ─────────────────────────

  /** POST /api/v1/esims/availability-count — batch free-to-sell counts per package. */
  async availabilityCount(packageIds: string[], clientId?: string): Promise<ConnectorResult<Record<string, number>>> {
    if (!Array.isArray(packageIds) || packageIds.length === 0) {
      return { success: false, error: { code: 'INVALID_REQUEST', message: 'packageIds array is required' } }
    }
    const body: AvailabilityCountRequestDTO = { packageIds: packageIds.map(String) }
    if (clientId) body.clientId = String(clientId)
    const result = await this.request('esimAvailabilityCount', { method: 'POST', body })
    if (!result.success) return { success: false, error: result.error }
    const counts = (result.data as { counts?: Record<string, number> })?.counts || {}
    return { success: true, data: counts }
  }

  /** GET /api/v1/esims/availability-count/{packageId} — single-package free-to-sell count. */
  async availabilityCountForPackage(packageId: string, clientId?: string): Promise<ConnectorResult<number>> {
    if (!packageId) return { success: false, error: { code: 'INVALID_REQUEST', message: 'packageId is required' } }
    const result = await this.request('esimAvailabilityCountForPackage', {
      pathParams: { package_id: packageId },
      ...(clientId ? { query: { clientId } } : {}),
    })
    if (!result.success) return { success: false, error: result.error }
    const count = Number((result.data as { count?: number })?.count) || 0
    return { success: true, data: count }
  }

  /** GET /api/v1/countries — documented read-only coverage list. */
  async listCountries(): Promise<ConnectorResult<CountryDTO[]>> {
    const result = await this.request('countries', { query: { page: 1, perPage: 100 } })
    if (!result.success) return { success: false, error: result.error }
    const data = result.data as ListCountriesResponseDTO | null
    const items = Array.isArray(data?.data) ? data.data : (Array.isArray(result.data) ? result.data : [])
    return { success: true, data: items }
  }

  // ── Unwired / unsafe operations ─────────────────────────────────────────

  resolveStatusLookup(_esim: StatusLookupEsim): string | null {
    // Status not wired — never return a local OneSIM id upstream.
    return null
  }

  async getStatus(_identifier: string | import('./connector-interface').StatusLookupIdentifier): Promise<ConnectorResult<StatusResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Status lookup not wired for US-Matrix (GET /esims status enum free/assigned/suspended is allocation state, not proven OneSIM lifecycle)' } }
  }

  async topUpESIM(_params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Top-up not wired for US-Matrix (no documented top-up endpoint; assign-package is not top-up)' } }
  }

  async getRates(): Promise<ConnectorResult<RateResult[]>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Rates not implemented' } }
  }

  async getQRCode(_iccid: string): Promise<ConnectorResult<import('./connector-interface').QRCodeResult>> {
    // POST /esims/qrcode is a flag-update ("mark as QR generated"), never a QR
    // generator — do NOT wire it for historical recovery. Use lookupInstallationData.
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Use lookupInstallationData (GET /esims); POST /esims/qrcode is a flag-update, not a QR generator' } }
  }
}

export { maskIccid }
