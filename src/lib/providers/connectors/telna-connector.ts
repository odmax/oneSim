import { prisma } from '@/lib/prisma'
import { decryptToken } from '@/lib/encryption'
import { claimProviderIccid, releaseProviderIccidClaim } from '@/lib/services/esims/esim-inventory-claim'
import { telnaEndpointPath, telnaEndpointAuthFamily, isTelnaEndpointProven, buildTelnaEndpointUrl, type TelnaEndpoint, type TelnaAuthFamily, type TelnaPaginatedResponse, type TelnaCountry, type TelnaCompany, type TelnaInventory, type TelnaGroup, type TelnaWallet, type TelnaPackageTemplate, type TelnaPackageTemplateDetail, type TelnaPackage, type TelnaSimRegistry, type TelnaPCRProfile, type TelnaPCRProfileUpdate, type TelnaUsage, type TelnaSession, type TelnaBalance, type TelnaConsumption, type TelnaV2PackageTemplate, type TelnaCreatePackageRequest, type TelnaV2Package, type TelnaV2SimRegistry, type TelnaEuiccProfile } from './telna-endpoints'
import type { IProviderConnector, ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, TopUpESIMParams, TopUpESIMResult, UsageResult, StatusResult, RateResult, TokenState, EsimLifecycleResult, ConnectorCapabilities, ConnectorAuthProfile, StatusLookupEsim, StatusLookupIdentifier, ConnectorInstallDataOutput, InstallationLookupInput, InstallationLookupResult } from './connector-interface'
import { normalizeSimStatus } from '../mappers/telna-sim-mapper'
import { hasUsableInstallData } from '@/lib/esim/installation-data'

interface TelnaRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  endpoint: TelnaEndpoint
  pathParams?: Record<string, string | number>
  query?: Record<string, string | number | undefined>
  body?: unknown
  timeoutMs?: number
}

interface TelnaRequestResult {
  success: boolean
  status?: number
  data?: unknown
  error?: { code: string; message: string }
  latencyMs?: number
  requestId?: string
}

