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
import { usMatrixEndpointPath, buildUsMatrixUrl, normalizeUsMatrixBaseUrl, type UsMatrixEndpoint, type UsMatrixPaginated, type UsMatrixPackage, type UsMatrixEsim, type UsMatrixEsimsQuery, type UsMatrixSigninRequest, type UsMatrixSigninResponse, type AssignPackageRequestDTO, type AssignPackageResponseDTO, type AddEsimInPackagesRequestDTO, type AddEsimInPackagesResponseEnvelope, type GetPackageUsageRequestDTO, type GetPackageUsageResponseDTO, type RateGroupDTO, type SuspendEsimRequestDTO, type UnsuspendEsimRequestDTO, type RemoveEsimFromPackageRequestDTO, type AvailabilityCountRequestDTO, type CountryDTO, type ListCountriesResponseDTO, type GetEsimInfoRequestDTO, type GetEsimInfoResponseDTO, type ActivationProfileDTO, type ProfileLogDTO, type NetworkEventLogDTO, type LocationLogsRequestDTO, type MobileDetailPackageEsimDTO, type UsMatrixPackageInventoryStatus, type PackageInventoryStatusResult, DEFAULT_MAX_ADD_ESIMS_ASSOCIATIONS, ABSOLUTE_MAX_ADD_ESIMS_ASSOCIATIONS, DEFAULT_ESIMS_PAGE_SIZE, MAX_ESIMS_PAGE_SIZE } from './usmatrix-endpoints'
import type { IProviderConnector, ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, TopUpESIMParams, TopUpESIMResult, UsageResult, StatusResult, RateResult, TokenState, EsimLifecycleResult, ConnectorCapabilities, ConnectorAuthProfile, InstallationLookupInput, InstallationLookupResult, ConnectorInstallDataOutput, DiagnosticInfo, StatusLookupEsim, StatusLookupIdentifier, AssignPackagesToEsimsInput, AssignPackagesToEsimsResult } from './connector-interface'
import { hasUsableInstallData } from '@/lib/esim/installation-data'

interface UsMatrixConfig {
  apiBaseUrl: string
  token: string | null
  timeoutMs: number
  /** Optional US-Matrix client UUID for whitelisted backend integrations. */
  clientId?: string | null
  /** Operator ceiling for a single add-esims operation (Cartesian association count). */
  maxAddEsimsAssociations: number
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

/**
 * Build the normalized add-esims association PLAN from raw eSIM/package lists.
 * Pure and side-effect free.
 *
 * - trims and drops blank entries,
 * - preserves first-seen order,
 * - deduplicates repeated eSIM UUIDs,
 * - deduplicates repeated package UUIDs,
 * - computes the Cartesian association count (unique esims × unique packages).
 *
 * A non-empty plan has `associationCount === esimIds.length * packageIds.length`.
 * Returns `null` when either list is empty after normalization (invalid before
 * transport). Previews (admin confirmation) and the mutation share this helper,
 * so the count the operator confirms is exactly the count USMatrix will create.
 */
export function buildAddEsimsAssociationPlan(
  esimIds: string[] | null | undefined,
  packageIds: string[] | null | undefined,
): { esimIds: string[]; packageIds: string[]; associationCount: number } | null {
  const uniqueEsims: string[] = []
  const seenEsims = new Set<string>()
  for (const raw of esimIds || []) {
    const id = String(raw).trim()
    if (!id || seenEsims.has(id)) continue
    seenEsims.add(id)
    uniqueEsims.push(id)
  }

  const uniquePackages: string[] = []
  const seenPackages = new Set<string>()
  for (const raw of packageIds || []) {
    const id = String(raw).trim()
    if (!id || seenPackages.has(id)) continue
    seenPackages.add(id)
    uniquePackages.push(id)
  }

  if (uniqueEsims.length === 0 || uniquePackages.length === 0) return null
  return {
    esimIds: uniqueEsims,
    packageIds: uniquePackages,
    associationCount: uniqueEsims.length * uniquePackages.length,
  }
}

function redactForDiagnostics(data: unknown, maxLen = 300): string | null {
  if (data == null) return null
  try {
    return JSON.stringify(data).substring(0, maxLen)
  } catch {
    return String(data).substring(0, maxLen)
  }
}

/**
 * Strict conservative availability-count parser shared by the purchase
 * preflight and the public availability surfaces.
 *
 * ACCEPTS:
 *  - a finite number >= 0 (0 is a legitimate authoritative zero),
 *  - a non-empty numeric string (e.g. "0", "7").
 * REJECTS (returns null):
 *  - missing/null/undefined,
 *  - NaN, +/-Infinity,
 *  - negative numbers,
 *  - non-numeric strings ("lots", ""),
 *  - any other type.
 * A rejected count MUST be treated as a malformed response — never fabricated
 * as zero.
 */
function parseAvailabilityCount(raw: unknown): { ok: true; count: number } | { ok: false } {
  if (raw == null) return { ok: false }
  const count = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN)
  if (!Number.isFinite(count) || count < 0) return { ok: false }
  return { ok: true, count }
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
    statusLookup: true, // live staging evidence: DIAMETER_SUCCESS + serving_network → ACTIVE; profile ENABLED → INSTALLED
    usageLookup: true, // live staging evidence: mobile-detail.packageEsims[].id is the packageEsimId association identifier
    topUp: false, // no documented top-up endpoint; assign-package is not top-up
    suspend: true, // PUT /esims/suspend (eSIM-level) — wired
    resume: true, // PUT /esims/unsuspend (eSIM-level) — wired
    balance: false, // no wallet/balance endpoint documented
    inventory: true, // GET /esims
    catalogSync: true, // syncPlans wired to parametric retail catalog
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
      maxAddEsimsAssociations: Number.isFinite(Number(cfg.maxAddEsimsAssociations)) && Number(cfg.maxAddEsimsAssociations) > 0
        ? Math.floor(Number(cfg.maxAddEsimsAssociations))
        : DEFAULT_MAX_ADD_ESIMS_ASSOCIATIONS,
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

