import { prisma } from '@/lib/prisma'
import { decryptToken } from '@/lib/encryption'
import { claimProviderIccid, releaseProviderIccidClaim } from '@/lib/services/esims/esim-inventory-claim'
import { telnaEndpointPath, telnaEndpointAuthFamily, telnaEndpointMethod, telnaEndpointMutation, telnaEndpointEntitlement, isTelnaEndpointProven, buildTelnaEndpointUrl, type TelnaEndpoint, type TelnaAuthFamily, type TelnaHttpMethod, type TelnaPaginatedResponse,
 type TelnaCountry, type TelnaCompany, type TelnaInventory, type TelnaGroup, type TelnaWallet, type TelnaPackageTemplate, type TelnaPackageTemplateDetail, type TelnaPackage, type TelnaSimRegistry, type TelnaPCRProfile, type TelnaPCRProfileUpdate, type TelnaUsage, type TelnaSession, type TelnaBalance, type TelnaConsumption, type TelnaV2PackageTemplate, type TelnaCreatePackageRequest, type TelnaCreatePackageTemplateRequest, type TelnaV2Package, type TelnaV2SimRegistry, type TelnaEuiccProfile, type TelnaCreateCompanyRequest, type TelnaUpdateCompanyRequest, type TelnaCreateInventoryRequest, type TelnaUpdateInventoryRequest, type TelnaWalletPatchRequest, type TelnaPackageUpdateRequest } from './telna-endpoints'
import type { IProviderConnector, ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, TopUpESIMParams, TopUpESIMResult, UsageResult, StatusResult, RateResult, TokenState, EsimLifecycleResult, ConnectorCapabilities, ConnectorAuthProfile, StatusLookupEsim, StatusLookupIdentifier, ConnectorInstallDataOutput, InstallationLookupInput, InstallationLookupResult, CustomPackageDefinitionResult, CustomPackageCreateInput, CustomPackageCreateResult, AmbiguousPurchaseReconcileInput, AmbiguousPurchaseReconcileResult } from './connector-interface'
import { normalizeSimStatus } from '../mappers/telna-sim-mapper'
import { hasUsableInstallData } from '@/lib/esim/installation-data'
import { getCustomPackageCreationReadiness } from '@/lib/providers/capability-state'

interface TelnaRequestOptions {
  method?: TelnaHttpMethod
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

/**
 * Detail unwrap (bounded, non-recursive contract):
 *   namedKey supplied → { [namedKey]: DETAIL } | { data: { [namedKey]: DETAIL } } | { data: DETAIL } | { data: { data: DETAIL } } | bare DETAIL
 *   namedKey omitted  → { data: { data: DETAIL } } → { data: DETAIL } → bare object/array.
 * No arbitrary recursive unwrapping.
 */
export function unwrapTelnaDetail(body: unknown, namedKey?: string): unknown {
  if (!body || typeof body !== 'object') return body
  const b = body as Record<string, unknown>

  if (namedKey && b[namedKey] && typeof b[namedKey] === 'object') return b[namedKey]
  const data = b.data
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (namedKey && d[namedKey] && typeof d[namedKey] === 'object') return d[namedKey]
    if (d.data && typeof d.data === 'object') return d.data
    return data
  }
  return body
}

/**
 * Minimal provider-local fail-closed guard for a Telna detail object: a
 * meaningful detail is a non-null, non-array object that carries the SIM
 * identity (`iccid` string). Never a primitive, never a bare `{ data: null }`
 * / `{}` envelope, never an array — so `getSimPCRProfile` & friends never
 * report success with a meaningless wrapper object.
 */
export function telnaDetailWithIccid(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const iccid = (value as Record<string, unknown>).iccid
  return typeof iccid === 'string' && iccid.trim() !== ''
}

/**
 * Provider-local fail-closed guard for the V2.1 SIM PCR profile detail: a
 * meaningful profile is a non-null, non-array object that carries the SIM
 * identity under `sim` (NOT `iccid` — the documented PCR profile field). Never a
 * primitive, never a bare `{ data: null }` / `{}` envelope, never an array — so
 * `getSimPCRProfile` & friends never report success with a meaningless wrapper or
 * a profile that carries package identity but no SIM identity. The `sim` is
 * compared against nothing synthesized from the request path — only the provider
 * response is authoritative for identity.
 */
export function telnaPCRProfileWithSim(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const sim = (value as Record<string, unknown>).sim
  return typeof sim === 'string' && sim.trim() !== ''
}

/**
 * PCR-profile-specific envelope resolution for the V2.1 SIM PCR profile.
 *
 * The generic `unwrapTelnaDetail` contract descends through `data` fields
 * (`{ data: { data: DETAIL } }` → DETAIL), which misfires on the PCR profile
 * because the profile legitimately defines its OWN `data` (data_state)
 * sub-object — `{ data: PROFILE }` would be resolved to the inner
 * `data_state` instead of the profile. This resolver is `sim`-aware and never
 * descends into a layer that already carries the SIM identity.
 *
 * Precedence (first match wins), returns null when nothing meaningful:
 *   1. bare PROFILE                        (carries nonblank `sim`)
 *   2. named envelope { profile }           (incl. nested { data: { profile } })
 *   3. shallow wrapper { data: PROFILE }    (carries nonblank `sim`)
 *   4. nested envelope { data: { data: PROFILE } }
 *   5. nearest object leaf (guard still rejects if it lacks `sim`)
 */