function generateRequestId(): string {
  return `telna-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function maskToken(token: string): string {
  if (!token || token.length < 8) return token
  return token.slice(0, 4) + '••••' + token.slice(-4)
}

function maskIccid(iccid: string): string {
  if (!iccid) return ''
  if (iccid.length <= 8) return '••••'
  return `${iccid.slice(0, 4)}••••${iccid.slice(-4)}`
}

/**
 * Provider-local V2.1 envelope/label normalization.
 *
 * Telna Connect returns NAMED list envelopes: { total, offset, count, <label> }.
 * Accept the named key first, then fall back to the older { data:{...} } / bare
 * shapes so existing tolerance is retained. Provider-local — not a cross-provider
 * helper.
 */
export function unwrapTelnaNamedList(body: unknown, namedKey: string): unknown[] {
  if (!body || typeof body !== 'object') return []
  const b = body as Record<string, unknown>
  const direct = b[namedKey]
  if (Array.isArray(direct)) return direct
  // { data: { namedKey: [...] } }
  const data = b.data
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (Array.isArray(d[namedKey])) return d[namedKey]
    if (Array.isArray(d.data)) return d.data
  }
  if (Array.isArray(b.data)) return b.data
  if (Array.isArray(body)) return body as unknown[]
  return []
}

/** Detail unwrap: { data: { data: {...} } } → { data: {...} } → bare object. */
export function unwrapTelnaDetail(body: unknown, namedKey?: string): unknown {
  if (!body || typeof body !== 'object') return body
  const b = body as Record<string, unknown>
  if (namedKey && b[namedKey] && typeof b[namedKey] === 'object') return b[namedKey]
  const data = b.data
  if (data && typeof data === 'object') {
    if ((data as Record<string, unknown>).data && typeof (data as Record<string, unknown>).data === 'object') {
      return (data as Record<string, unknown>).data
    }
    return data
  }
  return body
}

/**
 * Telna enum/state normalization: trim, uppercase, and replace spaces/hyphens
 * with underscore. E.g. "PRE-SERVICE" → "PRE_SERVICE", "IN-SERVICE" →
 * "IN_SERVICE", "De-activated" → "DE_ACTIVATED". Provider-local.
 */
export function normalizeTelnaState(value: string | null | undefined): string {
  if (!value) return ''
  return String(value).trim().toUpperCase().replace(/[\s-]+/g, '_')
}

/**
 * Provider-local time_allowance → validityDays.
 *
 * The real V2.1 template contract uses an OBJECT form:
 *   { duration: number, unit: string }
 * (e.g. `{ duration: 1, unit: 'CALENDAR_MONTH' }`), NOT seconds. This helper
 * converts deterministically to whole OneSIM validity days:
 *
 *   SECOND/MINUTE/HOUR → duration converted to days (rounded up, min 1)
 *   DAY / CALENDAR_DAY → duration
 *   WEEK               → duration * 7
 *   MONTH/CALENDAR_MONTH → duration * 30   (documented canonical approximation)
 *   YEAR               → duration * 365
 *
 * A legacy numeric value is treated as SECONDS (previous behaviour) only as a
 * compatibility fallback. Unsupported/malformed units use the explicit
 * `fallbackDays` (default 30) but return a diagnostic `validitySource` so the
 * caller records WHY the fallback was used — never a silent assumption.
 */
export function normalizeTelnaTimeAllowance(
  raw: Record<string, unknown>,
  key: 'time_allowance' | 'activation_time_allowance' = 'time_allowance',
  fallbackDays = 30,
): { validityDays: number; validitySource: string } {
  const value = raw[key]
  if (value == null) return { validityDays: fallbackDays, validitySource: 'missing' }

  // Object form { duration, unit }
  if (typeof value === 'object') {
    const v = value as { duration?: number; unit?: string }
    const duration = Number(v.duration)
    const unit = String(v.unit || '').trim().toUpperCase()
    if (!Number.isFinite(duration) || duration <= 0 || !unit) {
      return { validityDays: fallbackDays, validitySource: `malformed:${key}` }
    }
    switch (unit) {
      case 'SECOND': return { validityDays: Math.max(1, Math.ceil(duration / 86400)), validitySource: `${key}:${unit}` }
      case 'MINUTE': return { validityDays: Math.max(1, Math.ceil(duration / 1440)), validitySource: `${key}:${unit}` }
      case 'HOUR': return { validityDays: Math.max(1, Math.ceil(duration / 24)), validitySource: `${key}:${unit}` }
      case 'DAY':
      case 'CALENDAR_DAY': return { validityDays: Math.max(1, Math.round(duration)), validitySource: `${key}:${unit}` }
      case 'WEEK': return { validityDays: Math.max(1, Math.round(duration * 7)), validitySource: `${key}:${unit}` }
      case 'MONTH':
      case 'CALENDAR_MONTH': return { validityDays: Math.max(1, Math.round(duration * 30)), validitySource: `${key}:${unit}` }
      case 'YEAR': return { validityDays: Math.max(1, Math.round(duration * 365)), validitySource: `${key}:${unit}` }
      default: return { validityDays: fallbackDays, validitySource: `unsupported-unit:${unit}` }
    }
  }

  // Legacy numeric: treat as SECONDS (compat).
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) {
    return { validityDays: Math.max(1, Math.round(seconds / 86400)), validitySource: `${key}:seconds` }
  }
  return { validityDays: fallbackDays, validitySource: 'malformed' }
}

export class TelnaConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string

  constructor(providerId: string, name: string | undefined) {
    this.providerId = providerId
    this.name = name || 'Telna'
  }

  /** Telna (legacy) connector-declared internal capabilities. */
  capabilities: ConnectorCapabilities = {
    installationLookup: true, // documented GET /euicc-profiles/{iccid} — activation_code
    installationDataAtPurchase: 'UNKNOWN',
    installationLookupHistorical: true,
    statusLookup: true, // SIM registry + eUICC profile evidence
    usageLookup: true, // package data_usage_remaining (BYTES)
    topUp: false,
    suspend: false,
    resume: false,
    balance: true, // getWallet
    inventory: true, // GET /sim-registries
    webhooks: false,
  }

  /** Telna uses a pre-issued static KeyID — no runtime token exchange. */
  authProfile: ConnectorAuthProfile = {
    mode: 'STATIC_KEY_ID',
    requiresRuntimeAuthentication: false,
    canVerifyCredentials: true,
    supportsRefresh: false,
    credentialField: 'apiToken',
    actionLabel: 'Save & Verify',
  }

  private async loadProvider(): Promise<{
    apiBaseUrl: string
    keyId: string
    apiVersion: string
    pcrApiKey: string | null
  } | null> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return null

    const config = (provider.config as Record<string, unknown>) || {}
    // provider.apiToken = Telna API_ACCESS_KEY_ID, sent raw in the Authorization
    // header (V2.1 collection-level auth): `Authorization: <API_ACCESS_KEY_ID>`.
    const keyId = decryptToken(provider.apiToken)
    if (!keyId) return null

    // PCR may require a SECOND value as the explicit `ApiKey:` header (shown in
    // the collection's PCR requests). Stored in provider.config ONLY as
    // encryptToken() ciphertext — NEVER plaintext. Missing/decrypt-failure → null.
    const pcrApiKey = decryptToken(typeof config.telnaPcrApiKeyEncrypted === 'string' ? config.telnaPcrApiKeyEncrypted : null)

    return {
      apiBaseUrl: (provider.apiBaseUrl || 'https://developer-api.telna.com').replace(/\/+$/, ''),
      keyId,
      apiVersion: provider.apiVersion || '2.1',
      pcrApiKey,
    }
  }

  /**
   * Detect an obvious TELNA vs TELNA_FLEX host mismatch. The Telna Connect
   * connector's documented host is developer-api.telna.com; TELNA_FLEX owns
   * ppo-api.telna.com /v1/* and is a separate connector. Returning true here
   * blocks TELNA mutations (and warns) so the Connect connector never silently
   * operates against the Flex host.
   */
  private isFlexHost(apiBaseUrl: string): boolean {
    const host = (apiBaseUrl || '').toLowerCase()
    return host.includes('ppo-api.telna.com') || host.includes('ppo-api')
  }

  /**
   * Build the V2.1 per-family auth headers.
   *
   * Collection-level auth (every request):
   *   Authorization: <API_ACCESS_KEY_ID>     (raw — NO "Bearer " prefix)
   *
   * PCR additionally requires:
   *   ApiKey: <api_key>
   *
   * NO HTTP Basic anywhere. No loginId/accessToken pair.
   */
  private buildAuthHeaders(opts: { endpoint: TelnaEndpoint; cfg: { keyId: string; pcrApiKey: string | null } }): {
    headers: Record<string, string>
    error?: { code: string; message: string }
  } {
    const family: TelnaAuthFamily = telnaEndpointAuthFamily(opts.endpoint)
    const { cfg } = opts
    if (!cfg.keyId) {
      return { headers: {}, error: { code: 'AUTH_INCOMPLETE', message: 'Telna API access key (Authorization) not configured for this operation' } }
    }

    const base: Record<string, string> = { 'Authorization': cfg.keyId }

    // PCR: collection Authorization API key + explicit ApiKey header.
    if (family === 'PCR') {
      if (!cfg.pcrApiKey) {
        return { headers: {}, error: { code: 'AUTH_INCOMPLETE', message: 'PCR ApiKey header credential is not configured for this TELNA PCR operation' } }
      }
      base['ApiKey'] = cfg.pcrApiKey
      return { headers: base }
    }

    // All other families (INVENTORY / ESIM_RSP / SESSION / USAGE / CORE) use only
    // the collection-level Authorization API key.
    return { headers: base }
  }

  private async request(opts: TelnaRequestOptions): Promise<TelnaRequestResult> {
    const requestId = generateRequestId()
    const startTime = Date.now()
    const providerConfig = await this.loadProvider()
    if (!providerConfig) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not found or KeyID not configured' }, requestId }
    }

    const { apiBaseUrl, keyId, pcrApiKey } = providerConfig
    const method = opts.method || 'GET'
    // Canonical, single-source path/URL composition (shared with Discovery).
    const path = telnaEndpointPath(opts.endpoint)
    const family = telnaEndpointAuthFamily(opts.endpoint)

    // Host/surface safety: the legacy TELNA connector must never silently run
    // against the TELNA_FLEX host (ppo-api.telna.com) — that is Flex's surface.
    if (this.isFlexHost(apiBaseUrl)) {
      console.warn(`[TELNA_HOST_MISMATCH] configured apiBaseUrl=${apiBaseUrl} is the TELNA_FLEX host; legacy TELNA connector refusing request path=${path} requestId=${requestId}`)
      return { success: false, error: { code: 'HOST_MISMATCH', message: 'Configured Telna base URL is the TELNA_FLEX host; use the developer-api.telna.com surface or the TELNA_FLEX connector' }, latencyMs: 0, requestId }
    }

    // UNVERIFIED endpoints are never called — no auth family is proven for them.
    if (!isTelnaEndpointProven(opts.endpoint)) {
      return { success: false, error: { code: 'UNVERIFIED_ENDPOINT', message: 'TELNA endpoint path is not proven by documentation; refusing to call it' }, latencyMs: 0, requestId }
    }

    let url = buildTelnaEndpointUrl(apiBaseUrl, opts.endpoint, opts.pathParams)
    const timeoutMs = opts.timeoutMs || 15000

    if (opts.query) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined && value !== null && value !== '') {
          params.set(key, String(value))
        }
      }
      const qs = params.toString()
      if (qs) url += `?${qs}`
    }

    // V2.1 per-family auth (collection Authorization API key; PCR also ApiKey).
    const auth = this.buildAuthHeaders({ endpoint: opts.endpoint, cfg: { keyId, pcrApiKey } })
    if (auth.error) {
      return { success: false, error: auth.error, latencyMs: 0, requestId }
    }

    const headers: Record<string, string> = { 'Accept': 'application/json', ...auth.headers }

    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    console.log(`[TELNA_REQUEST] method=${method} path=${path} authFamily=${family} requestId=${requestId}`)

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      const response = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      const status = response.status
      const text = await response.text()
      const latencyMs = Date.now() - startTime

      console.log(`[TELNA_RESPONSE] method=${method} path=${path} status=${status} latencyMs=${latencyMs} requestId=${requestId}`)

      if (status === 401) {
        return { success: false, status, error: { code: 'HTTP_401', message: 'Authentication rejected — check KeyID' }, latencyMs, requestId }
      }
      if (status === 403) {
        return { success: false, status, error: { code: 'HTTP_403', message: 'KeyID lacks permission for this resource' }, latencyMs, requestId }
      }
      if (status === 404) {
        return { success: false, status, error: { code: 'HTTP_404', message: 'Resource not found — verify Telna API base URL / endpoint path for this API version (not an authentication failure)' }, latencyMs, requestId }
      }
      if (status === 429) {
        return { success: false, status, error: { code: 'HTTP_429', message: 'Rate limited — too many requests' }, latencyMs, requestId }
      }
      if (status >= 400 && status < 500) {
        const msg = text ? text.substring(0, 300) : 'Bad request'
        return { success: false, status, error: { code: `HTTP_${status}`, message: msg }, latencyMs, requestId }
      }
      if (status >= 500) {
        return { success: false, status, error: { code: `HTTP_${status}`, message: 'Provider server error' }, latencyMs, requestId }
      }

      if (!text) {
        return { success: true, status, data: null, latencyMs, requestId }
      }

      try {
        const json = JSON.parse(text)
        return { success: true, status, data: json, latencyMs, requestId }
      } catch {
        return { success: false, status, error: { code: 'INVALID_JSON', message: 'Response was not valid JSON' }, latencyMs, requestId }
      }
    } catch (e: unknown) {
      const latencyMs = Date.now() - startTime
      if (e instanceof Error && e.name === 'AbortError') {
        return { success: false, error: { code: 'TIMEOUT', message: 'Request timed out' }, latencyMs, requestId }
      }
      const msg = e instanceof Error ? e.message : 'Unknown error'
      return { success: false, error: { code: 'NETWORK_ERROR', message: msg }, latencyMs, requestId }
    }
  }

  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>> {
    const result = await this.request({ method: 'GET', endpoint: 'countries', query: { count: 1, offset: 0 } })

    console.log(`[TELNA_TEST_CONNECTION] success=${result.success} status=${result.status} latencyMs=${result.latencyMs} requestId=${result.requestId}`)

    if (result.success) {
      return { success: true, data: { message: 'Connected to Telna API', latencyMs: result.latencyMs } }
    }

    const msg = result.error?.message || 'Connection test failed'
    return { success: false, error: { code: result.error?.code || 'UNKNOWN', message: msg } }
  }

  async diagnoseConnection(): Promise<ConnectorResult<any>> {
    return this.testConnection()
  }

  async authenticate(_credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Telna uses pre-configured KeyID, not runtime authentication' } }
  }

  async getTokenState(): Promise<TokenState> {
    return { tokenPresent: true, expiryPresent: false, expired: false, expiresSoon: false, tokenExpiry: null }
  }

  async ensureAuthenticated(): Promise<ConnectorResult<void>> {
    const cfg = await this.loadProvider()
    if (!cfg) return { success: false, error: { code: 'NO_TOKEN', message: 'KeyID not configured' } }
    return { success: true }
  }

  async refreshAuthentication(): Promise<boolean> {
    return false
  }

  /**
   * Plan sync: consume the live V2.1 PCR package-templates surface
   * `{ total, offset, count, package_templates:[...] }` into the canonical
   * `ConnectorPlan[]` used by the shared `syncProviderPlans` pipeline.
   *
   * - Paginates ALL pages (stops when offset+count >= total or an empty page).
   * - Normalizes only active/sellable templates into ConnectorPlan rows.
   * - providerPlanId (plan.id) remains the Telna template id. No local ids.
   * - data_usage_allowance (bytes) → data_gb (GB). time_allowance → validity_days.
   */
  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    const plans: ConnectorPlan[] = []
    const perPage = 100
    let offset = 0

    for (let guard = 0; guard < 50; guard++) {
      const page = await this.listPackageTemplates(undefined, perPage, offset)
      if (!page.success || !page.data) return { success: false, error: page.error || { code: 'SYNC_FAILED', message: 'Failed to list package templates' } }
      const items = page.data.items || []
      const total = page.data.total || items.length

      for (const t of items) {
        const templateId = t?.id
        if (templateId == null) continue
        // Return BOTH active and deactivated templates so the canonical sync can
        // persist/update the same ProviderPackage row safely. Availability is
        // derived from the live template status; canonical sync marks a
        // deactivated provider plan unavailable (never deleted).
        const status = normalizeTelnaState(t.status)
        const isAvailable = status === 'ACTIVE' || status === ''
        plans.push(this.normalizeTelnaTemplateToPlan(t, isAvailable, status))
      }

      if (items.length === 0) break
      const loaded = offset + items.length
      if (total > 0 && loaded >= total) break
      offset += items.length
    }

    return { success: true, data: plans }
  }

  /**
   * Map a raw Telna V2.1 package-template into the canonical ConnectorPlan.
   * data_usage_allowance is BYTES → GB (round up to at least 1). time_allowance
   * is seconds → whole days (min 1). Identifiers are provider-owned only.
   */
  private normalizeTelnaTemplateToPlan(t: TelnaPackageTemplate, isAvailable = true, providerStatus = 'ACTIVE'): ConnectorPlan {
    const templateId = String(t.id)
    const raw = (t as unknown as Record<string, unknown>)
    const allowanceBytes = Number(raw.data_usage_allowance) || 0
    // Live Telna data_usage_allowance is BYTES. Convert to retail GB using
    // OneSIM's integer dataGB semantics. 1048576000 bytes => 1 GB (rounded).
    const dataGB = allowanceBytes > 0 ? Math.max(1, Math.round(allowanceBytes / (1024 * 1024 * 1024))) : 1
    const { validityDays, validitySource } = normalizeTelnaTimeAllowance(raw, 'time_allowance', 30)
    return {
      id: templateId,
      name: String(raw.name || '') || `Telna ${dataGB}GB`,
      data_gb: dataGB,
      validity_days: validityDays,
      // Telna templates do not carry provider cost/currency — never fabricate a
      // real cost. price_usd=0 is the zero sentinel; currency is omitted so it is
      // NOT presented as provider-supplied (canonical sync defaults to its own
      // neutral currency and records COST_UNAVAILABLE).
      price_usd: 0,
      isAvailable,
      sku: templateId,
      raw_data: { ...t, _validitySource: validitySource, providerStatus },
    }
  }

  /**
   * Telna purchase: creates a service package on an EXISTING Telna SIM ICCID.
   *
   * Flow:
   *  1. Resolve the provider template id from params.planId (the configured
   *     ProviderPackage.providerPlanId maps to the TELNA PACKAGE TEMPLATE id).
   *  2. If a template inventory is known, filter eligible SIMs to it.
   *  3. Select an eligible (non-terminated) Telna ICCID from the SIM registry.
   *  4. No eligible SIM → canonical OUT_OF_STOCK (NO POST /packages).
   *  5. POST /packages { sim: ICCID, package_template: templateId }.
   *  6. Return the created package instance id (provider package ref) + ICCID.
   *
   * NEVER sends a local OneSIM id (esim.id / Package.id / ProviderPackage.id).
   */
  async activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    const config = await this.loadProvider()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not found or KeyID not configured' } }

    // Host/surface safety: never purchase against the TELNA_FLEX host.
    if (this.isFlexHost(config.apiBaseUrl)) {
      return { success: false, error: { code: 'HOST_MISMATCH', message: 'Configured Telna base URL is the TELNA_FLEX host; TELNA purchase is not permitted against the Flex surface' } }
    }

    // PCR auth readiness is checked BEFORE any ICCID listing, claim, or mutation.
    // Telna package creation (POST /v2.1/pcr/packages) is a PCR operation
    // requiring the collection Authorization API key + the explicit ApiKey
    // header. Without both, no claim and no POST may occur.
    if (!config.pcrApiKey) {
      return { success: false, error: { code: 'AUTH_INCOMPLETE', message: 'PCR ApiKey header credential is not configured; Telna purchase is disabled' } }
    }

    // The documented PCR package surface (/pcr/packages) is proven; proceed only
    // when it exists in the endpoint map/authorization contract.
    if (!isTelnaEndpointProven('packages')) {
      return { success: false, error: { code: 'UNVERIFIED_ENDPOINT', message: 'Telna POST /pcr/packages path is not proven; purchase disabled' } }
    }

    // params.planId = ProviderPackage.providerPlanId = Telna package template id.
    if (!params.planId) return { success: false, error: { code: 'INVALID_REQUEST', message: 'Provider package template id (planId) is required for purchase' } }
    const templateId = Number(params.planId)
    if (!Number.isFinite(templateId) || templateId <= 0) {
      return { success: false, error: { code: 'INVALID_REQUEST', message: 'planId must be the numeric Telna package template id' } }
    }
    const orderId = params.orderId

    // Determine the template's inventory (a template is tied to an inventory;
    // only SIMs in that inventory can use it). Read-only, best-effort.
    let templateInventoryId: number | string | undefined
    try {
      const tpl = await this.getV2PackageTemplate(templateId)
      if (tpl.success && tpl.data?.template?.inventory && Array.isArray(tpl.data.template.inventory)) {
        const first = tpl.data.template.inventory[0]
        if (first?.id != null) templateInventoryId = Number(first.id) || String(first.id)
      }
    } catch { /* fall through to unconstrained selection */ }

    // Enumerate eligible PRE_SERVICE candidates (in template inventory, unused).
    const candidates = await this.listEligibleIccids(templateInventoryId)
    if (candidates.length === 0) {
      return {
        success: false,
        error: { code: 'OUT_OF_STOCK', message: 'No eligible Telna SIM inventory available for the requested package template' },
      }
    }

    // ATOMIC local claim BEFORE any Telna mutation. For each candidate, attempt
    // a durable OneSIM eSIM pre-claim bounded to this order via the `@unique
    // iccid` constraint. Only after a successful local claim is the billable
    // POST /packages made. A collision simply moves to the next candidate.
    let claimError: string | null = null
    if (!orderId) {
      // No durable purchase identity → cannot make an ownership-safe claim.
      // Safety barrier: never an unowned provider mutation.
      return {
        success: false,
        error: { code: 'OUT_OF_STOCK', message: 'A purchase order (orderId) is required to claim and purchase Telna eSIM inventory' },
      }
    }
    for (const iccid of candidates) {
      // Neutral OneSIM atomic claim (ESIM.iccid @unique). Replace direct DB ops.
      const claim = await claimProviderIccid({ purchaseId: orderId, iccid })
      if (!claim.ok) {
        // CLAIM_LOST (P2002) — another concurrent purchase claimed this ICCID.
        continue
      }

      // Claim succeeded & owned by this order — call Telna (exactly one mutation).
      const body: TelnaCreatePackageRequest = { sim: iccid, package_template: templateId }
      const result = await this.createPackage(body)

      if (!result.success || !result.data?.pkg) {
        // Telna failed → neutral ownership-safe release of this purchase's claim.
        await releaseProviderIccidClaim({ purchaseId: orderId, iccid })
        claimError = result.error?.code || 'PACKAGE_CREATE_FAILED'
        return { success: false, error: result.error || { code: 'PACKAGE_CREATE_FAILED', message: 'Telna package creation failed' } }
      }

      const pkg = result.data.pkg
      const packageInstanceId = pkg.id != null ? String(pkg.id) : undefined
      const rawMetadata: Record<string, any> = {
        // Three distinct identities:
        //  - iccid                     = Telna eSIM identity (A)
        //  - providerTemplateId        = Telna package template id = catalog plan (B)
        //  - providerPackageInstanceId = exact created Telna package instance (C)
        iccid,
        providerTemplateId: templateId,
        providerPackageInstanceId: packageInstanceId ?? null,
        packageStatus: pkg.status ?? null,
      }

      return {
        success: true,
        data: {
          // activationId = provider package instance (C); esim identity (A) is
          // the claimed ICCID. The package instance id is preserved verbatim so
          // later usage can address the EXACT package.
          activationId: packageInstanceId || iccid,
          iccids: [iccid],
          iccidOrSimId: iccid,
          // Package creation does NOT prove device installation or network
          // activation — stay PENDING_ACTIVATION ("ready to install"). The status
          // sync will promote via canonical evidence.
          status: 'PENDING_ACTIVATION',
          rawMetadata,
        },
      }
    }

    return {
      success: false,
      error: { code: claimError || 'OUT_OF_STOCK', message: claimError ? 'All eligible Telna SIMs were claimed by concurrent purchases; no free inventory remains' : 'No eligible Telna SIM inventory available for the requested package template' },
    }
  }

  /**
   * Enumerate eligible Telna ICCIDs for a new OneSIM purchase. Only PRE_SERVICE
   * SIMs are candidates; IN_SERVICE / TERMINATED / WAITING_FOR_ASSIGNMENT are
   * never selected, and ICCIDs already bound to an existing OneSIM eSIM are
   * excluded. Returns [] → OUT_OF_STOCK.
   */
  private async listEligibleIccids(inventoryId?: number | string): Promise<string[]> {
    const result = await this.listV2SimRegistries(
      inventoryId != null ? Number(inventoryId) : undefined,
    )
    if (!result.success || !result.data) return []
    const sims = result.data.items || []
    const candidates = sims
      .filter(s => s?.iccid && normalizeTelnaState(s.iccid).trim() !== '' && normalizeTelnaState(s.status) === 'PRE_SERVICE')
      .map(s => String(s.iccid))
    if (candidates.length === 0) return []

    const used = await prisma.eSIM.findMany({ where: { iccid: { in: candidates } }, select: { iccid: true } })
    const usedSet = new Set(used.map(u => u.iccid))
    return candidates.filter(c => !usedSet.has(c))
  }

  async getStatus(identifier: string | StatusLookupIdentifier): Promise<ConnectorResult<StatusResult>> {
    // Telna status is keyed by ICCID (provider-owned). Never a local OneSIM id.
    const iccid = typeof identifier === 'string' ? identifier : (identifier as StatusLookupIdentifier)?.iccid
    if (!iccid) {
      return { success: false, error: { code: 'IDENTIFIER_MISSING', message: 'ICCID is required for Telna status lookup' } }
    }

    // Evidence set: SIM registry (PRE_SERVICE/IN_SERVICE/TERMINATED), eUICC
    // profile (RELEASED/DOWNLOADED/INSTALLED/ENABLED/DISABLED), and any package
    // status (NOT_ACTIVE/ACTIVE/TERMINATED). All read-only, provider-owned.
    let simStatus: string | null = null
    let profileState: string | null = null
    let packageStatus: string | null = null
    let expiryDate: string | undefined

    // 1) SIM registry (best-effort — availability of /sim-registries is live-proven).
    const reg = await this.getV2SimRegistry(iccid)
    if (reg.success && reg.data?.sim?.status) {
      simStatus = normalizeTelnaState(reg.data.sim.status)
    }

    // 2) eUICC profile (best-effort — conveys install/enable evidence, not network usage).
    const prof = await this.getEuiccProfile(iccid)
    if (prof.success && prof.data?.profile?.state) {
      profileState = normalizeTelnaState(prof.data.profile.state)
    }

    // 3) Package status (best-effort).
    const pkgRes = await this.listV2Packages({ sim: iccid })
    if (pkgRes.success && Array.isArray(pkgRes.data?.items) && pkgRes.data.items.length > 0) {
      const p = pkgRes.data.items.find(x => normalizeTelnaState(x.status) !== 'TERMINATED') || pkgRes.data.items[0]
      packageStatus = normalizeTelnaState(p?.status) || null
      expiryDate = p?.expiry_date || undefined
    }

    // Conservative, provider-neutral normalization. Evidence is mapped into the
    // canonical StatusResult.evidence contract; the generic lifecycle engine
    // decides the final stored status via deriveEsimLifecycleStatus.
    //
    // Lifecycle precedence: SIM TERMINATED is STRONG terminal SIM evidence and
    // wins. A TERMINATED PACKAGE alone does NOT terminate the physical eSIM —
    // Telna supports another package / top-up on that SIM — so it must never
    // force EXPIRED. Package status is supplemental (expiry) only, never the
    // authority for PROFILECOMPLETION/device lifecycle.
    const rawStatus = profileState || simStatus || packageStatus || 'UNKNOWN'
    let status: string
    let evidence: StatusResult['evidence']

    if (simStatus === 'TERMINATED' || profileState === 'DELETED' || profileState === 'UNAVAILABLE' || profileState === 'ERROR') {
      // Strong terminal SIM / profile evidence.
      status = 'EXPIRED'
      evidence = { reason: 'telna-sim-terminated' }
    } else if (simStatus === 'SUSPENDED' || profileState === 'DISABLED') {
      // SIM/profile locally suspended or disabled.
      status = 'SUSPENDED'
      evidence = { reason: 'telna-suspended-or-disabled' }
    } else if (simStatus === 'IN_SERVICE') {
      // IN_SERVICE SIM = has generated network traffic — strong network-use evidence.
      status = 'ACTIVE'
      evidence = { networkAttached: true, reason: 'sim-in-service' }
    } else if (profileState === 'INSTALLED' || profileState === 'ENABLED') {
      // Profile installed/enabled on device — device-install evidence, not network-active.
      status = 'INSTALLED'
      evidence = { deviceInstalled: true, reason: 'euicc-installed-or-enabled' }
    } else if (simStatus === 'PRE_SERVICE' || profileState === 'RELEASED' || profileState === 'DOWNLOADED' || simStatus === 'WAITING_FOR_ASSIGNMENT') {
      // Ready / provisioned but not network-active.
      status = 'PENDING_ACTIVATION'
      evidence = { reason: 'telna-ready-not-active' }
    } else {
      status = 'PENDING_ACTIVATION'
      evidence = { reason: 'telna-no-strong-evidence' }
    }

    return {
      success: true,
      data: {
        status,
        rawStatus,
        iccid,
        expiresAt: expiryDate,
        evidence,
        rawMetadata: { source: 'sim-registry+euicc-profiles+packages', rawStatus, simStatus, profileState, packageStatus },
      },
    }
  }

  /** GET /v2.1/inventory/sim-registries/{iccid} — SIM registry detail (tolerant unwrap). */
  async getV2SimRegistry(iccid: string): Promise<ConnectorResult<{ sim: TelnaV2SimRegistry }>> {
    const result = await this.request({ method: 'GET', endpoint: 'simRegistry', pathParams: { iccid } })
    const sim = result.success && result.data ? unwrapTelnaDetail(result.data, 'sim') : null
    if (!result.success || !sim) {
      return { success: false, error: result.error || { code: 'SIM_REGISTRY_FAILED', message: 'SIM registry entry not found' } }
    }
    return { success: true, data: { sim: sim as TelnaV2SimRegistry } }
  }

  /** Telna status is keyed by ICCID — a provider-owned identifier, never a local esim.id. */
  resolveStatusLookup(esim: StatusLookupEsim): string | null {
    return esim.iccid || null
  }

  async getUsage(identifier: string | StatusLookupIdentifier): Promise<ConnectorResult<UsageResult>> {
    // Telna usage is keyed by the EXACT package instance (C) associated with the
    // purchase. When the identifier carries providerSubscriptionId (the persisted
    // package instance id), address that package directly. Only fall back to the
    // ICCID when no package instance id is known AND uniqueness can be proven
    // (exactly one non-TERMINATED package on the SIM). Never arbitrarily select
    // the first/non-terminated package among several.
    const iccid = typeof identifier === 'string' ? identifier : (identifier as StatusLookupIdentifier)?.iccid
    if (!iccid) {
      return { success: false, error: { code: 'IDENTIFIER_MISSING', message: 'ICCID is required for Telna usage lookup' } }
    }
    const packageInstanceId = typeof identifier === 'object' && identifier
      ? (identifier as StatusLookupIdentifier)?.providerSubscriptionId
      : undefined

    // 1) Exact package instance path (preferred).
    let packageInstance: TelnaV2Package | null = null
    if (packageInstanceId && String(packageInstanceId).trim() !== '') {
      try {
        const detail = await this.getV2Package(String(packageInstanceId))
        if (detail.success && detail.data?.pkg) {
          packageInstance = detail.data.pkg
        }
      } catch { /* fall through to iccid refinement */ }
    }

    // 2) Fallback: ICCID lookup, only used when exactly one non-TERMINATED
    //    package exists (provable uniqueness).
    if (!packageInstance) {
      const pkgRes = await this.listV2Packages({ sim: iccid })
      if (pkgRes.success && Array.isArray(pkgRes.data?.items)) {
        const nonTerminated = pkgRes.data.items.filter(p => String(p.status).toUpperCase() !== 'TERMINATED')
        if (nonTerminated.length === 1) {
          packageInstance = nonTerminated[0]
        } else if (nonTerminated.length > 1) {
          // Multiple package instances — cannot safely pick one → require the
          // exact package instance id (persisted at purchase).
          return { success: false, error: { code: 'DATA_UNAVAILABLE', message: 'Multiple Telna packages on this ICCID — exact package instance id required' } }
        }
      }
      if (pkgRes.success && pkgRes.success && (pkgRes.data?.items?.length ?? 0) === 0) {
        return { success: false, error: { code: 'DATA_UNAVAILABLE', message: 'No Telna package instance found for this ICCID' } }
      }
      if (!packageInstance) {
        return { success: false, error: { code: 'DATA_UNAVAILABLE', message: 'No Telna package instance found for this ICCID' } }
      }
    }

    // 3) Total allowance: prefer the template's data_usage_allowance (BYTES).
    let templateAllowanceBytes = 0
    if (packageInstance.package_template && typeof (packageInstance.package_template as any)?.data_usage_allowance === 'number') {
      templateAllowanceBytes = Number((packageInstance.package_template as any).data_usage_allowance)
    } else {
      const templateId = Number((packageInstance.package_template as any)?.id)
      if (Number.isFinite(templateId) && templateId > 0) {
        try {
          const tpl = await this.getV2PackageTemplate(templateId)
          if (tpl.success && tpl.data?.template && typeof tpl.data.template.data_usage_allowance === 'number') {
            templateAllowanceBytes = Number(tpl.data.template.data_usage_allowance)
          }
        } catch { /* keep 0 */ }
      }
    }

    const remainingBytes = Number(packageInstance.data_usage_remaining)
    if (!Number.isFinite(remainingBytes) || remainingBytes < 0) {
      return { success: false, error: { code: 'DATA_UNAVAILABLE', message: 'No data_usage_remaining in Telna package response' } }
    }
    const totalMB = templateAllowanceBytes > 0 ? templateAllowanceBytes / (1024 * 1024) : undefined
    const remainingMB = remainingBytes / (1024 * 1024)
    const usedMB = totalMB != null ? Math.max(0, totalMB - remainingMB) : undefined

    const status = String(packageInstance.status || '').toUpperCase()
    return {
      success: true,
      data: {
        iccid,
        dataUsedMB: usedMB != null ? Math.round(usedMB) : 0,
        dataTotalMB: totalMB != null ? Math.round(totalMB) : undefined,
        dataRemainingMB: Math.round(remainingMB),
        expiresAt: packageInstance.expiry_date ? String(packageInstance.expiry_date) : undefined,
        status: status === 'ACTIVE' ? 'ACTIVE' : status === 'TERMINATED' ? 'EXPIRED' : status === 'NOT_ACTIVE' ? 'PENDING_ACTIVATION' : undefined,
        rawMetadata: { source: packageInstanceId && String(packageInstanceId).trim() !== '' ? 'packages/{package_id}' : 'packages?sim=', packageId: packageInstance.id ? String(packageInstance.id) : undefined, remainingBytes: Math.round(remainingBytes) },
      },
    }
  }

  /**
   * Telna usage is keyed by the EXACT purchased package instance, identified by
   * the ICCID (A) + the persisted providerPackageInstanceId (C). Returns a
   * structured StatusLookupIdentifier so getUsage can address the precise
   * package rather than arbitrarily picking one among several on the SIM.
   */
  resolveUsageLookup(esim: StatusLookupEsim): string | StatusLookupIdentifier | null {
    if (!esim.iccid) return null
    const raw = esim.providerResponse && typeof esim.providerResponse === 'object'
      ? (esim.providerResponse as Record<string, unknown>)
      : undefined
    const packageInstanceId = raw?.providerPackageInstanceId
    return {
      iccid: esim.iccid,
      ...(typeof packageInstanceId === 'string' && packageInstanceId ? { providerSubscriptionId: packageInstanceId } : {}),
    }
  }

  async suspendESIM(_subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Suspend not implemented for Telna connector' } }
  }

  async resumeESIM(_subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Resume not implemented for Telna connector' } }
  }

  async getRates(): Promise<ConnectorResult<RateResult[]>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Rates not implemented for Telna connector' } }
  }

  async getQRCode(_iccid: string): Promise<ConnectorResult<import('./connector-interface').QRCodeResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Use lookupInstallationData — Telna QR is conveyed as a documented activation_code, never an HTTP image URL' } }
  }

  /**
   * Documented read-only installation lookup: GET /euicc-profiles/{iccid}.
   * Maps the documented `activation_code` into the neutral installation result.
   * A profile state of INSTALLED/ENABLED is added as safe evidence metadata.
   * Never logs ICCID/IMSI/EID/activation_code.
   */
  async lookupInstallationData(input: InstallationLookupInput): Promise<InstallationLookupResult> {
    const iccid = input?.iccid || input?.esimId || null
    if (!iccid) {
      return { success: false, state: 'PERMANENT_FAILURE', errorCode: 'IDENTIFIER_MISSING', diagnostics: { methodUsed: 'euiccProfiles', identifierType: 'none' } }
    }
    const result = await this.getEuiccProfile(iccid)
    if (!result.success || !result.data?.profile) {
      if (result.error?.code === 'HTTP_401' || result.error?.code === 'HTTP_403') {
        return { success: false, state: 'PERMANENT_FAILURE', errorCode: 'PROVIDER_AUTH_FAILED', diagnostics: { methodUsed: 'euiccProfiles', identifierType: 'iccid' } }
      }
      return { success: false, state: 'NOT_AVAILABLE_YET', errorCode: result.error?.code === 'HTTP_404' ? 'PROVIDER_HTTP_ERROR' : (result.error?.code || 'PROVIDER_TIMEOUT'), diagnostics: { methodUsed: 'euiccProfiles', identifierType: 'iccid' } }
    }
    const p = result.data.profile
    const profileState = String(p.state || '').toUpperCase()

    const data: ConnectorInstallDataOutput = {
      ...(p.activation_code ? { activationCode: String(p.activation_code) } : {}),
    }
    if (hasUsableInstallData(data)) {
      return {
        success: true,
        state: 'READY',
        data,
        diagnostics: { methodUsed: 'euiccProfiles', identifierType: 'iccid', httpMethod: 'GET', endpointName: 'euiccProfile', responseKeys: Object.keys(p), note: `profile_state=${profileState}` },
      }
    }
    return {
      success: false,
      state: 'NOT_AVAILABLE_YET',
      errorCode: 'NO_INSTALL_DATA',
      diagnostics: { methodUsed: 'euiccProfiles', identifierType: 'iccid', httpMethod: 'GET', endpointName: 'euiccProfile', responseKeys: Object.keys(p), note: `profile_state=${profileState}` },
    }
  }

  /** GET /v2.1/esim-rsp/euicc-profiles/{iccid} — profile + activation data (tolerant unwrap). */
  async getEuiccProfile(iccid: string): Promise<ConnectorResult<{ profile: TelnaEuiccProfile }>> {
    const result = await this.request({ method: 'GET', endpoint: 'euiccProfile', pathParams: { iccid } })
    const profile = result.success && result.data ? unwrapTelnaDetail(result.data, 'profile') : null
    if (!result.success || !profile) {
      return { success: false, error: result.error || { code: 'PROFILE_FAILED', message: 'eUICC profile not found' } }
    }
    return { success: true, data: { profile: profile as TelnaEuiccProfile } }
  }

  // ── Phase 1: documented v2 package / SIM / template surface ────────────

  /** GET /v2.1/pcr/package-templates/{id} — template detail (tolerant unwrap). */
  async getV2PackageTemplate(packageTemplateId: number): Promise<ConnectorResult<{ template: TelnaV2PackageTemplate }>> {
    const result = await this.request({ method: 'GET', endpoint: 'packageTemplate', pathParams: { package_template_id: packageTemplateId } })
    const template = result.success && result.data ? unwrapTelnaDetail(result.data, 'template') : null
    if (!result.success || !template) {
      return { success: false, error: result.error || { code: 'TEMPLATE_FAILED', message: 'Package template not found' } }
    }
    return { success: true, data: { template: template as TelnaV2PackageTemplate } }
  }

  /**
   * GET /v2.1/inventory/sim-registries — SIM inventory (named `sims` envelope
   * with `{ total, offset, count, sims:[...] }`, tolerant fallback).
   */
  async listV2SimRegistries(inventoryId?: number, groupId?: number, iccid?: string, imsi?: string, status?: string, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaV2SimRegistry[]; total: number }>> {
    const result = await this.request({
      method: 'GET', endpoint: 'simRegistries',
      query: { inventory_id: inventoryId, group: groupId, iccid, imsi, status, count, offset },
    })
    const items = (result.success && result.data ? unwrapTelnaNamedList(result.data, 'sims') : []) || []
    const total = (result.success && result.data ? Number((result.data as { total?: unknown })?.total) || items.length : items.length)
    if (!result.success) {
      return { success: false, error: result.error || { code: 'INVENTORY_FAILED', message: 'Failed to list SIM registries' } }
    }
    return { success: true, data: { items: items as TelnaV2SimRegistry[], total } }
  }

  /** GET /v2.1/pcr/packages — package filter surface (named `packages` envelope, tolerant). */
  async listV2Packages(filters: { sim?: string; package_template?: number | string; status?: string; count?: number; offset?: number } = {}): Promise<ConnectorResult<{ items: TelnaV2Package[]; total: number }>> {
    const result = await this.request({ method: 'GET', endpoint: 'packages', query: filters })
    const items = (result.success && result.data ? unwrapTelnaNamedList(result.data, 'packages') : []) || []
    const total = (result.success && result.data ? Number((result.data as { total?: unknown })?.total) || items.length : items.length)
    if (!result.success) {
      return { success: false, error: result.error || { code: 'PACKAGES_FAILED', message: 'Failed to list packages' } }
    }
    return { success: true, data: { items: items as TelnaV2Package[], total } }
  }

  /** GET /v2.1/pcr/packages/{package_id} — exact package instance detail (tolerant). */
  async getV2Package(packageId: string | number): Promise<ConnectorResult<{ pkg: TelnaV2Package }>> {
    const result = await this.request({ method: 'GET', endpoint: 'package', pathParams: { package_id: packageId } })
    const pkg = result.success && result.data ? unwrapTelnaDetail(result.data, 'pkg') : null
    if (!result.success || !pkg) {
      return { success: false, error: result.error || { code: 'PACKAGE_FAILED', message: 'Package instance not found' } }
    }
    return { success: true, data: { pkg: pkg as TelnaV2Package } }
  }

  /**
   * POST /packages — creates a service package on an EXISTING Telna SIM.
   * Documented body: { sim, package_template, time_allowance? }.
   * NEVER a local OneSIM id; only the provider-owned ICCID + template id.
   */
  async createPackage(req: TelnaCreatePackageRequest): Promise<ConnectorResult<{ pkg: TelnaV2Package }>> {
    const result = await this.request({ method: 'POST', endpoint: 'packages', body: req })
    if (!result.success) return { success: false, error: result.error }
    const pkg = (result.data as { data?: TelnaV2Package })?.data || (result.data as TelnaV2Package)
    if (!pkg || (pkg.id == null && pkg.sim == null)) {
      return { success: false, error: { code: 'INVALID_RESPONSE', message: 'POST /packages response missing id/sim' } }
    }
    return { success: true, data: { pkg } }
  }

  async topUpESIM(_params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Top-up not implemented for Telna connector' } }
  }

  // ── Discovery Layer (Telna Phase 1B) ──────────────────────────────────

  async listCountries(count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaCountry[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'countries', query: { count, offset } })
    const duration = Date.now() - start
    const items = (result.success && result.data ? unwrapTelnaNamedList(result.data, 'countries') : []) || []
    const total = (result.success && result.data ? Number((result.data as { total?: unknown })?.total) || 0 : 0) || 0
    console.log(`[TELNA_DISCOVERY] method=listCountries success=${result.success} status=${result.status} itemCount=${items.length} total=${total} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Failed to list countries' } }
    }
    return { success: true, data: { items: items as TelnaCountry[], total } }
  }

  async getCompany(companyId: number): Promise<ConnectorResult<{ company: TelnaCompany }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'company', pathParams: { company_id: companyId } })
    const duration = Date.now() - start
    const company = result.success && result.data ? unwrapTelnaDetail(result.data, 'company') : null
    console.log(`[TELNA_DISCOVERY] method=getCompany companyId=${companyId} success=${result.success} status=${result.status} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success || !company) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Company not found' } }
    }
    return { success: true, data: { company: company as TelnaCompany } }
  }

  async listInventories(company?: number, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaInventory[]; total: number }>> {
    const start = Date.now()
    // Documented v2.1 filter: company=<company_id>
    const result = await this.request({ method: 'GET', endpoint: 'inventories', query: { company, count, offset } })
    const duration = Date.now() - start
    const items = (result.success && result.data ? unwrapTelnaNamedList(result.data, 'inventories') : []) || []
    const total = (result.success && result.data ? Number((result.data as { total?: unknown })?.total) || items.length : items.length)
    console.log(`[TELNA_DISCOVERY] method=listInventories company=${company} success=${result.success} status=${result.status} itemCount=${items.length} total=${total} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Failed to list inventories' } }
    }
    return { success: true, data: { items: items as TelnaInventory[], total } }
  }

  async listGroups(inventoryId?: number, company?: number, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaGroup[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'groups', query: { inventory_id: inventoryId, company_id: company, count, offset } })
    const duration = Date.now() - start
    const items = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaGroup>).data : []) || []
    const total = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaGroup>).total : 0) || 0
    console.log(`[TELNA_DISCOVERY] method=listGroups inventoryId=${inventoryId} company=${company} success=${result.success} status=${result.status} itemCount=${items.length} total=${total} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Failed to list groups' } }
    }
    return { success: true, data: { items, total } }
  }

  async getWallet(walletId: number): Promise<ConnectorResult<{ wallet: TelnaWallet }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'wallet', pathParams: { wallet_id: walletId } })
    const duration = Date.now() - start
    const wallet = result.success && result.data ? unwrapTelnaDetail(result.data, 'wallet') : null
    console.log(`[TELNA_DISCOVERY] method=getWallet walletId=${walletId} success=${result.success} status=${result.status} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success || !wallet) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Wallet not found' } }
    }
    return { success: true, data: { wallet: wallet as TelnaWallet } }
  }

  /** Documented v2.1 read-only: GET /inventory/inventories/{inventory_id} (Endpoint Mapping #14). */
  async getInventory(inventoryId: number): Promise<ConnectorResult<{ inventory: TelnaInventory }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'inventory', pathParams: { inventory_id: inventoryId } })
    const duration = Date.now() - start
    const inventory = result.success && result.data ? (result.data as { data: TelnaInventory }).data : null
    console.log(`[TELNA_INVENTORY_DETAIL] inventoryId=${inventoryId} success=${result.success} status=${result.status} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success || !inventory) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Inventory not found' } }
    }
    return { success: true, data: { inventory } }
  }

  /** Documented v2.1 read-only: GET /inventory/groups/{group_id} (Endpoint Mapping #5/#8). */
  async getGroup(groupId: number): Promise<ConnectorResult<{ group: TelnaGroup }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'group', pathParams: { group_id: groupId } })
    const duration = Date.now() - start
    const group = result.success && result.data ? unwrapTelnaDetail(result.data, 'group') : null
    console.log(`[TELNA_GROUP_DETAIL] groupId=${groupId} success=${result.success} status=${result.status} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success || !group) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Group not found' } }
    }
    return { success: true, data: { group: group as TelnaGroup } }
  }

  /** GET /v2.1/pcr/traffic-policies/{traffic_policy_id} — traffic policy detail. */
  async getTrafficPolicy(trafficPolicyId: number): Promise<ConnectorResult<{ trafficPolicy: Record<string, unknown> }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'trafficPolicy', pathParams: { traffic_policy_id: trafficPolicyId } })
    const duration = Date.now() - start
    const trafficPolicy = result.success && result.data ? unwrapTelnaDetail(result.data, 'trafficPolicy') : null
    console.log(`[TELNA_TRAFFIC_POLICY] trafficPolicyId=${trafficPolicyId} success=${result.success} status=${result.status} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success || !trafficPolicy) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Traffic policy not found' } }
    }
    return { success: true, data: { trafficPolicy: trafficPolicy as Record<string, unknown> } }
  }

  async getBalance(): Promise<ConnectorResult<{ balance: number | null; currency: string | null; accountId?: string | null; accountName?: string | null }>> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { config: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }
    const cfg = (provider.config as any) || {}
    const configuredWalletId = cfg.walletId

    // Resolve which wallet represents the usable vendor balance.
    // 1) Explicit walletId in provider config when present.
    // 2) Else list wallets: exactly one → use it; multiple → AMBIGUOUS (never
    //    pick the first silently); none → NOT_CONFIGURED (no fake zero).
    let wallet: TelnaWallet | null = null
    if (configuredWalletId != null) {
      const result = await this.getWallet(Number(configuredWalletId))
      if (!result.success || !result.data?.wallet) {
        return { success: false, error: result.error || { code: 'WALLET_FAILED', message: 'Failed to fetch wallet' } }
      }
      wallet = result.data.wallet
    } else {
      const list = await this.listWallets(100, 0)
      if (!list.success || !list.data) {
        return { success: false, error: list.error || { code: 'WALLET_FAILED', message: 'Failed to list Telna wallets' } }
      }
      const items = list.data.items || []
      if (items.length === 0) {
        return { success: false, error: { code: 'NOT_CONFIGURED', message: 'No Telna wallet found; configure walletId or an account wallet' } }
      }
      if (items.length > 1) {
        // Multiple wallets — ambiguous without a config-selected walletId.
        return { success: false, error: { code: 'BALANCE_AMBIGUOUS', message: 'Multiple Telna wallets; set walletId in provider config to select the operating wallet' } }
      }
      wallet = items[0]
    }

    if (!wallet) {
      return { success: false, error: { code: 'WALLET_FAILED', message: 'Telna wallet could not be resolved' } }
    }
    return {
      success: true,
      data: {
        balance: wallet.balance ?? null,
        currency: wallet.currency || null,
        accountId: wallet.id ? String(wallet.id) : null,
        accountName: wallet.name || null,
      },
    }
  }

  // ── Package Template Discovery (Telna Phase 2A) ───────────────────────

  async listPackageTemplates(inventoryId?: number, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaPackageTemplate[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'packageTemplates', query: { inventory_id: inventoryId, count, offset } })
    const duration = Date.now() - start
    const items = (result.success && result.data ? unwrapTelnaNamedList(result.data, 'package_templates') : []) || []
    const total = (result.success && result.data ? Number((result.data as { total?: unknown })?.total) || items.length : items.length)
    console.log(`[TELNA_PACKAGE_TEMPLATES] status=${result.status} requestId=${result.requestId} itemCount=${items.length} durationMs=${duration} inventoryId=${inventoryId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Failed to list package templates' } }
    }
    return { success: true, data: { items: items as TelnaPackageTemplate[], total } }
  }

  async getPackageTemplate(packageTemplateId: number): Promise<ConnectorResult<{ template: TelnaPackageTemplateDetail }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'packageTemplate', pathParams: { package_template_id: packageTemplateId } })
    const duration = Date.now() - start
    const template = result.success && result.data ? (result.data as { data: TelnaPackageTemplateDetail }).data : null
    console.log(`[TELNA_PACKAGE_TEMPLATE_DETAIL] templateId=${packageTemplateId} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !template) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Package template not found' } }
    }
    return { success: true, data: { template } }
  }

  // ── Package Sync (Telna Phase 2B) ────────────────────────────────────

  async listPackages(inventoryId?: number, packageTemplateId?: number, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaPackage[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({
      method: 'GET', endpoint: 'packages',
      query: { inventory_id: inventoryId, package_template_id: packageTemplateId, count, offset },
    })
    const duration = Date.now() - start
    const items = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaPackage>).data : []) || []
    const total = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaPackage>).total : 0) || 0
    console.log(`[TELNA_PACKAGES] status=${result.status} requestId=${result.requestId} itemCount=${items.length} total=${total} durationMs=${duration} inventoryId=${inventoryId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'SYNC_FAILED', message: result.error?.message || 'Failed to list packages' } }
    }
    return { success: true, data: { items, total } }
  }

  async getPackage(packageId: number): Promise<ConnectorResult<{ pkg: TelnaPackage }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'package', pathParams: { package_id: packageId } })
    const duration = Date.now() - start
    const pkg = result.success && result.data ? (result.data as { data: TelnaPackage }).data : null
    console.log(`[TELNA_PACKAGE_DETAIL] packageId=${packageId} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !pkg) {
      return { success: false, error: { code: result.error?.code || 'SYNC_FAILED', message: result.error?.message || 'Package not found' } }
    }
    return { success: true, data: { pkg } }
  }

  // ── SIM Registry (Telna Phase 3) ──────────────────────────────────────

  async listSimRegistries(inventoryId?: number, groupId?: number, status?: string, iccid?: string, imsi?: string, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaSimRegistry[]; total: number }>> {
    const start = Date.now()
    // Documented v2.1 filters (Endpoint Mapping #9): group=<group_id>; inventory_id
    // and status are additional repo-established filters (not contradicted by the doc).
    const result = await this.request({
      method: 'GET', endpoint: 'simRegistries',
      query: { inventory_id: inventoryId, group: groupId, status, iccid, imsi, count, offset },
    })
    const duration = Date.now() - start
    const items = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaSimRegistry>).data : []) || []
    const total = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaSimRegistry>).total : 0) || 0
    console.log(`[TELNA_SIM_REGISTRIES] status=${result.status} requestId=${result.requestId} itemCount=${items.length} total=${total} durationMs=${duration} inventoryId=${inventoryId} groupId=${groupId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Failed to list SIM registries' } }
    }
    return { success: true, data: { items, total } }
  }

  async getSimRegistry(iccid: string): Promise<ConnectorResult<{ sim: TelnaSimRegistry }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'simRegistry', pathParams: { iccid } })
    const duration = Date.now() - start
    const sim = result.success && result.data ? (result.data as { data: TelnaSimRegistry }).data : null
    console.log(`[TELNA_SIM_REGISTRY_DETAIL] iccid=${maskIccid(iccid)} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !sim) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'SIM registry entry not found' } }
    }
    return { success: true, data: { sim } }
  }

  // ── PCR Profile (Telna Phase 4) ────────────────────────────────────────

  async getSimPCRProfile(iccid: string): Promise<ConnectorResult<{ profile: TelnaPCRProfile }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'simPCRProfile', pathParams: { iccid } })
    const duration = Date.now() - start
    const profile = result.success && result.data ? (result.data as { data: TelnaPCRProfile }).data : null
    console.log(`[TELNA_PCR_PROFILE] iccid=${maskIccid(iccid)} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !profile) {
      return { success: false, error: { code: result.error?.code || 'PCR_FAILED', message: result.error?.message || 'PCR profile not found' } }
    }
    return { success: true, data: { profile } }
  }

  async updateSimPCRProfile(iccid: string, update: TelnaPCRProfileUpdate): Promise<ConnectorResult<{ profile: TelnaPCRProfile }>> {
    const start = Date.now()
    const result = await this.request({ method: 'PUT', endpoint: 'simPCRProfile', pathParams: { iccid }, body: update })
    const duration = Date.now() - start
    const profile = result.success && result.data ? (result.data as { data: TelnaPCRProfile }).data : null
    console.log(`[TELNA_PACKAGE_ASSIGN] iccid=${maskIccid(iccid)} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !profile) {
      return { success: false, error: { code: result.error?.code || 'PCR_FAILED', message: result.error?.message || 'PCR profile update failed' } }
    }
    return { success: true, data: { profile } }
  }

  // ── Usage Analytics (Telna Phase 5) ────────────────────────────────────

  async getSimUsage(iccid: string): Promise<ConnectorResult<{ usage: TelnaUsage }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'simUsage', pathParams: { iccid } })
    const duration = Date.now() - start
    const usage = result.success && result.data ? (result.data as { data: TelnaUsage }).data : null
    console.log(`[TELNA_USAGE] iccid=${maskIccid(iccid)} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !usage) {
      return { success: false, error: { code: result.error?.code || 'USAGE_FAILED', message: result.error?.message || 'Usage data not found' } }
    }
    return { success: true, data: { usage } }
  }

  async listSimSessions(iccid: string, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaSession[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'simSessions', pathParams: { iccid }, query: { count, offset } })
    const duration = Date.now() - start
    const items = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaSession>).data : []) || []
    const total = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaSession>).total : 0) || 0
    console.log(`[TELNA_SESSION] iccid=${maskIccid(iccid)} status=${result.status} requestId=${result.requestId} itemCount=${items.length} durationMs=${duration}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'SESSION_FAILED', message: result.error?.message || 'Failed to list sessions' } }
    }
    return { success: true, data: { items, total } }
  }

  async getSimBalances(iccid: string): Promise<ConnectorResult<{ balance: TelnaBalance }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'simBalances', pathParams: { iccid } })
    const duration = Date.now() - start
    const balance = result.success && result.data ? (result.data as { data: TelnaBalance }).data : null
    console.log(`[TELNA_BALANCE] iccid=${maskIccid(iccid)} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !balance) {
      return { success: false, error: { code: result.error?.code || 'BALANCE_FAILED', message: result.error?.message || 'Balance data not found' } }
    }
    return { success: true, data: { balance } }
  }

  async listWallets(count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaWallet[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'wallets', query: { count, offset } })
    const duration = Date.now() - start
    const items = (result.success && result.data ? unwrapTelnaNamedList(result.data, 'wallets') : []) || []
    const total = (result.success && result.data ? Number((result.data as { total?: unknown })?.total) || items.length : items.length)
    console.log(`[TELNA_WALLETS] status=${result.status} requestId=${result.requestId} itemCount=${items.length} durationMs=${duration}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'WALLET_FAILED', message: result.error?.message || 'Failed to list wallets' } }
    }
    return { success: true, data: { items: items as TelnaWallet[], total } }
  }
}