  /**
   * Serialize a validated GET /esims query into transport query params.
   * `allocated` is REQUIRED (preserved exactly, including `false`). Pagination
   * uses `limit`/`offset` only — never `page`/`perPage`. `ids` becomes a
   * deterministic comma-joined value. `false` booleans are preserved (the
   * transport URLSearchParams builder only drops undefined/null/empty strings).
   * `limit`/`offset` are the ALREADY-BOUNDED values (caller clamps them).
   */
  private buildEsimsQueryParams(query: UsMatrixEsimsQuery, limit: number, offset: number): Record<string, string | number | boolean | undefined> {
    const params: Record<string, string | number | boolean | undefined> = {
      allocated: query.allocated,
      limit,
      offset,
    }
    if (query.profile) params.profile = query.profile
    if (query.ids && query.ids.length > 0) {
      // Deterministic single-param serialization: ids=a,b,c (deduped, order-first-seen).
      const seen = new Set<string>()
      const joined: string[] = []
      for (const id of query.ids) {
        const clean = String(id).trim()
        if (clean && !seen.has(clean)) { seen.add(clean); joined.push(clean) }
      }
      if (joined.length > 0) params.ids = joined.join(',')
    }
    if (query.hasPackage !== undefined) params.hasPackage = query.hasPackage
    if (query.iccid) params.iccid = query.iccid
    if (query.client) params.client = query.client
    if (query.activationDate) params.activationDate = query.activationDate
    if (query.updatedAt) params.updatedAt = query.updatedAt
    if (query.status) params.status = query.status
    if (query.dataLimit !== undefined) params.dataLimit = query.dataLimit
    if (query.packageName) params.packageName = query.packageName
    return params
  }

  /** GET /api/v1/esims?allocated=…&limit=…&offset=… — EsimDTO carries install fields. */
  async listEsims(query: UsMatrixEsimsQuery = {} as UsMatrixEsimsQuery): Promise<ConnectorResult<{ items: UsMatrixEsim[]; total: number }>> {
    // `allocated` is required by the live provider (HTTP 400 without it).
    // Refuse to transport without an explicit boolean — a missing/undefined
    // value must NOT silently become a request.
    if (typeof query.allocated !== 'boolean') {
      return { success: false, error: { code: 'INVALID_REQUEST', message: 'GET /esims requires an explicit `allocated` boolean filter' } }
    }

    const limit = Math.min(
      Number.isFinite(query.limit) && query.limit! > 0 ? Math.floor(query.limit!) : DEFAULT_ESIMS_PAGE_SIZE,
      MAX_ESIMS_PAGE_SIZE,
    )
    const offset = Number.isFinite(query.offset) && query.offset! > 0 ? Math.floor(query.offset!) : 0

    const result = await this.request('esims', {
      query: this.buildEsimsQueryParams(query, limit, offset),
    })
    if (!result.success) return { success: false, error: result.error }

    const raw = result.data as any

    // Conservative envelope parsing. Documented shape is a paginated list;
    // tolerate `{ data: [...] }`, `{ data: [...], total: n }`, `{ items: [...] }`
    // and a bare array — but NEVER treat a malformed non-envelope success as an
    // empty legitimate inventory result.
    let items: UsMatrixEsim[] | null = null
    let total: number | undefined
    if (Array.isArray(raw)) {
      items = raw
      total = items.length
    } else if (raw && typeof raw === 'object') {
      const dataArr: unknown = (raw as any).data
      const itemsArr: unknown = (raw as any).items
      if (Array.isArray(dataArr) || Array.isArray(itemsArr)) {
        items = (Array.isArray(dataArr) ? dataArr : itemsArr) as UsMatrixEsim[]
        const metaTotal: unknown = (raw as any).meta?.totalItems
        const directTotal: unknown = (raw as any).total
        const n = Number(directTotal ?? metaTotal ?? items.length)
        total = Number.isFinite(n) && n >= 0 ? n : items.length
      }
    }

    if (items === null) {
      return { success: false, error: { code: 'INVALID_RESPONSE', message: 'GET /esims returned an unrecognized response shape' } }
    }

    return { success: true, data: { items, total: total ?? items.length } }
  }