export function unwrapTelnaPCRProfileDetail(body: unknown): Record<string, unknown> | null {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const carriesSim = (o: unknown): boolean =>
    o != null && typeof o === 'object' && !Array.isArray(o) &&
    typeof (o as Record<string, unknown>).sim === 'string' &&
    ((o as Record<string, unknown>).sim as string).trim() !== ''
  if (carriesSim(b)) return b as Record<string, unknown>
  const named = b.profile
  if (named != null && typeof named === 'object' && !Array.isArray(named)) return named as Record<string, unknown>
  const data = b.data
  if (data != null && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>
    if (carriesSim(d)) return d as Record<string, unknown>
    const nestedNamed = d.profile
    if (nestedNamed != null && typeof nestedNamed === 'object' && !Array.isArray(nestedNamed)) return nestedNamed as Record<string, unknown>
    const nestedData = d.data
    if (nestedData != null && typeof nestedData === 'object' && !Array.isArray(nestedData)) return nestedData as Record<string, unknown>
    return d as Record<string, unknown>
  }
  return b as Record<string, unknown>
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
 * Provider-local exact extraction of the Telna package-template id from a
 * package instance. The documented package_template field is the numeric
 * template id (primitive `number`) OR the fuller template object
 * ({ id: number|string, name, ... }). Tolerant, never fabricated: null when
 * absent/unparseable/empty so correlation never matches on a fabricated zero.
 */
export function telnaPackageTemplateId(template: unknown): number | null {
  if (template == null) return null
  const raw = typeof template === 'object' ? (template as Record<string, unknown>).id : template
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Provider-local canonical Telna SIM lifecycle state extractor.
 *
 * The live GET /v2.1/inventory/sim-registries contract carries the SIM state on
 * `sim_status` (e.g. "pre-service" / "in-service"), NOT `status`. This helper
 * prefers the live canonical `sim_status` and uses `status` only as a
 * compatibility fallback for older/alternate representations. The return value
 * is normalized through normalizeTelnaState ('' when neither field is present).
 */
export function getTelnaSimState(sim: TelnaV2SimRegistry | Record<string, unknown> | null | undefined): string {
  if (!sim || typeof sim !== 'object') return ''
  const s = sim as Record<string, unknown>
  const simStatus = typeof s.sim_status === 'string' && s.sim_status.trim() !== '' ? s.sim_status : undefined
  if (simStatus !== undefined) return normalizeTelnaState(simStatus)
  const status = typeof s.status === 'string' && s.status.trim() !== '' ? s.status : undefined
  if (status !== undefined) return normalizeTelnaState(status)
  return ''
}

/**
 * Provider-local numeric id extraction for a Telna `inventory` or `group`
 * reference. Live rows carry these as NUMERIC ids (e.g. `inventory: 50343`,
 * `group: 1113778`); legacy object form { id, name } is also tolerated.
 * Returns undefined when absent/unparseable — never fabricates an id.
 */
export function getTelnaRefId(ref: number | string | { id?: number | string; name?: string } | null | undefined): number | string | undefined {
  if (ref == null) return undefined
  if (typeof ref === 'number' || typeof ref === 'string') {
    const str = String(ref).trim()
    return str === '' ? undefined : ref
  }
  if (typeof ref === 'object') {
    const raw = ref.id
    if (raw == null) return undefined
    const str = String(raw).trim()
    return str === '' ? undefined : raw
  }
  return undefined
}

/** Extract the inventory id from a live/legacy SIM registry row. */
export function getTelnaInventoryId(sim: TelnaV2SimRegistry | Record<string, unknown> | null | undefined): number | string | undefined {
  if (!sim || typeof sim !== 'object') return undefined
  const s = sim as Record<string, unknown>
  if (s.inventory != null) return getTelnaRefId(s.inventory as never)
  if (s.inventory_id != null) return getTelnaRefId(s.inventory_id as never)
  return undefined
}

/** Extract the group id from a live/legacy SIM registry row. */
export function getTelnaGroupId(sim: TelnaV2SimRegistry | Record<string, unknown> | null | undefined): number | string | undefined {
  if (!sim || typeof sim !== 'object') return undefined
  const s = sim as Record<string, unknown>
  if (s.group != null) return getTelnaRefId(s.group as never)
  if (s.group_id != null) return getTelnaRefId(s.group_id as never)
  return undefined
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

  /**
   * Telna getStatus addresses the exact purchased package instance (C) via a
   * structured StatusLookupIdentifier `{ iccid, providerSubscriptionId }`: the
   * claimed ICCID (A) drives the SIM-registry / eUICC-profile evidence and
   * providerSubscriptionId drives the exact GET /v2.1/pcr/packages/{C} read.
   * Without structured addressing a UUID package instance would be misrouted
   * as an ICCID by the bare-string heuristic. Never derived from string shape —
   * this is an explicit connector-semantic declaration.
   */
  supportsStructuredStatusLookup = true

  constructor(providerId: string, name: string | undefined) {
    this.providerId = providerId
    this.name = name || 'Telna'
  }

  /** Telna (legacy) connector-declared internal capabilities. */
  capabilities: ConnectorCapabilities = {
    // Wired purchase path: activateESIM is fully implemented (inventory claim +
    // POST /v2.1/pcr/packages) and the endpoint is SOURCE_PROVEN with exposure
    // USED in the Telna endpoint registry — see activateESIM's own provenance,
    // host-surface and PCR-auth gates.
    purchase: true,
    // Install data (LPA/QR) is NOT returned in the purchase response — the
    // created package stays PENDING_ACTIVATION and install evidence arrives via
    // GET /euicc-profiles/{iccid}. No verified evidence either way → UNKNOWN.
    installationDataAtPurchase: 'UNKNOWN',
    installationLookup: true, // documented GET /euicc-profiles/{iccid} — activation_code
    installationLookupHistorical: true,
    statusLookup: true, // SIM registry + eUICC profile evidence
    usageLookup: true, // package data_usage_remaining (BYTES)
    topUp: false,
    suspend: false,
    resume: false,
    balance: true, // getWallet
    inventory: true, // GET /sim-registries
    catalogSync: true, // syncPlans wired
    webhooks: false,
    // Provider-side custom package/template creation (POST /v2.1/pcr/package-templates)
    // is CONTRACT-SUPPORTED (implemented + correctly mapped). LIVE_MUTATION_VALIDATED
    // is NOT yet true — the generic Provider Catalog does not auto-invoke it and no
    // live POST has been performed. See separate readiness gate for live use.
    customPackageCreation: true,
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
    // HTTP method defaults to the registry's canonical method for this endpoint
    // (e.g. walletUpdate → PATCH); an explicit override is still honoured.
    const method = opts.method || telnaEndpointMethod(opts.endpoint)
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
    //
    // IMPORTANT: the live package-template DETAIL response has NO `inventory`
    // property — so a missing inventory here is NOT evidence that the template
    // has no inventory. Selection simply falls back to the unfiltered SIM
    // registry GET when no inventory id can be derived. When a template DOES
    // carry an inventory reference it may be a numeric/string id (live create
    // contract uses `inventory: string | number`) or a legacy array of
    // { id, name } — both are handled via a tolerant id extraction.
    let templateInventoryId: number | string | undefined
    try {
      const tpl = await this.getV2PackageTemplate(templateId)
      if (tpl.success && tpl.data?.template) {
        const inv = tpl.data.template.inventory
        if (Array.isArray(inv)) {
          const first = inv[0]
          if (first?.id != null) templateInventoryId = Number(first.id) || String(first.id)
        } else {
          templateInventoryId = getTelnaRefId(inv as never)
        }
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
        // Telna failed. Only PROVABLY pre-commit rejections release the
        // ownership-safe claim (the request never became a billable mutation):
        // HTTP 4xx (authentication/validation/not-found/rate-limit) and local
        // config/host guards. Every other failure — timeout, network error,
        // unparseable response, 5xx, unknown — MAY have committed the package
        // at Telna, so the claim is HELD and the outcome is owned by
        // reconciliation: the same ICCID must never be sold to a second
        // purchase while the existing transaction is unresolved.
        claimError = result.error?.code || 'PACKAGE_CREATE_FAILED'
        const claimErrCode = String(claimError).toUpperCase()
        const provablyPreCommit =
          (claimErrCode.startsWith('HTTP_') && /^\d\d\d$/.test(claimErrCode.replace('HTTP_', '')) && claimErrCode.replace('HTTP_', '').startsWith('4')) ||
          ['NOT_CONFIGURED', 'HOST_MISMATCH', 'UNVERIFIED_ENDPOINT'].includes(claimErrCode)
        if (provablyPreCommit) {
          await releaseProviderIccidClaim({ purchaseId: orderId, iccid })
        }
        return { success: false, error: result.error || { code: 'PACKAGE_CREATE_FAILED', message: 'Telna package creation failed' } }
      }

      const pkg = result.data.pkg
      // createPackage ONLY succeeds when the provider returned its created
      // package instance id — so the exact provider reference (C) is guaranteed
      // here and can never fall back to the ICCID (A).
      const packageInstanceId = String(pkg.id)
      const rawMetadata: Record<string, any> = {
        // Three distinct identities:
        //  - iccid                     = Telna eSIM identity (A)
        //  - providerTemplateId        = Telna package template id = catalog plan (B)
        //  - providerPackageInstanceId = exact created Telna package instance (C)
        iccid,
        providerTemplateId: templateId,
        providerPackageInstanceId: packageInstanceId,
        packageStatus: pkg.status ?? null,
      }

      return {
        success: true,
        data: {
          // activationId = the EXACT created provider package instance (C). The
          // esim identity (A) is the claimed ICCID and stays in iccids /
          // iccidOrSimId / rawMetadata only — it is never the activationId. The
          // package instance id is preserved verbatim so later usage/status can
          // address the EXACT package.
          activationId: packageInstanceId,
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
   *
   * The canonical SIM state is read via getTelnaSimState (live `sim_status`
   * preferred, `status` compatibility fallback) — not `s.status` directly,
   * since the live contract reports the lifecycle state under `sim_status`.
   */
  private async listEligibleIccids(inventoryId?: number | string): Promise<string[]> {
    const result = await this.listV2SimRegistries(
      inventoryId != null ? Number(inventoryId) : undefined,
    )
    if (!result.success || !result.data) return []
    const sims = result.data.items || []
    const candidates = sims
      .filter(s => s?.iccid && normalizeTelnaState(s.iccid).trim() !== '' && getTelnaSimState(s) === 'PRE_SERVICE')
      .map(s => String(s.iccid))
    if (candidates.length === 0) return []

    const used = await prisma.eSIM.findMany({ where: { iccid: { in: candidates } }, select: { iccid: true } })
    const usedSet = new Set(used.map(u => u.iccid))
    return candidates.filter(c => !usedSet.has(c))
  }

  async getStatus(identifier: string | StatusLookupIdentifier): Promise<ConnectorResult<StatusResult>> {
    // Telna status is keyed by provider-owned identifiers ONLY. Never a local
    // OneSIM id. Two identifier forms reach getStatus:
    //   - a bare ICCID string (status sync / resolveStatusLookup / iccid lookups);
    //   - a bare package instance id string (activation polling & reconciliation
    //     forward the persisted providerReference = POST /v2.1/pcr/packages
    //     activationId = the exact created package instance (C));
    //   - a structured StatusLookupIdentifier { iccid, providerSubscriptionId }
    //     (usage-style exact package addressing — providerSubscriptionId wins).
    //
    // DISPATCH RULE: digit strings ≥18 chars are ICCID-shaped; shorter numeric
    // strings are the numeric Telna package instance id. Any non-digit string is
    // treated as an ICCID (legacy evidence path). MISDIRECTED identifiers are
    // fail-safe: no error can fabricate a PENDING that releases reserved funds.
    let iccid: string = ''
    let packageId: string = ''
    if (typeof identifier === 'string') {
      const s = String(identifier).trim()
      if (/^\d{18,23}$/.test(s)) {
        iccid = s
      } else if (s !== '' && /^\d+$/.test(s)) {
        packageId = s
      } else {
        iccid = s
      }
    } else if (identifier && typeof identifier === 'object') {
      const obj = identifier as StatusLookupIdentifier
      iccid = (obj.iccid || '').trim()
      packageId = (obj.providerSubscriptionId || '').trim()
    }
    if (!iccid && !packageId) {
      return { success: false, error: { code: 'IDENTIFIER_MISSING', message: 'ICCID is required for Telna status lookup' } }
    }

    // Evidence set: SIM registry (PRE_SERVICE/IN_SERVICE/TERMINATED), eUICC
    // profile (RELEASED/DOWNLOADED/INSTALLED/ENABLED/DISABLED), and package
    // status (NOT_ACTIVE/ACTIVE/TERMINATED). All read-only, provider-owned.
    let simStatus: string | null = null
    let profileState: string | null = null
    let profileActivationCode: string | null = null
    let exactPackageStatus: string | null = null
    let expiryDate: string | undefined

    // Exact package instance read (authoritative when the id is known — the POST
    // was accepted and returned this id). GET /v2.1/pcr/packages/{package_id}
    // addresses the purchased package directly and also yields the OWNED ICCID
    // via pkg.sim. A failure here is tolerated as optional evidence: one
    // best-effort 400 must never override an authoritative success elsewhere.
    let exactReadError: { code?: string; message?: string } | null = null
    if (packageId) {
      try {
        const exact = await this.getV2Package(packageId)
        if (exact.success && exact.data?.pkg) {
          exactPackageStatus = normalizeTelnaState(exact.data.pkg.status)
          if (!iccid && exact.data.pkg.sim) iccid = String(exact.data.pkg.sim)
          expiryDate = exact.data.pkg.expiry_date || expiryDate
        } else {
          exactReadError = exact.error || null
        }
      } catch { exactReadError = { code: 'NETWORK_ERROR', message: 'Package status lookup threw' } }
    }

    if (!iccid) {
      if (exactReadError) {
        // Exact package read failed AND no ICCID identity is derivable — the
        // unresolved read is preserved as a failure (never fabricated into a
        // PENDING). Upstream classification keeps the wallet held.
        return {
          success: false,
          error: {
            code: exactReadError.code || 'RESOURCE_NOT_FOUND',
            message: exactReadError.message || 'Exact package status lookup failed',
          },
        }
      }
      // Package known but no ICCID identity derivable → report the exact
      // package status WITHOUT an identity. The finalizers fail closed when the
      // fulfillment identity (ICCID) is absent; activationCode is never one.
      const status = exactPackageStatus === 'TERMINATED' ? 'EXPIRED' : exactPackageStatus === 'ACTIVE' ? 'ACTIVE' : 'PENDING_ACTIVATION'
      return {
        success: true,
        data: {
          status,
          rawStatus: exactPackageStatus || 'UNKNOWN',
          evidence: { reason: 'packages-exact-no-iccid' },
          rawMetadata: { source: 'packages/{package_id}', rawStatus: exactPackageStatus || 'UNKNOWN', exactPackageStatus, simStatus: null, profileState: null, packageStatus: exactPackageStatus },
        },
      }
    }

    // 1) SIM registry (best-effort — availability of /sim-registries is live-proven).
    const reg = await this.getV2SimRegistry(iccid)
    if (reg.success && reg.data?.sim) {
      simStatus = getTelnaSimState(reg.data.sim)
    }

    // 2) eUICC profile (best-effort — conveys install/enable evidence, not network usage).
    const prof = await this.getEuiccProfile(iccid)
    if (prof.success && prof.data?.profile?.state) {
      profileState = normalizeTelnaState(prof.data.profile.state)
      if (prof.data.profile.activation_code) profileActivationCode = String(prof.data.profile.activation_code)
    }

    // 3) Package-list status is intentionally SUPPLEMENTAL ABSENT here. The
    //    documented V2.1 package-list filter surface (GET /v2.1/pcr/packages?
    //    inventory&package_template&sim&status&count&offset) is a correlation
    //    aid only; the lifecycle derives from the SIM-registry / eUICC evidence
    //    above and, when an exact package instance id (C) was supplied, the
    //    exact GET /v2.1/pcr/packages/{package_id} read (done above) remains the
    //    authoritative package-of-record source.

    // Conservative, provider-neutral normalization. Evidence is mapped into the
    // canonical StatusResult.evidence contract; the generic lifecycle engine
    // decides the final stored status via deriveEsimLifecycleStatus.
    //
    // Lifecycle precedence: SIM TERMINATED is STRONG terminal SIM evidence and
    // wins. A TERMINATED PACKAGE alone does NOT terminate the physical eSIM —
    // Telna supports another package / top-up on that SIM — so a terminated
    // listed package must never force EXPIRED. The EXACT package read (package
    // path, id known) IS authoritative for the purchased instance.
    const rawStatus = profileState || simStatus || exactPackageStatus || 'UNKNOWN'
    let status: string
    let evidence: StatusResult['evidence']

    // Terminal evidence is limited to the SIM registry and the exact package
    // record. The eUICC profile states DELETED / UNAVAILABLE / ERROR are NOT
    // terminal: they describe profile delivery or removal at the eUICC layer
    // (a failed download/install or a profile no longer present), which is not
    // proof the subscription expired. They fall through to the weak branches
    // below so the canonical engine preserves any stronger stored state.
    if (simStatus === 'TERMINATED') {
      // SIM TERMINATED = the physical eSIM is terminated at the provider —
      // strong terminal SIM evidence.
      status = 'EXPIRED'
      evidence = { reason: 'telna-sim-terminated' }
    } else if (exactPackageStatus === 'TERMINATED') {
      // The exact GET /v2.1/pcr/packages/{package_id} record of the purchased
      // instance is TERMINATED — authoritative terminal evidence for it.
      status = 'EXPIRED'
      evidence = { reason: 'telna-package-terminated' }
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
    } else if (exactPackageStatus === 'ACTIVE') {
      // Authoritative provider record from the exact GET /pcr/packages/{package_id}
      // read: the purchased package instance is ACTIVE at Telna. This is the
      // provider-owned status of record and wins even when one optional ICCID-keyed
      // read (sim-registry / euicc / package list) failed with a best-effort 400.
      status = 'ACTIVE'
      evidence = { reason: 'packages-exact-active' }
    } else if ((profileState === 'RELEASED' || profileState === 'DOWNLOADED') && profileActivationCode) {
      // Profile provisioned with a usable activation code = the deliverable is in
      // hand (ready to install). The ICCID is the fulfillment identity; the
      // activation code is delivery data forwarded to finalization, never an
      // identity and never sufficient on its own.
      status = 'COMPLETED'
      evidence = { reason: 'euicc-released-install-ready' }
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
        iccids: [iccid],
        ...(profileActivationCode ? { activationCode: profileActivationCode } : {}),
        expiresAt: expiryDate,
        evidence,
        rawMetadata: { source: exactPackageStatus ? 'packages/{package_id}+sim-registry+euicc-profiles' : 'sim-registry+euicc-profiles', rawStatus, simStatus, profileState, exactPackageStatus, packageId: packageId || undefined },
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
    // package instance id), address that package directly. Fallback is permitted
    // ONLY when it is bounded by a provider-proven identifier: the exact
    // package-template id (B, via providerPlanId) plus exact-local ICCID (A)
    // matching with uniqueness proof. Never an unrestricted account-wide scan,
    // never an arbitrary first/non-terminated pick among several.
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
      } catch { /* fall through to bounded fallback */ }
    }

    // 2) Bounded fallback: exact template id (B) + exact local ICCID (A) with
    //    uniqueness proof. Missing B fails closed — no account-wide hunt.
    if (!packageInstance) {
      const templateId = Number(String((identifier as StatusLookupIdentifier)?.providerPlanId || '').trim())
      if (!Number.isFinite(templateId) || templateId <= 0) {
        return { success: false, error: { code: 'DATA_UNAVAILABLE', message: 'Exact Telna package instance id required for usage lookup (no boundable package template id available)' } }
      }
      const correlated = await this.reconcileByTemplate(templateId, [iccid])
      if (!correlated.success) {
        return { success: false, error: { code: 'DATA_UNAVAILABLE', message: 'Telna package read failed during usage lookup' } }
      }
      const valid = correlated.candidates.filter((c) => c.id !== '')
      if (valid.length !== 1) {
        return {
          success: false,
          error: {
            code: 'DATA_UNAVAILABLE',
            message: valid.length > 1
              ? 'Multiple Telna packages match this ICCID + template — exact package instance id required'
              : 'No uniquely matching Telna package instance for this ICCID + template',
          },
        }
      }
      packageInstance = valid[0].raw
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
        rawMetadata: { source: packageInstanceId && String(packageInstanceId).trim() !== '' ? 'packages/{package_id}' : 'packages-by-template+exact-local-iccid', packageId: packageInstance.id ? String(packageInstance.id) : undefined, remainingBytes: Math.round(remainingBytes) },
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
    // The exact template id (B) is carried forward so a missing package instance
    // id (C) can still fall back to a BOUNDED template scan (never an
    // account-wide ICCID hunt).
    const planId = raw?.providerPlanId != null && String(raw.providerPlanId).trim() !== '' ? String(raw.providerPlanId) : (esim.providerPlanId != null && String(esim.providerPlanId).trim() !== '' ? String(esim.providerPlanId) : undefined)
    return {
      iccid: esim.iccid,
      ...(typeof packageInstanceId === 'string' && packageInstanceId ? { providerSubscriptionId: packageInstanceId } : {}),
      ...(planId ? { providerPlanId: planId } : {}),
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

  /**
   * GET /v2.1/pcr/packages — package filter surface (named `packages` envelope,
   * tolerant). ONLY the documented V2.1 package-list query names are used:
   * `inventory`, `package_template`, `sim`, `status`, `count`, `offset`. The
   * legacy `inventory_id`/`package_template_id` names belong to OTHER endpoints
   * (path params / sim-registry) and are NEVER used for GET /v2.1/pcr/packages.
   * The `sim` filter is documented and allowed; correlated sims are additionally
   * verified locally against candidate.sim so a filter-lie can never certify a
   * package for the wrong ICCID.
   */
  async listV2Packages(filters: { sim?: string; package_template?: number | string; inventory?: number | string; status?: string; count?: number; offset?: number } = {}): Promise<ConnectorResult<{ items: TelnaV2Package[]; total: number }>> {
    const result = await this.request({ method: 'GET', endpoint: 'packages', query: filters })
    const items = (result.success && result.data ? unwrapTelnaNamedList(result.data, 'packages') : []) || []
    const total = (result.success && result.data ? Number((result.data as { total?: unknown })?.total) || items.length : items.length)
    if (!result.success) {
      return { success: false, error: result.error || { code: 'PACKAGES_FAILED', message: 'Failed to list packages' } }
    }
    return { success: true, data: { items: items as TelnaV2Package[], total } }
  }

  /**
   * Exact numeric package-template id of a listed package instance: the nested
   * `package_template` object/primitive first, then the flat
   * `package_template_id`. null when absent/unparseable — never fabricated.
   */
  private packageTemplateIdOf(pkg: TelnaV2Package): number | null {
    const nested = telnaPackageTemplateId(pkg.package_template)
    if (nested !== null) return nested
    const raw = (pkg as { package_template_id?: number | string }).package_template_id
    if (raw != null && String(raw).trim() !== '') {
      const n = Number(String(raw).trim())
      return Number.isFinite(n) ? n : null
    }
    return null
  }

  /**
   * Bounded, read-only correlation of package instances by the exact template id
   * (B) + exact local ICCID (A) match. Paginates GET /v2.1/pcr/packages by
   * `package_template=<B>` (documented query name) — and additionally by
   * `sim=<A>` when exactly one claimed ICCID is supplied — with a finite page
   * cap and PAGE_SIZE ≤ 100. Every candidate is defended locally: its template
   * must resolve exactly to B (string-compared) and its sim must exactly equal
   * one of the claimed ICCIDs. Never POSTs; never picks first/newest/closest-by-
   * time; never substitutes A for C.
   */
  private async reconcileByTemplate(
    planId: number,
    iccids: string[],
  ): Promise<{ success: true; candidates: Array<{ id: string; iccid: string; status: string | null; templateId: number | null; raw: TelnaV2Package }> } | { success: false }> {
    // Bounded: the documented V2.1 package-list page size is at most 100 and the
    // scan has a finite defensive page cap — never an unbounded account scan.
    const PAGE_SIZE = 100
    const MAX_PAGES = 25
    const iccidSet = new Set(iccids)
    const planIdStr = String(planId)
    const candidates: Array<{ id: string; iccid: string; status: string | null; templateId: number | null; raw: TelnaV2Package }> = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE
      // A+B filter: exact template id (B) always; exact sim (A) when a single
      // claimed ICCID is known (documented package-list `sim` filter).
      const result = await this.listV2Packages({
        sim: iccids.length === 1 ? iccids[0] : undefined,
        package_template: planId,
        count: PAGE_SIZE,
        offset,
      })
      if (!result.success || !result.data) return { success: false }
      const items = result.data.items || []
      const total = result.data.total
      for (const p of items) {
        // Defensive exact-B gate: a provider candidate outside the requested
        // template is rejected even if the server-side filter was not honored.
        const templateId = this.packageTemplateIdOf(p)
        if (templateId !== null && String(templateId) !== planIdStr) continue
        // Defensive exact-A gate: a candidate must carry a sim exactly equal to
        // one claimed ICCID — never a fuzzy/time/positional match.
        const pkgSim = p.sim != null && String(p.sim).trim() !== '' ? String(p.sim) : null
        if (!pkgSim || !iccidSet.has(pkgSim)) continue
        candidates.push({
          id: p.id != null && String(p.id).trim() !== '' ? String(p.id) : '',
          iccid: pkgSim,
          status: p.status != null ? String(p.status) : null,
          templateId,
          raw: p,
        })
      }
      // Stop only when the page is short or the total is exhausted — never stop
      // after a single valid candidate while later pages could add ambiguity.
      if (items.length === 0 || offset + items.length >= total) break
    }
    return { success: true, candidates }
  }

  /**
   * Provider-neutral read-only reconciliation of an ambiguous Telna activation.
   *
   * Correlates the exact claimed ICCIDs (A) against the documented GET
   * /v2.1/pcr/packages read — NEVER a POST, NEVER a replay of the activation.
   *
   * Correlation is bounded by the exact Telna package-template id (B) + the
   * exact claimed ICCID (A) — documented package-list filters:
   *   1. the package list is queried with `package_template=<B>` (+ `sim=<A>`
   *      when exactly one ICCID is claimed) and paginated with a finite
   *      defensive cap and PAGE_SIZE ≤ 100;
   *   2. candidate.sim MUST exactly equal one of the supplied exact ICCIDs;
   *   3. when the candidate carries template info it must resolve exactly to B
   *      (defensive local re-check of the provider-returned list);
   *   4. a candidate only counts when it carries a real package instance id (C);
   *   5. exactly one such candidate → resolved with evidence.providerPackageInstanceId = C;
   *   6. zero → 'no-match' (unresolved, wallet held);
   *   7. several → 'multiple-matches' (unresolved, wallet held).
   *
   * No claimed ICCID, or no valid numeric template id (B) → 'inconclusive':
   * FAIL CLOSED. Never an unrestricted account-wide package scan, never a
   * blind ICCID hunt.
   */
  async reconcileAmbiguousPurchase(input: AmbiguousPurchaseReconcileInput): Promise<ConnectorResult<AmbiguousPurchaseReconcileResult>> {
    const iccids = Array.isArray(input.iccids)
      ? input.iccids.map(String).filter((v) => typeof v === 'string' && v.trim() !== '')
      : []
    // Prefer an existing persisted provider-owned reference (C) BEFORE any A+B
    // correlation. The generic engine recovers order-level evidence first
    // (providerFulfillId / providerReservationId) then the best owning-provider
    // ProviderAttempt.providerReference and passes it here. A persisted value is
    // NEVER trusted on its own — it must be VERIFIED independently through the
    // authoritative exact detail read GET /v2.1/pcr/packages/{package_id}, and
    // resolution demands every exact identity check: package.id === C, sim
    // exactly equals one claimed ICCID (A), and package_template.id equals the
    // claimed numeric plan id (B). Any mismatch FAILS CLOSED (unresolved, wallet
    // held, no A+B fallback that could silently replace the persisted provider
    // transaction identity); a read failure or not-found stays conservative.
    const candidateC = String(input.providerReference ?? '').trim()
    if (candidateC !== '') {
      const claimedPlanId = String(input.planId ?? '').trim()
      const claimedTemplateId = Number(claimedPlanId)
      if (iccids.length === 0 || claimedPlanId === '' || !Number.isFinite(claimedTemplateId) || claimedTemplateId <= 0) {
        // Without an exact claimed ICCID (A) and a valid numeric plan id (B) the
        // exact reference cannot be identity-verified — FAIL CLOSED.
        return {
          success: true,
          data: {
            resolved: false,
            reason: 'inconclusive',
            evidence: {
              source: 'provider-reference-exact-verification',
              providerPackageInstanceId: candidateC,
              note: 'no claimed ICCID and/or no valid numeric package template id (B) to verify the exact reference against',
            },
          },
        }
      }
      const detail = await this.getV2Package(candidateC)
      if (!detail.success || !detail.data) {
        return {
          success: true,
          data: {
            resolved: false,
            reason: 'inconclusive',
            evidence: {
              source: 'provider-reference-exact-verification',
              providerPackageInstanceId: candidateC,
              note: 'persisted provider reference could not be verified — provider detail read failed or not found',
            },
          },
        }
      }
      const pkg = detail.data.pkg
      const pkgId = pkg.id != null && String(pkg.id).trim() !== '' ? String(pkg.id) : ''
      const pkgSim = pkg.sim != null && String(pkg.sim).trim() !== '' ? String(pkg.sim) : ''
      const pkgTemplateId = this.packageTemplateIdOf(pkg)
      const idOk = pkgId === candidateC
      const simOk = pkgSim !== '' && iccids.includes(pkgSim)
      const templateOk = pkgTemplateId !== null && String(pkgTemplateId) === String(claimedTemplateId)
      if (!idOk || !simOk || !templateOk) {
        const failed = !idOk ? 'exact provider reference id mismatch' : !simOk ? 'claimed ICCID (A) mismatch' : 'claimed package template (B) mismatch'
        return {
          success: true,
          data: {
            resolved: false,
            reason: 'no-match',
            evidence: {
              source: 'provider-reference-exact-verification',
              providerPackageInstanceId: pkgId || candidateC,
              packageStatus: pkg.status != null ? String(pkg.status) : null,
              note: `reference-identity-mismatch: ${failed} — no A+B fallback to avoid silently replacing the persisted provider transaction identity`,
            },
          },
        }
      }
      return {
        success: true,
        data: {
          resolved: true,
          reason: 'unique-match',
          iccid: pkgSim,
          evidence: {
            source: 'provider-reference-exact-verification',
            providerPackageInstanceId: pkgId,
            packageStatus: pkg.status != null ? String(pkg.status) : null,
            identityChecks: { id: true, sim: true, template: true },
          },
        },
      }
    }
    if (iccids.length === 0) {
      return {
        success: true,
        data: {
          resolved: false,
          reason: 'inconclusive',
          evidence: { source: 'packages-template-correlation', iccidProvided: false, note: 'no claimed ICCID provided to correlate' },
        },
      }
    }

    const planId = String(input.planId ?? '').trim()
    const templateId = Number(planId)
    if (planId === '' || !Number.isFinite(templateId) || templateId <= 0) {
      // FAIL CLOSED: without a valid numeric package-template id (B) there is no
      // provider-proven bound under which exact local ICCID correlation is safe.
      return {
        success: true,
        data: {
          resolved: false,
          reason: 'inconclusive',
          evidence: { source: 'packages-template-correlation', iccids, templateFilter: null, templateFilterApplied: false, note: 'no valid Telna package template id (B) — account-wide ICCID scan refused' },
        },
      }
    }

    // Read-only bounded scan keyed by the exact template id (B) + exact ICCID (A).
    const correlated = await this.reconcileByTemplate(templateId, iccids)
    if (!correlated.success) {
      return {
        success: false,
        error: { code: 'RECONCILE_READ_FAILED', message: 'Failed to read Telna package instances during reconciliation' },
      }
    }

    const candidates = correlated.candidates
    const baseEvidence: Record<string, unknown> = {
      source: 'packages-template-correlation',
      iccids,
      candidateCount: candidates.length,
      templateFilter: templateId,
      templateFilterApplied: true,
      simFilter: iccids.length === 1 ? iccids[0] : undefined,
      simFilterApplied: iccids.length === 1,
      matchedCount: candidates.length,
    }

    if (candidates.length === 0) {
      return {
        success: true,
        data: {
          resolved: false,
          reason: 'no-match',
          evidence: baseEvidence,
        },
      }
    }

    const carriesRealId = candidates.filter((c) => c.id !== '')
    if (carriesRealId.length === 0) {
      return {
        success: true,
        data: {
          resolved: false,
          reason: 'no-match',
          evidence: { ...baseEvidence, note: 'matched candidates carried no package instance id — no provider reference to recover' },
        },
      }
    }

    if (carriesRealId.length > 1) {
      return {
        success: true,
        data: {
          resolved: false,
          reason: 'multiple-matches',
          evidence: { ...baseEvidence, packageInstanceIds: carriesRealId.map((c) => c.id) },
        },
      }
    }

    const winner = carriesRealId[0]
    return {
      success: true,
      data: {
        resolved: true,
        reason: 'unique-match',
        iccid: winner.iccid,
        evidence: {
          ...baseEvidence,
          providerPackageInstanceId: winner.id,
          packageStatus: winner.status,
        },
      },
    }
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
   * POST /v2.1/pcr/packages — creates a service package on an EXISTING Telna SIM.
   * Documented body: { sim, package_template, time_allowance? }.
   * NEVER a local OneSIM id; only the provider-owned ICCID + template id.
   *
   * The dedicated `packageCreate` registry entry (mutation:true) is authoritative
   * for this purchase mutation — the read-labelled `packages` key is never reused
   * to POST. Exactly ONE mutating HTTP request per dispatch; no retry/replay.
   */
  async createPackage(req: TelnaCreatePackageRequest): Promise<ConnectorResult<{ pkg: TelnaV2Package }>> {
    const result = await this.request({ endpoint: 'packageCreate', body: req })
    if (!result.success) return { success: false, error: result.error }
    const pkg = (result.data as { data?: TelnaV2Package })?.data || (result.data as TelnaV2Package)
    // An HTTP 2xx means Telna ACCEPTED the package creation — the mutation
    // committed. But this method only reports success when the provider returns
    // the CREATED package instance id (C). A missing/flat package payload or a
    // missing `id` in an otherwise-accepted response is PROOF the purchase took
    // place WITHOUT a usable provider package reference. This is NEVER resolved
    // by substituting the ICCID (A) as activationId, never by fabricating an
    // arbitrary id, and never by re-POSTing. It is surfaced as an ambiguous
    // upstream-confirmed outcome so the P0 dispatch preserves the ICCID claim,
    // the wallet hold and the order ownership while a bounded read-only
    // correlation runs.
    if (!pkg || pkg.id == null || String(pkg.id).trim() === '') {
      const code = pkg ? 'AMBIGUOUS_PACKAGE_ID_MISSING' : 'INVALID_RESPONSE'
      const message = pkg
        ? 'Telna accepted the package creation but the response carried no package instance id'
        : 'POST /v2.1/pcr/packages returned no package object'
      return {
        success: false,
        error: {
          code,
          message,
          details: {
            ambiguous: true,
            upstreamConfirmed: true,
            reconciliationRequired: true,
            sim: req.sim,
            packageTemplateId: req.package_template,
          },
        },
      }
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

  /** GET /v2.1/core/companies?count=&offset= — named `companies` list envelope (CORE, RAW auth). */
  async listCompanies(count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaCompany[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'companies', query: { count, offset } })
    const duration = Date.now() - start
    const items = (result.success && result.data ? unwrapTelnaNamedList(result.data, 'companies') : []) || []
    const total = (result.success && result.data ? Number((result.data as { total?: unknown })?.total) || items.length : items.length)
    console.log(`[TELNA_DISCOVERY] method=listCompanies success=${result.success} status=${result.status} itemCount=${items.length} total=${total} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Failed to list companies' } }
    }
    return { success: true, data: { items: items as TelnaCompany[], total } }
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

  /** GET /v2.1/pcr/traffic-policies — named `traffic_policies` list envelope (PCR). */
  async listTrafficPolicies(count?: number, offset?: number): Promise<ConnectorResult<{ items: Record<string, unknown>[]; total: number }>> {
    const result = await this.request({ method: 'GET', endpoint: 'trafficPolicies', query: { count, offset } })
    const items = (result.success && result.data ? unwrapTelnaNamedList(result.data, 'traffic_policies') : []) || []
    const total = (result.success && result.data ? Number((result.data as { total?: unknown })?.total) || items.length : items.length)
    if (!result.success) {
      return { success: false, error: result.error || { code: 'DISCOVERY_FAILED', message: 'Failed to list traffic policies' } }
    }
    return { success: true, data: { items: items as Record<string, unknown>[], total } }
  }

  /** GET /v2.1/pcr/route-policies — named `route_policies` list envelope (PCR). */
  async listRoutePolicies(inventory: string | number, count?: number, offset?: number): Promise<ConnectorResult<{ items: Record<string, unknown>[]; total: number }>> {
    if (inventory == null || String(inventory).trim() === '') {
      return { success: false, error: { code: 'INVALID_REQUEST', message: 'inventory is required to list route policies' } }
    }
    const result = await this.request({ method: 'GET', endpoint: 'routePolicies', query: { inventory, count, offset } })
    const items = (result.success && result.data ? unwrapTelnaNamedList(result.data, 'route_policies') : []) || []
    const total = (result.success && result.data ? Number((result.data as { total?: unknown })?.total) || items.length : items.length)
    if (!result.success) {
      return { success: false, error: result.error || { code: 'DISCOVERY_FAILED', message: 'Failed to list route policies' } }
    }
    return { success: true, data: { items: items as Record<string, unknown>[], total } }
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

  /**
   * GET /v2.1/pcr/packages — package sync read. Delegates to the SINGLE
   * canonical package-list query contract (listV2Packages: inventory /
   * package_template / sim / status / count / offset — the documented V2.1
   * package-list names, never inventory_id / package_template_id).
   */
  async listPackages(inventoryId?: number, packageTemplateId?: number, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaPackage[]; total: number }>> {
    const start = Date.now()
    const result = await this.listV2Packages({ inventory: inventoryId, package_template: packageTemplateId, count, offset })
    const duration = Date.now() - start
    const items = (result.success && result.data ? result.data.items : []) || []
    const total = result.success ? result.data?.total ?? items.length : 0
    console.log(`[TELNA_PACKAGES] itemCount=${items.length} total=${total} durationMs=${duration} inventoryId=${inventoryId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'SYNC_FAILED', message: result.error?.message || 'Failed to list packages' } }
    }
    return { success: true, data: { items: items as unknown as TelnaPackage[], total } }
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
    const sim = result.success && result.data ? unwrapTelnaDetail(result.data, 'sim') : null
    console.log(`[TELNA_SIM_REGISTRY_DETAIL] iccid=${maskIccid(iccid)} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !telnaDetailWithIccid(sim)) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'SIM registry entry not found' } }
    }
    return { success: true, data: { sim: sim as unknown as TelnaSimRegistry } }
  }

  // ── PCR Profile (Telna Phase 4) ────────────────────────────────────────

  async getSimPCRProfile(iccid: string): Promise<ConnectorResult<{ profile: TelnaPCRProfile }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'simPCRProfile', pathParams: { iccid } })
    const duration = Date.now() - start
    // The PCR detail envelope is resolved through the sim-aware provider-local
    // resolver (NOT the generic unwrapTelnaDetail, whose nested-`data` descent
    // would misfire on the profile's own `data`/data_state sub-object). Fail
    // closed unless a meaningful PCR profile carrying the SIM identity (`sim`
    // per the V2.1 contract — NOT `iccid`) was extracted — never success with a
    // wrapper/primitive, never success when only package identity (e.g. an old
    // current_package shape) is present.
    const profile = result.success && result.data ? unwrapTelnaPCRProfileDetail(result.data) : null
    console.log(`[TELNA_PCR_PROFILE] iccid=${maskIccid(iccid)} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !telnaPCRProfileWithSim(profile)) {
      return { success: false, error: { code: result.error?.code || 'PCR_FAILED', message: result.error?.message || 'PCR profile not found' } }
    }
    return { success: true, data: { profile: profile as unknown as TelnaPCRProfile } }
  }

  async updateSimPCRProfile(iccid: string, update: TelnaPCRProfileUpdate): Promise<ConnectorResult<{ profile: TelnaPCRProfile }>> {
    const start = Date.now()
    const result = await this.request({ method: 'PUT', endpoint: 'simPCRProfile', pathParams: { iccid }, body: update })
    const duration = Date.now() - start
    const profile = result.success && result.data ? unwrapTelnaPCRProfileDetail(result.data) : null
    console.log(`[TELNA_PACKAGE_ASSIGN] iccid=${maskIccid(iccid)} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !telnaPCRProfileWithSim(profile)) {
      return { success: false, error: { code: result.error?.code || 'PCR_FAILED', message: result.error?.message || 'PCR profile update failed' } }
    }
    return { success: true, data: { profile: profile as unknown as TelnaPCRProfile } }
  }

  // ── Usage Analytics (Telna Phase 5) ────────────────────────────────────

  async getSimUsage(iccid: string): Promise<ConnectorResult<{ usage: TelnaUsage }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'simUsage', pathParams: { iccid } })
    const duration = Date.now() - start
    const usage = result.success && result.data ? unwrapTelnaDetail(result.data, 'usage') : null
    console.log(`[TELNA_USAGE] iccid=${maskIccid(iccid)} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !telnaDetailWithIccid(usage)) {
      return { success: false, error: { code: result.error?.code || 'USAGE_FAILED', message: result.error?.message || 'Usage data not found' } }
    }
    return { success: true, data: { usage: usage as unknown as TelnaUsage } }
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
    const balance = result.success && result.data ? unwrapTelnaDetail(result.data, 'balance') : null
    console.log(`[TELNA_BALANCE] iccid=${maskIccid(iccid)} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !telnaDetailWithIccid(balance)) {
      return { success: false, error: { code: result.error?.code || 'BALANCE_FAILED', message: result.error?.message || 'Balance data not found' } }
    }
    return { success: true, data: { balance: balance as unknown as TelnaBalance } }
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

  /**
   * Provider-neutral custom offering/template definition for Telna.
   *
   * Exposes provider-owned inventories + traffic policies (as creation options)
   * and the documented Telna-specific template fields. No credentials are
   * exposed as fields. The actual POST is NOT enabled for live use until the
   * endpoint is vendor-confirmed (capability stays false); this only describes
   * what the contract would accept.
   */
  async getCustomPackageDefinition(): Promise<CustomPackageDefinitionResult> {
    let inventories: Array<{ id: string | number; name: string }> = []
    let trafficPolicies: Array<{ id: string | number; name: string }> = []
    try {
      const inv = await this.listInventories()
      if (inv.success) inventories = (inv.data?.items || []).map(i => ({ id: i.id, name: i.name }))
    } catch { /* best-effort */ }
    try {
      const tp = await this.listTrafficPolicies()
      if (tp.success) trafficPolicies = (tp.data?.items || []).map(p => ({ id: String(p.id || p.traffic_policy_id || ''), name: String(p.name || p.traffic_policy_name || '') })).filter(x => x.id)
    } catch { /* best-effort */ }

    return {
      success: true,
      definition: {
        inventories,
        trafficPolicies,
        providerFields: [
          { key: 'traffic_policy', label: 'Traffic Policy', type: 'select', required: false },
          { key: 'inventory', label: 'Inventory', type: 'select', required: false },
          { key: 'activation_type', label: 'Activation Type', type: 'select', required: false, options: [{ value: 'AUTO', label: 'Auto' }, { value: 'MANUAL', label: 'Manual' }] },
          { key: 'notes', label: 'Notes', type: 'string', required: false },
          { key: 'earliest_activation_date', label: 'Earliest Activation Date', type: 'string', required: false },
          { key: 'earliest_available_date', label: 'Earliest Available Date', type: 'string', required: false },
          { key: 'latest_available_date', label: 'Latest Available Date', type: 'string', required: false },
        ],
      },
    }
  }

  /**
   * Provider-side custom package/template creation (POST /v2.1/pcr/package-templates).
   *
   * Creates a NEW OFFERING — distinct from POST /packages (purchase/assignment).
   * Validation happens here (provider-owned inventory/traffic-policy, ISO
   * countries, data>0, valid validity, supported activation type). No local
   * OneSIM id is sent upstream. providerPlanId = the returned Telna template id.
   *
   * CONTRACT_SUPPORTED = true (implemented to the documented contract: numeric
   * `activation_time_allowance` in SECONDS kept distinct from the `time_allowance`
   * OBJECT { duration, unit }).
   * LIVE MUTATION guard: this method performs a POST /package-templates only when
   * the provider is explicitly READY (connector supports it AND provider is
   * operational AND `enabledCapabilities` includes CUSTOM_PACKAGE_CREATION).
   * Otherwise it returns CAPABILITY_NOT_ENABLED and makes NO HTTP request. This is
   * enforced server-side here (never trust the browser). LIVE_MUTATION_VALIDATED
   * is false until a controlled staging POST succeeds; readiness enablement is an
   * explicit operator action, never auto-flipped by a GET.
   */
  async createCustomPackage(input: CustomPackageCreateInput): Promise<ConnectorResult<CustomPackageCreateResult>> {
    // Runtime readiness gate — provider-neutral via enabledCapabilities.
    const readiness = await getCustomPackageCreationReadiness(this.providerId).catch(() => ({ ready: false, reason: 'readiness-check-failed' }))
    if (!readiness.ready) {
      return {
        success: false,
        error: {
          code: 'CAPABILITY_NOT_ENABLED',
          message: `Custom package creation is not enabled for this provider (${readiness.reason ?? 'not-ready'})`,
        },
      }
    }
    if (!input.name || !String(input.name).trim()) {
      return { success: false, error: { code: 'INVALID_REQUEST', message: 'name is required' } }
    }
    if (!Number.isFinite(input.dataGB) || input.dataGB <= 0) {
      return { success: false, error: { code: 'INVALID_REQUEST', message: 'dataGB must be > 0' } }
    }
    if (!Number.isFinite(input.validityDays) || input.validityDays <= 0) {
      return { success: false, error: { code: 'INVALID_REQUEST', message: 'validityDays must be > 0' } }
    }

    const body: TelnaCreatePackageTemplateRequest = {
      name: String(input.name),
      data_usage_allowance: Math.round(input.dataGB * 1024 * 1024 * 1024), // GB -> BYTES
      // Validity / time allowance → documented OBJECT { duration, unit }.
      time_allowance: { duration: Math.round(input.validityDays), unit: 'SECOND' } as { duration: number; unit: 'CALENDAR_MONTH' | 'SECOND' },
      // Activation window allowance → separate numeric SECONDS field (documented INTEGER).
      ...(input.activationTimeAllowanceSeconds != null
        ? { activation_time_allowance: Math.round(input.activationTimeAllowanceSeconds) }
        : {}),
      ...(input.voiceMinutes != null ? { voice_usage_allowance: input.voiceMinutes } : {}),
      ...(input.smsCount != null ? { sms_usage_allowance: input.smsCount } : {}),
      ...(input.activationType ? { activation_type: String(input.activationType).toUpperCase() as 'AUTO' | 'MANUAL' } : {}),
      ...(input.countries && input.countries.length ? { supported_countries: input.countries } : {}),
      ...(input.inventoryId != null ? { inventory: input.inventoryId } : {}),
      ...(input.trafficPolicyId != null ? { traffic_policy: input.trafficPolicyId } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.providerValues ? { ...(input.providerValues as Record<string, unknown>) } : {}),
    }

    const result = await this.request({ method: 'POST', endpoint: 'packageTemplateCreate', body })
    if (!result.success) return { success: false, error: result.error }

    const created = unwrapTelnaDetail(result.data, 'template') as Record<string, unknown> | null
    const providerPlanId = created?.id != null ? String(created.id) : undefined
    if (!providerPlanId) {
      return { success: false, error: { code: 'INVALID_RESPONSE', message: 'POST /package-templates response missing template id' } }
    }
    return {
      success: true,
      data: {
        success: true,
        providerPlanId,
        providerPlanCode: providerPlanId,
        status: created?.status ? String(created.status) : undefined,
        rawMetadata: { name: input.name, dataGB: input.dataGB, validityDays: input.validityDays },
      },
    }
  }

  // ── Mapped-but-disabled CORE / INVENTORY mutations (NOT_STANDARD_PLAN) ──
  // Contract is registered only so the operation can be supported later if the
  // Telna add-on is enabled — without an architectural rewrite. These methods
  // ALWAYS block before any HTTP and are never exposed as enabled capabilities.
  private gateDisabledEndpoint(endpoint: TelnaEndpoint, label: string): { success: false; error: { code: string; message: string } } {
    const entitlement = telnaEndpointEntitlement(endpoint)
    return {
      success: false,
      error: { code: entitlement === 'NOT_STANDARD' ? 'NOT_STANDARD' : 'NOT_ENABLED', message: `${label} is not enabled for this provider (${entitlement})` },
    }
  }

  async createCompany(body: TelnaCreateCompanyRequest): Promise<ConnectorResult<{ id: string | number }>> {
    return this.gateDisabledEndpoint('companiesCreate', 'Create company')
  }
  async updateCompany(companyId: number, body: TelnaUpdateCompanyRequest): Promise<ConnectorResult<{ id: string | number }>> {
    return this.gateDisabledEndpoint('companyUpdate', 'Modify company')
  }
  async createInventory(body: TelnaCreateInventoryRequest): Promise<ConnectorResult<{ id: string | number }>> {
    return this.gateDisabledEndpoint('inventoryCreate', 'Create inventory')
  }
  async updateInventory(inventoryId: number, body: TelnaUpdateInventoryRequest): Promise<ConnectorResult<{ id: string | number }>> {
    return this.gateDisabledEndpoint('inventoryUpdate', 'Modify inventory')
  }

  /** Irreversible SIM purge/destroy — DANGEROUS: always refused, never an ordinary admin action. */
  async purgeSimRegistry(iccid: string): Promise<ConnectorResult<{ ok: true }>> {
    return this.gateDisabledEndpoint('simRegistryPurge', 'Purge SIM registry entry')
  }

  /**
   * PUT /v2.1/pcr/packages/{package_id} — provider method exists and is mapped,
   * but no OneSIM lifecycle operation maps unambiguously to its documented
   * payload. Kept as internal provider-level method; capability is NOT exposed.
   */
  async updatePackageInstance(packageId: string | number, body: TelnaPackageUpdateRequest): Promise<ConnectorResult<{ package: TelnaV2Package }>> {
    const result = await this.request({ endpoint: 'packageUpdate', pathParams: { package_id: packageId }, body })
    const pkg = result.success && result.data ? unwrapTelnaDetail(result.data, 'data') : null
    if (!result.success) {
      return { success: false, error: result.error || { code: 'PACKAGE_UPDATE_FAILED', message: 'Package update failed' } }
    }
    return { success: true, data: { package: (pkg || {}) as TelnaV2Package } }
  }

  /**
   * PATCH /v2.1/pcr/wallets/{wallet_id} — mapped and provider method available,
   * but NOT a normal OneSIM capability (wallet remains entitlement-pending).
   */
  async updateWallet(walletId: number, body: TelnaWalletPatchRequest): Promise<ConnectorResult<{ wallet: TelnaWallet }>> {
    const result = await this.request({ endpoint: 'walletUpdate', pathParams: { wallet_id: walletId }, body })
    const wallet = result.success && result.data ? unwrapTelnaDetail(result.data, 'wallet') : null
    if (!result.success) {
      return { success: false, error: result.error || { code: 'WALLET_UPDATE_FAILED', message: 'Wallet update failed' } }
    }
    return { success: true, data: { wallet: (wallet || {}) as TelnaWallet } }
  }
}