  /**
   * Historical installation recovery via documented EsimDTO install fields.
   *
   * GET /esims requires an explicit `allocated` boolean, but for a historical
   * read we do NOT know which side the target eSIM is on. This performs a
   * BOUNDED deterministic search across BOTH allocated=false and allocated=true
   * (read-only), stopping when the exact ICCID is found:
   *  - exact ICCID match only (never silently selects an unrelated eSIM),
   *  - matches deduped by eSIM id,
   *  - if both sides produce DISTINCT matches for the same ICCID → AMBIGUOUS
   *    (fail safely, never pick one), surfaced as PERMANENT_FAILURE,
   *  - a first-side provider failure does NOT create a false "not found" when
   *    the second side is a safe/successful read,
   *  - never mutates.
   */
  async lookupInstallationData(input: InstallationLookupInput): Promise<InstallationLookupResult> {
    if (!input.iccid) {
      return { success: false, state: 'PERMANENT_FAILURE', errorCode: 'IDENTIFIER_MISSING', diagnostics: { methodUsed: 'esims', identifierType: 'none' } }
    }
    const iccid = String(input.iccid)

    const matches: UsMatrixEsim[] = []
    const seen = new Set<string>()
    let sawAuthError = false
    let sawTransportError = false
    let lastErrorCode: string | undefined

    // Deterministic bounded dual-side read. Read-only; never mutates.
    for (const allocated of [false, true]) {
      const result = await this.listEsims({ allocated, iccid, limit: MAX_ESIMS_PAGE_SIZE, offset: 0 })
      if (!result.success || !result.data) {
        const code = result.error?.code || ''
        if (code === 'HTTP_401' || code === 'HTTP_403') sawAuthError = true
        else if (code === 'TIMEOUT' || code === 'NETWORK_ERROR' || code === 'HTTP_404' || code === 'INVALID_RESPONSE') sawTransportError = true
        else lastErrorCode = code
        continue
      }
      for (const sim of result.data.items || []) {
        // Exact ICCID match only.
        if (String(sim.iccid) !== iccid) continue
        if (seen.has(sim.id)) continue
        seen.add(sim.id)
        matches.push(sim)
      }
    }

    if (matches.length === 0) {
      if (sawAuthError) {
        return { success: false, state: 'PERMANENT_FAILURE', errorCode: 'PROVIDER_AUTH_FAILED', diagnostics: { methodUsed: 'esims', identifierType: 'iccid' } }
      }
      if (sawTransportError) {
        return { success: false, state: 'NOT_AVAILABLE_YET', errorCode: 'PROVIDER_TIMEOUT', diagnostics: { methodUsed: 'esims', identifierType: 'iccid' } }
      }
      return { success: false, state: 'NOT_AVAILABLE_YET', errorCode: 'NO_INSTALL_DATA', diagnostics: { methodUsed: 'esims', identifierType: 'iccid', note: 'No matching eSIM in inventory (GET /api/v1/esims).' } }
    }

    // Ambiguous duplicate identity: the same ICCID resolves on BOTH allocated
    // sides to a distinct eSIM id. Fail safely (PERMANENT_FAILURE terminal —
    // refresh-qr skips further retries) — never silently select one.
    if (matches.length > 1) {
      return {
        success: false,
        state: 'PERMANENT_FAILURE',
        errorCode: 'AMBIGUOUS_IDENTITY',
        diagnostics: {
          methodUsed: 'esims', identifierType: 'iccid', httpMethod: 'GET', endpointName: 'esims',
          responseKeys: Object.keys(matches[0]),
          note: `Ambiguous identity: ICCID matched ${matches.length} distinct eSIM ids across allocated sides`,
        },
      }
    }

    // Exactly one unique match — safe to use.
    const sim = matches[0]

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

    // Pre-purchase inventory preflight (read-only, documented endpoint). When
    // the provider CONFIRMS zero assignable eSIM inventory for the requested
    // package, do NOT make the billable/mutating assign-package call. The
    // preflight is the inventory signal: an assign-package HTTP_404 is never
    // reinterpreted as out-of-stock, and a failed/unavailable/malformed
    // preflight never fabricates zero (purchase proceeds so assign-package
    // remains the authority — still exactly ONE non-retried request).
    const availability = await this.checkPackageAvailability(String(params.planId))
    console.log(`[USMATRIX_AVAILABILITY] ok=${availability.ok} count=${availability.count ?? 'n/a'} skipAssign=${availability.ok && availability.count === 0}${availability.reason ? ` reason=${availability.reason}` : ''}`)
    if (availability.ok && availability.count === 0) {
      return {
        success: false,
        error: {
          code: 'OUT_OF_STOCK',
          message: 'US-Matrix currently has no assignable eSIM inventory for the requested provider package',
        },
      }
    }

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

    // Conservative count parsing — shared strict parser matches checkPackageAvailability.
    // A count of 0 is a legitimate authoritative zero; a missing/NaN/negative/
    // infinite/malformed/non-numeric count is a FAILURE (NOT fabricated as zero).
    const parsed = parseAvailabilityCount((result.data as { count?: unknown } | null)?.count)
    if (!parsed.ok) {
      return { success: false, error: { code: 'MALFORMED_AVAILABILITY_RESPONSE', message: 'Availability-count returned a malformed count value' } }
    }
    return { success: true, data: parsed.count }
  }

  /**
   * Read-only per-package inventory status — the provider-generic inventory
   * surface that works for EVERY US-Matrix package (provider package UUID).
   *
   * Semantics (canonical, never package/country/plan special-cased):
   *  - AVAILABLE    ← authoritative count > 0
   *  - OUT_OF_STOCK ← authoritative count === 0
   *  - UNKNOWN      ← availability endpoint failed / timed out / malformed —
   *                   NEVER converted to OUT_OF_STOCK (provider/API errors must
   *                   not fabricate zero inventory).
   *
   * Purely read-only: GET /esims/availability-count/{packageId} only. This is
   * inventory ADMINISTRATION reporting, NOT customer purchase — it never calls
   * assign-package, never calls add-esims, never mutates, and never touches a
   * wallet. Assignment remains the single canonical purchase mutation in
   * activateESIM (guarded by this same availability read).
   */
  async getPackageInventoryStatus(packageId: string): Promise<ConnectorResult<PackageInventoryStatusResult>> {
    if (!packageId) return { success: false, error: { code: 'INVALID_REQUEST', message: 'packageId (provider package UUID) is required' } }
    const availability = await this.checkPackageAvailability(String(packageId))
    if (!availability.ok) {
      return {
        success: true,
        data: { packageId: String(packageId), status: 'UNKNOWN', reason: availability.reason, checkedAt: new Date().toISOString() },
      }
    }
    const count = availability.count ?? 0
    const status: UsMatrixPackageInventoryStatus = count > 0 ? 'AVAILABLE' : 'OUT_OF_STOCK'
    return {
      success: true,
      data: { packageId: String(packageId), status, count, checkedAt: new Date().toISOString() },
    }
  }

  /**
   * Explicit US-Matrix INVENTORY-MANAGEMENT capability: assign packages to
   * specific eSIM UUIDs via POST /api/v1/esims/add-esims.
   *
   * This is an ADMINISTRATION operation — it is NOT the customer purchase path.
   * It never appears in activateESIM (which stays availability-count →
   * assign-package) and never touches a wallet or order.
   *
   * Mutation safety (add-esims idempotency is NOT documented, so we mirror the
   * P0 provider-mutation philosophy):
   *  - exactly ONE HTTP POST per explicit operation,
   *  - NO automatic retry on timeout / network failure / 5xx,
   *  - NO mutation replay after a post-dispatch 401,
   *  - ambiguous transport outcomes are surfaced as AMBIGUOUS with
   *    error.details.ambiguous === true (the operator must use read-only
   *    evidence before deciding what happened),
   *  - the Cartesian association count is computed BEFORE transport and refuses
   *    to silently execute huge operations (operator ceiling).
   *
   * The response schema is NOT documented by the provider; the transport result
   * is parsed defensively as an opaque envelope. HTTP 2xx means ACCEPTED (the
   * associations were created/queued), never proof of asynchronous vendor
   * fulfillment.
   */
  async assignPackagesToEsims(input: AssignPackagesToEsimsInput): Promise<ConnectorResult<AssignPackagesToEsimsResult>> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not found' } }
    if (!config.token) return { success: false, error: { code: 'NO_TOKEN', message: 'Not authenticated — run Save & Authenticate first' } }

    const plan = buildAddEsimsAssociationPlan(input.esimIds, input.packageIds)
    if (!plan) {
      return { success: false, error: { code: 'INVALID_REQUEST', message: 'Both a non-empty eSIM UUID list and a non-empty package UUID list are required' } }
    }

    // Operator conservation ceiling — refuse a silently-huge Cartesian product.
    // The default ceiling (config or built-in) applies unless the caller raises
    // it with an explicit bounded per-call override, which itself is capped by
    // the absolute OneSIM safety bound.
    const configuredCeiling = Number.isFinite(config.maxAddEsimsAssociations) && config.maxAddEsimsAssociations > 0
      ? Math.floor(config.maxAddEsimsAssociations)
      : DEFAULT_MAX_ADD_ESIMS_ASSOCIATIONS
    const requestedCeiling = Number.isFinite(input.maxAssociations) && input.maxAssociations! > 0
      ? Math.floor(input.maxAssociations!)
      : configuredCeiling
    const ceiling = Math.min(requestedCeiling, ABSOLUTE_MAX_ADD_ESIMS_ASSOCIATIONS)
    if (plan.associationCount > ceiling) {
      return {
        success: false,
        error: {
          code: 'ASSOCIATION_LIMIT_EXCEEDED',
          message: `add-esims would create ${plan.associationCount} associations (ceiling ${ceiling}) — explicit confirmation required`,
          details: {
            esimIds: plan.esimIds,
            packageIds: plan.packageIds,
            esimCount: plan.esimIds.length,
            packageCount: plan.packageIds.length,
            associationCount: plan.associationCount,
            ceiling,
          },
        },
      }
    }

    const body: AddEsimInPackagesRequestDTO = {
      esims: plan.esimIds,
      packages: plan.packageIds,
    }
    const clientId = input.clientId || config.clientId || undefined
    if (clientId) body.client = String(clientId)

    const result = await this.request('esimAddEsims', { method: 'POST', body })

    if (!result.success) {
      const code = result.error?.code || 'UNKNOWN'
      // Conservative classification mirroring P0 provider mutation safety:
      // transport uncertainty (timeout/network) and 5xx after dispatch and a
      // post-dispatch 401 are all NON-RETRYABLE / ambiguous — never replayed.
      const ambiguous = code === 'TIMEOUT' || code === 'NETWORK_ERROR' || code === 'HTTP_401' || /^HTTP_5/.test(code)
      return {
        success: false,
        error: {
          code: ambiguous ? 'ADD_ESIMS_AMBIGUOUS' : code,
          message: result.error?.message || 'add-esims request failed',
          details: {
            ambiguous,
            mutationMayHaveLeft: ambiguous,
            esimCount: plan.esimIds.length,
            packageCount: plan.packageIds.length,
            associationCount: plan.associationCount,
            causeCode: code,
          },
        },
      }
    }

    // HTTP 2xx = accepted. Response schema undocumented → opaque envelope only.
    const envelope = result.data as AddEsimInPackagesResponseEnvelope | null
    return {
      success: true,
      data: {
        esimIds: plan.esimIds,
        packageIds: plan.packageIds,
        associationCount: plan.associationCount,
        providerAccepted: true,
        providerStatus: result.status ?? null,
        providerBody: envelope ?? null,
      },
    }
  }

  /**
   * Read-only inventory read shared by the purchase preflight (activateESIM)
   * AND the generic per-package inventory status (getPackageInventoryStatus).
   * Provider-generic — keyed by any US-Matrix provider package UUID.
   *
   * Returns:
   *  - `{ ok: true, count }` when the documented availability endpoint
   *    succeeded and returned a valid non-negative integer count.
   *  - `{ ok: false, reason }` when the endpoint failed, timed out, or returned
   *    a malformed response — the caller MUST NOT treat that as zero inventory.
   *
   * The canonical preflight is GET /esims/availability-count/{packageId}
   * (proven live). /esims/available-for-package is NOT used (live HTTP 500) and
   * the local ProviderPackage.isAvailable flag is catalog state, not inventory.
   */
  private async checkPackageAvailability(packageId: string): Promise<{ ok: boolean; count?: number; reason?: string }> {
    const result = await this.request('esimAvailabilityCountForPackage', {
      pathParams: { package_id: packageId },
    })
    if (!result.success) {
      return { ok: false, reason: result.error?.code || 'AVAILABILITY_CHECK_FAILED' }
    }
    const parsed = parseAvailabilityCount((result.data as { count?: unknown } | null)?.count)
    if (!parsed.ok) {
      return { ok: false, reason: 'MALFORMED_AVAILABILITY_RESPONSE' }
    }
    return { ok: true, count: parsed.count }
  }

  /** GET /api/v1/countries — documented read-only coverage list. */
  async listCountries(): Promise<ConnectorResult<CountryDTO[]>> {
    const result = await this.request('countries', { query: { page: 1, perPage: 100 } })
    if (!result.success) return { success: false, error: result.error }
    const data = result.data as ListCountriesResponseDTO | null
    const items = Array.isArray(data?.data) ? data.data : (Array.isArray(result.data) ? result.data : [])
    return { success: true, data: items }
  }

  // ── Status / usage evidence (read-only, provider-neutral semantics) ─────

  /**
   * Resolve the provider-owned US-Matrix eSIM UUID for a status lookup.
   * Preferred source: providerActivationId (persisted from the assign-package
   * response `id`). Fallback: providerResponse.providerEsimId when present.
   * Returns a structured bundle carrying the eSIM ICCID so the connector can
   * verify location-event identity (never promote from another eSIM's event).
   * NEVER a local OneSIM esim.id. Returns null when no provider UUID exists.
   */
  resolveStatusLookup(esim: StatusLookupEsim): string | StatusLookupIdentifier | null {
    const raw = esim.providerResponse && typeof esim.providerResponse === 'object'
      ? (esim.providerResponse as Record<string, unknown>)
      : undefined
    const providerEsimUuid = esim.providerActivationId
      || (typeof raw?.providerEsimId === 'string' ? raw.providerEsimId : '')
    if (providerEsimUuid) {
      return {
        providerActivationId: providerEsimUuid,
        ...(esim.iccid ? { iccid: esim.iccid } : {}),
      }
    }
    return null
  }

  /**
   * Resolve the US-Matrix package↔eSIM association UUID (packageEsimId) for a
   * usage lookup — the identifier required by POST /packages/usage.
   *
   * 1. When already persisted in provider metadata (packageEsimId /
   *    package_esim_id), return it directly (provider association id, safe).
   * 2. Otherwise return a structured bundle carrying the provider eSIM UUID
   *    (from providerActivationId / providerResponse.providerEsimId) PLUS the
   *    provider-owned package identity (providerPlanId / providerPackageId) so
   *    getUsage can discover AND prove the current association via
   *    mobile-detail. NEVER a local OneSIM esim.id. Returns null only when no
   *    provider identifier exists.
   */
  resolveUsageLookup(esim: StatusLookupEsim): string | StatusLookupIdentifier | null {
    const raw = esim.providerResponse && typeof esim.providerResponse === 'object'
      ? (esim.providerResponse as Record<string, unknown>)
      : undefined
    const persisted = raw?.packageEsimId ?? raw?.package_esim_id
    if (typeof persisted === 'string' && persisted && !/^\d{16,22}$/.test(persisted)) {
      return persisted
    }
    // Not persisted → return the provider eSIM UUID so getUsage can discover the
    // association via mobile-detail (documented read-only), plus package identity
    // so a multi-association eSIM resolves deterministically (never index 0).
    const providerEsimUuid = esim.providerActivationId
      || (typeof raw?.providerEsimId === 'string' ? raw.providerEsimId : '')
    if (providerEsimUuid) {
      return {
        providerActivationId: providerEsimUuid,
        ...(esim.providerPlanId ? { providerPlanId: esim.providerPlanId } : {}),
        ...(esim.providerPackageId ? { providerPackageId: esim.providerPackageId } : {}),
      }
    }
    return null
  }

  /**
   * Discover the current package↔eSIM association via GET /esims/mobile-detail/{id}
   * (documented read-only). Deterministic + safe selection:
   *   - exactly one packageEsims[] association → may be selected directly
   *   - multiple associations → require an EXACT provider-package identity match
   *     (packageEsims[].package.id vs the canonical providerPlanId/providerPackageId);
   *     NEVER blindly select index 0 / "first active"
   *   - no unique provable association → AMBIGUOUS_ASSOCIATION (safe skip, no usage call)
   *   - zero associations → NO_ASSOCIATION (safe skip)
   * NEVER uses package.id as the association id.
   */
  private async discoverPackageEsimId(providerEsimUuid: string, expectedPackageIds: string[] = []): Promise<{ ok: boolean; packageEsimId?: string; error?: { code: string; message: string } }> {
    const result = await this.request('esimMobileDetail', { pathParams: { esim_id: providerEsimUuid } })
    if (!result.success) return { ok: false, error: result.error }

    const data = result.data as any
    const associations: MobileDetailPackageEsimDTO[] = Array.isArray(data?.packageEsims)
      ? data.packageEsims
      : Array.isArray(data?.data?.packageEsims) ? data.data.packageEsims
      : []

    if (associations.length === 0) {
      return { ok: false, error: { code: 'NO_ASSOCIATION', message: 'mobile-detail returned no packageEsims for this eSIM' } }
    }

    const idOf = (a: MobileDetailPackageEsimDTO): string | null => (a?.id ? String(a.id) : null)

    // Exactly one association → the only proof available; select it directly.
    if (associations.length === 1) {
      const id = idOf(associations[0])
      return id
        ? { ok: true, packageEsimId: id }
        : { ok: false, error: { code: 'NO_ASSOCIATION', message: 'mobile-detail association missing id (packageEsimId)' } }
    }

    // Multiple associations → deterministic provider-package identity match.
    const expected = expectedPackageIds.map(String).filter(Boolean)
    const matches = expected.length
      ? associations.filter(a => expected.includes(String(a?.package?.id || '')))
      : []
    if (matches.length === 1) {
      const id = idOf(matches[0])
      return id
        ? { ok: true, packageEsimId: id }
        : { ok: false, error: { code: 'AMBIGUOUS_ASSOCIATION', message: 'Matched association missing id (packageEsimId)' } }
    }

    return {
      ok: false,
      error: {
        code: 'AMBIGUOUS_ASSOCIATION',
        message: `mobile-detail returned ${associations.length} package associations with no unique provider-package match; refusing to guess`,
      },
    }
  }

  /**
   * Canonical US-Matrix usage lookup.
   *
   * Identifier resolution:
   *   - a persisted/known packageEsimId → used directly (fast path, no discovery)
   *   - a structured { providerActivationId, providerPlanId? } bundle →
   *     discovered via mobile-detail with deterministic association matching
   *
   * Then POST /packages/usage and normalize rate groups with unit handling.
   * The packageEsimId used is returned as `providerPackageEsimId` so the
   * canonical service can persist it (future lookups skip discovery).
   */
  async getUsage(identifier: string | StatusLookupIdentifier): Promise<ConnectorResult<UsageResult>> {
    let packageEsimId: string | null = null

    if (typeof identifier === 'string') {
      // Reject ICCID-shaped / empty values — packageEsimId is a UUID.
      if (!identifier || /^\d{16,22}$/.test(identifier)) {
        return { success: false, error: { code: 'INVALID_IDENTIFIER', message: 'US-Matrix usage requires the provider packageEsimId (package-eSIM association UUID)' } }
      }
      packageEsimId = identifier
    } else if (identifier && typeof identifier === 'object') {
      // Discovery key: the provider eSIM UUID only. Never guess from an ICCID.
      const providerEsimUuid = identifier.providerActivationId
      if (!providerEsimUuid) {
        return { success: false, error: { code: 'IDENTIFIER_MISSING', message: 'US-Matrix usage requires the provider eSIM UUID to discover the package association' } }
      }
      const expectedPackageIds = [identifier.providerPlanId, identifier.providerPackageId].filter((v): v is string => typeof v === 'string' && !!v)
      const discovered = await this.discoverPackageEsimId(providerEsimUuid, expectedPackageIds)
      if (!discovered.ok) return { success: false, error: discovered.error }
      packageEsimId = discovered.packageEsimId!
    } else {
      return { success: false, error: { code: 'IDENTIFIER_MISSING', message: 'US-Matrix usage requires a packageEsimId or provider eSIM UUID' } }
    }

    const body: GetPackageUsageRequestDTO = { packageEsimId }
    const result = await this.request('packageUsage', { method: 'POST', body })
    if (!result.success) return { success: false, error: result.error }

    const resp = result.data as GetPackageUsageResponseDTO | null
    const detail = resp?.package
    const groups: RateGroupDTO[] = Array.isArray(detail?.rate_groups) ? detail.rate_groups : []
    if (!detail || groups.length === 0) {
      return { success: false, error: { code: 'INVALID_RESPONSE', message: 'GetPackageUsageResponseDTO missing package/rate_groups' } }
    }

    // Sum allowance/usage across rate groups without double-counting. The
    // canonical total allowance is rate_group_total_qty when present (it is the
    // actual quantity); otherwise rate_group_allowance. Units normalize GB→MB.
    const unitToMB = (unit: string | null | undefined): number => {
      const u = String(unit || '').toLowerCase()
      if (u === 'gb') return 1024
      if (u === 'mb') return 1
      if (u === 'kb') return 1 / 1024
      if (u === 'b' || u === 'bytes') return 1 / (1024 * 1024)
      return 1 // default MB
    }

    let totalMB = 0
    let usedMB = 0
    let earliestStart: string | undefined
    let latestExpire: string | undefined
    let daysUsed = 0

    for (const group of groups) {
      const unit = group.rate_group_allow_qtyp || group.rate_group_throttle_qtyp
      const toMB = unitToMB(unit)
      const allowance = Number(group.rate_group_allowance) || 0
      const totalQty = Number(group.rate_group_total_qty) || 0
      const usage = Number(group.rate_group_usage) || 0
      // Canonical total: prefer total_qty (actual quantity), fall back to allowance.
      const groupTotal = totalQty > 0 ? totalQty : allowance
      totalMB += groupTotal * toMB
      usedMB += usage * toMB
      if (group.rate_group_starttime && (!earliestStart || group.rate_group_starttime < earliestStart)) earliestStart = group.rate_group_starttime
      if (group.rate_group_expire && (!latestExpire || group.rate_group_expire > latestExpire)) latestExpire = group.rate_group_expire
      daysUsed = Math.max(daysUsed, Number(group.rate_group_days_used) || 0)
    }

    const dataTotalMB = totalMB > 0 ? Math.round(totalMB) : undefined
    const dataUsedMB = Math.round(usedMB)
    const dataRemainingMB = dataTotalMB != null ? Math.max(0, dataTotalMB - dataUsedMB) : undefined
    const percentageUsed = dataTotalMB != null && dataTotalMB > 0 ? Math.min(100, Math.max(0, Math.round((dataUsedMB / dataTotalMB) * 100))) : undefined

    return {
      success: true,
      data: {
        // iccid field is required by the interface; this is the provider
        // packageEsimId (safe, non-local). The sync layer supplies the real
        // eSIM identity from the ESIM row.
        iccid: packageEsimId,
        // Provider association id used/discovered → canonical layer persists it
        // so subsequent usage syncs skip mobile-detail discovery.
        providerPackageEsimId: packageEsimId,
        dataUsedMB,
        dataTotalMB,
        dataRemainingMB,
        percentageUsed,
        expiresAt: latestExpire ? String(latestExpire) : undefined,
        status: detail.status || undefined,
        rawMetadata: {
          package_status: detail.package_status,
          rateGroupCount: groups.length,
          earliestStart,
          latestExpire,
          daysUsed,
        },
      },
    }
  }

  /**
   * Canonical US-Matrix status lookup — read-only, evidence-based.
   *
   * Uses the documented POST /esims/info (vendor profile + profile logs) and
   * network event logs (POST /esims/location-event-logs). Maps evidence
   * conservatively:
   *   - suspended            → SUSPENDED
   *   - latest successful DIAMETER_SUCCESS + serving_network → ACTIVE
   *   - profile ENABLED / INSTALLED (no network attach) → INSTALLED
   *   - assigned / provisioned only → PENDING_ACTIVATION
   *
   * This connector owns provider-specific interpretation; the global lifecycle
   * engine applies the canonical monotonic rules. Never manufactures ACTIVE
   * from ENABLE alone, assigned, linked, QR, or API success.
   */
  async getStatus(identifier: string | StatusLookupIdentifier): Promise<ConnectorResult<StatusResult>> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not found' } }
    if (!config.token) return { success: false, error: { code: 'NO_TOKEN', message: 'Not authenticated — run Save & Authenticate first' } }

    const target = typeof identifier === 'string'
      ? { providerActivationId: identifier as string, iccid: null as string | null }
      : {
          providerActivationId: (identifier as StatusLookupIdentifier)?.providerActivationId || '',
          iccid: (identifier as StatusLookupIdentifier)?.iccid || null,
        }
    const esimUuid = target.providerActivationId
    if (!esimUuid) return { success: false, error: { code: 'IDENTIFIER_MISSING', message: 'Provider eSIM UUID required for status lookup' } }

    // 1) Vendor profile info (documented read-only). The exact response
    //    envelope is { activationProfile, profileLogs } — read directly.
    const infoBody: GetEsimInfoRequestDTO = { esimId: esimUuid }
    const infoResult = await this.request('esimInfo', { method: 'POST', body: infoBody })
    if (!infoResult.success && infoResult.error?.code === 'HTTP_401') {
      return { success: false, error: infoResult.error }
    }

    const info = infoResult.success ? infoResult.data as GetEsimInfoResponseDTO | null : null
    const profile: ActivationProfileDTO | undefined = info?.activationProfile
    const profileLogs: ProfileLogDTO[] = Array.isArray(info?.profileLogs) ? info.profileLogs : []

    // 2) Network attach evidence (read-only event logs). The exact response
    //    envelope is { search_id, page_number, total_pages, data: [...] } —
    //    events live at response.data.data.
    let networkAttach = false
    let attachEvent: NetworkEventLogDTO | null = null
    const eventBody: LocationLogsRequestDTO = { esimId: esimUuid, page: 1, pageSize: 20 }
    const eventResult = await this.request('esimLocationEventLogs', { method: 'POST', body: eventBody }).catch(() => ({ success: false }))
    if (eventResult.success) {
      const eventData = (eventResult as any).data
      // Real envelope: { ..., data: [...] }. Tolerate a bare array defensively,
      // but the canonical read is response.data.data.
      const events: NetworkEventLogDTO[] = Array.isArray(eventData)
        ? eventData
        : Array.isArray(eventData?.data) ? eventData.data
        : []

      // A successful attach is ONLY evidence for the exact target eSIM: skip
      // any event whose iccid disagrees with the eSIM being synchronized (when
      // both are known). The endpoint is scoped to the provider eSIM UUID, so
      // an event without an iccid is accepted (documented safe policy).
      const matchesTarget = (e: NetworkEventLogDTO): boolean => {
        const eventIccid = e?.iccid ? String(e.iccid) : null
        if (eventIccid && target.iccid && eventIccid !== target.iccid) return false
        return true
      }

      for (const e of events) {
        const status = String(e?.request_status || '').toUpperCase()
        const isSuccess = status === 'DIAMETER_SUCCESS' || status === 'SUCCESS' || status === 'OK'
        if (!isSuccess) continue
        if (!(e?.serving_network || e?.network_type)) continue
        if (!matchesTarget(e)) continue
        // Select the NEWEST valid event deterministically (event_time is the
        // provider timestamp), so stale history never overrides fresh attach.
        if (!attachEvent || (e.event_time && (!attachEvent.event_time || e.event_time > attachEvent.event_time))) {
          attachEvent = e
        }
      }
      networkAttach = attachEvent != null
    }

    // 3) Evidence-based normalization (provider-neutral status vocabulary).
    const profileStatus = String(profile?.status || '').toUpperCase()
    const logStates = profileLogs.map(l => String(l?.status || '').toUpperCase())

    if (profileStatus === 'SUSPENDED' || logStates.includes('SUSPENDED')) {
      return { success: true, data: { status: 'SUSPENDED', rawStatus: 'suspended', rawMetadata: { source: 'esims/info' } } }
    }
    if (networkAttach && attachEvent) {
      // Verified successful network attach for the exact eSIM → ACTIVE evidence.
      const observedAt = attachEvent.event_time ? String(attachEvent.event_time) : undefined
      return {
        success: true,
        data: {
          status: 'ACTIVE',
          rawStatus: 'network_attach',
          evidence: { networkAttached: true, observedAt, reason: 'diameter-success-attach' },
          rawMetadata: {
            source: 'esims/location-event-logs',
            networkAttached: true,
            servingNetwork: attachEvent.serving_network ? String(attachEvent.serving_network) : null,
            networkType: attachEvent.network_type ? String(attachEvent.network_type) : null,
            countryNetwork: attachEvent.country_network ? String(attachEvent.country_network) : null,
            observedAt,
            reason: 'diameter-success-attach',
          },
        },
      }
    }
    if (profileStatus === 'ENABLED' || profileStatus === 'ENABLE' || logStates.includes('ENABLED') || logStates.includes('INSTALLED')) {
      // Profile enabled / installed on device — NOT network-active.
      return {
        success: true,
        data: {
          status: 'INSTALLED',
          rawStatus: 'profile_enabled',
          evidence: { deviceInstalled: true, reason: 'profile-installed-no-attach' },
          rawMetadata: { source: 'esims/info', deviceInstalled: true, profileLogStates: logStates },
        },
      }
    }
    // assigned-only / no proven evidence → provisioned, not active.
    return { success: true, data: { status: 'PENDING_ACTIVATION', rawStatus: profileStatus || 'assigned', rawMetadata: { source: 'esims/info', profileLogStates: logStates } } }
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
