import { RestCatalogConnector, type RestCatalogConfig } from './rest-catalog-connector'
import type { ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, TopUpESIMParams, TopUpESIMResult, StatusResult, DiagnosticInfo, StatusLookupIdentifier, StatusLookupEsim, UsageResult, EsimLifecycleResult, QRCodeResult } from './connector-interface'
import { normalizeBalanceResponse, probeBalanceFields, sanitizeDiagnosticSensitive } from '@/lib/providers/balance/normalize-balance'

interface UrlTokenConfig extends RestCatalogConfig {
  fieldMappings?: Record<string, any>
  balancePath?: string
  /** Choice package_detail path override. Default: /account/v03_09/package_detail */
  packageDetailPath?: string
  /** Choice suspend_imsi path override. Default: /account/v03_09/suspend_imsi */
  suspendPath?: string
  /** Choice resume_imsi path override. Default: /account/v03_09/resume_imsi */
  resumePath?: string
  currency?: string
  timeoutMs?: number
}

async function fetchText(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ text?: string; error?: { code: string; message: string }; status?: number; contentType?: string }> {
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
    const contentType = response.headers?.get?.('content-type') || ''
    const text = await response.text()
    if (!response.ok) return { error: { code: `HTTP_${status}`, message: text.substring(0, 300) }, status, contentType }
    return { text, status, contentType }
  } catch (e: any) {
    if (e.name === 'AbortError') return { error: { code: 'TIMEOUT', message: 'Request timed out' } }
    return { error: { code: 'NETWORK_ERROR', message: e.message } }
  }
}

function maskToken(token: string): string {
  if (!token || token.length < 8) return token || ''
  return token.slice(0, 4) + '••••' + token.slice(-4)
}

function urlHostname(raw: string): string {
  try { return new URL(raw).hostname } catch { return raw }
}

/** Guarded Choice balance diagnostics: OFF unless CHOICE_BALANCE_DIAGNOSTICS_ENABLED=true. */
function choiceBalanceDiagnosticsEnabled(): boolean {
  return process.env.CHOICE_BALANCE_DIAGNOSTICS_ENABLED === 'true'
}

interface AuthAccount {
  account: string
  accountName: string
  token: string
  uaid?: string
  userId?: string
}

/** Choice lifecycle value groups (case/underscore-insensitive). */
const CHOICE_STATUS_GROUPS: Record<string, string[]> = {
  ACTIVE: ['active', 'in use', 'in_use', 'enabled'],
  PENDING_ACTIVATION: ['new', 'pending', 'ready', 'ready to install', 'ready_to_install', 'provisioned'],
  SUSPENDED: ['suspended', 'suspend', 'disabled', 'blocked'],
  EXPIRED: ['expired', 'closed'],
  FAILED: ['failed', 'error', 'rejected'],
  CANCELLED: ['cancelled', 'canceled', 'deleted'],
}

const MEANINGFUL_INTERNAL_STATUSES = ['ACTIVE', 'PENDING_ACTIVATION', 'SUSPENDED', 'EXPIRED', 'FAILED', 'CANCELLED']

/** Legacy/placeholder Choice user_id values that must never be sent upstream. */
const CHOICE_USER_ID_PLACEHOLDERS = ['onesim', 'default', 'choice', 'unknown', 'n/a', 'na', 'none', 'null', 'undefined']

/**
 * Normalize a candidate Choice user_id. Rejects empty and legacy placeholder
 * sentinels (e.g. 'onesim'), returning '' so the resolution chain falls through
 * to a real authenticated account id. Never silently sends a placeholder.
 */
export function normalizeChoiceUserId(candidate: unknown): string {
  const value = typeof candidate === 'string' ? candidate.trim() : (candidate == null ? '' : String(candidate).trim())
  if (!value) return ''
  if (CHOICE_USER_ID_PLACEHOLDERS.includes(value.toLowerCase())) return ''
  return value
}

function normalizeChoiceToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, ' ')
}

/**
 * Normalize raw Choice lifecycle values into OneSIM internal statuses.
 *
 * Priority:
 * 1. package.status when it contains a recognized lifecycle value.
 * 2. package.package_status when recognized.
 * 3. Existing stored internal status as a safe fallback.
 * 4. PENDING_ACTIVATION only when no safer status exists.
 *
 * Never downgrades an existing meaningful status merely because Choice returns
 * an unknown value. Returns both the normalized internal status and the raw
 * provider status.
 */
export function normalizeChoiceStatus(
  rawStatus: string | null | undefined,
  packageStatus: string | null | undefined,
  currentStatus?: string | null,
): { status: string; providerStatus: string } {
  const statusToken = normalizeChoiceToken(rawStatus || '')
  const packageStatusToken = normalizeChoiceToken(packageStatus || '')
  const rawProviderStatus = (rawStatus && rawStatus.trim()) ? String(rawStatus).trim() : (packageStatus && packageStatus.trim()) ? String(packageStatus).trim() : ''

  const resolveGroup = (value: string): string | undefined => {
    if (!value) return undefined
    for (const [group, variants] of Object.entries(CHOICE_STATUS_GROUPS)) {
      if (variants.includes(value)) return group
    }
    return undefined
  }

  const recognized = resolveGroup(statusToken) || resolveGroup(packageStatusToken)
  if (recognized) return { status: recognized, providerStatus: rawProviderStatus }

  if (currentStatus && MEANINGFUL_INTERNAL_STATUSES.includes(String(currentStatus).toUpperCase())) {
    return { status: String(currentStatus).toUpperCase(), providerStatus: rawProviderStatus }
  }

  return { status: 'PENDING_ACTIVATION', providerStatus: rawProviderStatus }
}

/** Resolve the query identifier per Choice priority: ICCID → IMSI → imsi_version. */
function resolveChoiceStatusIdentifier(lookup: StatusLookupIdentifier): { key: 'iccid' | 'imsi' | 'imsi_version'; value: string | number } | null {
  if (lookup.iccid && String(lookup.iccid).trim()) return { key: 'iccid', value: String(lookup.iccid).trim() }
  if (lookup.imsi && String(lookup.imsi).trim()) return { key: 'imsi', value: String(lookup.imsi).trim() }
  if (lookup.imsiVersion != null && String(lookup.imsiVersion).trim() !== '') return { key: 'imsi_version', value: lookup.imsiVersion }
  return null
}

/**
 * Sanitized package metadata for persistence: structure preserved, sensitive
 * values masked, `imsi_version` kept (needed for later status lookups).
 */
function sanitizeChoiceStatusMetadata(json: any): Record<string, any> {
  const pkg = json?.package || json?.data?.package || json?.response?.package
  const sanitized = sanitizeDiagnosticSensitive({ success: json?.success, errmsg: json?.errmsg || '', package: pkg })
  if (sanitized?.package && pkg && pkg.imsi_version != null) {
    sanitized.package.imsi_version = pkg.imsi_version
  }
  return sanitized as Record<string, any>
}

/** Decimal telecom unit → MB conversion factors (B/KB/MB/GB/TB), case-insensitive. */
const USAGE_UNIT_TO_MB: Record<string, number> = {
  B: 1 / (1024 * 1024),
  KB: 1 / 1024,
  MB: 1,
  GB: 1024,
  TB: 1024 * 1024,
}

/** True when the unit is recognized or absent (absent defaults to GB). */
export function choiceUsageUnitSupported(unit: unknown): boolean {
  const u = String(unit ?? '').trim().toUpperCase()
  if (!u) return true
  return u in USAGE_UNIT_TO_MB
}

/**
 * Convert a Choice usage/allowance value to MB. Returns null when the value is
 * missing/invalid or the unit is unsupported — callers must surface a specific
 * error instead of returning a misleading zero.
 */
export function convertChoiceUsageToMB(value: unknown, unit: unknown): number | null {
  if (value == null || String(value).trim() === '') return null
  const num = typeof value === 'number' ? value : parseFloat(String(value))
  if (!Number.isFinite(num)) return null
  const u = String(unit ?? '').trim().toUpperCase()
  const factor = USAGE_UNIT_TO_MB[u]
  if (factor === undefined) return null
  return num * factor
}

/**
 * Parse a Choice timestamp as UTC. Choice documents timestamps (e.g.
 * "2026-08-01 00:00:00.000") as UTC; ISO 8601 is also accepted. A missing
 * timezone is treated as UTC — never reinterpreted as server-local time.
 */
export function parseChoiceUtcTimestamp(value: unknown): Date | null {
  if (value == null) return null
  let s = String(value).trim()
  if (!s) return null
  const iso = s.replace(' ', 'T')
  let ts = iso
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) {
    ts = `${ts}T00:00:00.000Z`
  } else if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(ts)) {
    ts = `${ts}Z`
  }
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d
}

export interface ChoiceRateGroupRow {
  [key: string]: any
}

export interface ChoiceRateGroupSelection {
  rows: ChoiceRateGroupRow[]
  selectedIndices: number[]
  reason: string
}

function positiveNumber(value: unknown): number | null {
  if (value == null || String(value).trim() === '') return null
  const n = typeof value === 'number' ? value : parseFloat(String(value))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Pick the rate-group rows that describe the package allowance.
 *
 * Priority:
 * 1. A row carrying a positive `rate_group_total_qty` represents the full-package
 *    allowance (the "total duration" row); the per-day row is never added to it.
 * 2. Rows with distinct `rate_group_id`s are independent allowances and are
 *    aggregated.
 * 3. Otherwise fall back to the row with the latest package-level expiry so two
 *    ambiguous rows are never blindly summed.
 * 4. Last resort: the first row.
 */
export function selectChoiceUsageRateGroups(rateGroups: unknown): ChoiceRateGroupSelection {
  const rows = (Array.isArray(rateGroups) ? rateGroups : []).filter((r): r is ChoiceRateGroupRow => !!r && typeof r === 'object')
  if (rows.length === 0) return { rows: [], selectedIndices: [], reason: 'RATE_GROUPS_MISSING' }

  const totalRows = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => positiveNumber(row.rate_group_total_qty) !== null)
  if (totalRows.length > 0) {
    const selected = totalRows.reduce((best, cur) => {
      const bestExp = parseChoiceUtcTimestamp(best.row.rate_group_expire)
      const curExp = parseChoiceUtcTimestamp(cur.row.rate_group_expire)
      if (curExp && (!bestExp || curExp.getTime() > bestExp.getTime())) return cur
      if (!bestExp) {
        const bestQty = positiveNumber(best.row.rate_group_total_qty) || 0
        const curQty = positiveNumber(cur.row.rate_group_total_qty) || 0
        if (curQty > bestQty) return cur
      }
      return best
    })
    return { rows: [selected.row], selectedIndices: [selected.index], reason: 'TOTAL_ROW_SELECTED' }
  }

  const ids = rows.map((row) => String(row.rate_group_id ?? '').trim())
  if (ids.every((id) => id !== '') && new Set(ids).size === ids.length) {
    return { rows, selectedIndices: rows.map((_, i) => i), reason: 'DISTINCT_RATE_GROUPS_AGGREGATED' }
  }

  let latestIndex = -1
  let latestExp: Date | null = null
  rows.forEach((row, index) => {
    const exp = parseChoiceUtcTimestamp(row.rate_group_expire)
    if (exp && (!latestExp || exp.getTime() > latestExp.getTime())) {
      latestIndex = index
      latestExp = exp
    }
  })
  if (latestIndex >= 0) return { rows: [rows[latestIndex]], selectedIndices: [latestIndex], reason: 'LATEST_EXPIRY_SELECTED' }

  return { rows: [rows[0]], selectedIndices: [0], reason: 'FALLBACK_FIRST_ROW' }
}

export interface ChoiceUsageNormalized {
  dataUsedMB: number
  dataTotalMB: number
  dataRemainingMB: number
  percentageUsed: number
  expiresAt?: string
  status?: string
  rawMetadata?: Record<string, any>
}

export type NormalizeChoiceUsageResult =
  | { ok: true; usage: ChoiceUsageNormalized }
  | { ok: false; error: { code: string; message: string } }

/**
 * Normalize the Choice package_detail `package` object into the usage contract.
 * Unit semantics: `rate_group_usage` and `rate_group_allowance` share the row's
 * `rate_group_allow_qtyp` unit (Choice returns the same quantity type for both);
 * a missing unit defaults to GB (Choice convention).
 */
export function normalizeChoiceUsage(pkg: any, currentStatus?: string, rawJson?: any): NormalizeChoiceUsageResult {
  const selection = selectChoiceUsageRateGroups(pkg?.rate_groups)
  if (selection.rows.length === 0) {
    return { ok: false, error: { code: 'CHOICE_USAGE_RATE_GROUPS_MISSING', message: 'Choice usage response has no rate_groups to normalize' } }
  }

  let totalMB = 0
  let usedMB = 0
  let latestExpiry: Date | null = null

  for (const row of selection.rows) {
    const unit = String(row.rate_group_allow_qtyp ?? '').trim().toUpperCase() || 'GB'
    if (!choiceUsageUnitSupported(unit)) {
      return { ok: false, error: { code: 'CHOICE_USAGE_UNIT_UNSUPPORTED', message: `Unsupported Choice usage unit "${unit}"` } }
    }
    const allowanceMB = convertChoiceUsageToMB(row.rate_group_allowance, unit)
    if (allowanceMB === null) {
      return { ok: false, error: { code: 'CHOICE_USAGE_TOTAL_MISSING', message: 'Choice usage response is missing a valid total allowance (rate_group_allowance)' } }
    }
    const usageMB = convertChoiceUsageToMB(row.rate_group_usage, unit)
    if (usageMB === null) {
      return { ok: false, error: { code: 'CHOICE_USAGE_VALUE_MISSING', message: 'Choice usage response is missing a valid usage value (rate_group_usage)' } }
    }
    totalMB += allowanceMB
    usedMB += usageMB
    const exp = parseChoiceUtcTimestamp(row.rate_group_expire)
    if (exp && (!latestExpiry || exp.getTime() > latestExpiry.getTime())) latestExpiry = exp
  }

  if (!(totalMB > 0)) {
    return { ok: false, error: { code: 'CHOICE_USAGE_TOTAL_MISSING', message: 'Choice usage total allowance is not positive' } }
  }

  const used = Math.max(0, usedMB)
  const remaining = Math.max(0, totalMB - used)
  const percentage = Math.min(100, Math.max(0, (used / totalMB) * 100))

  const fallbackExpiry = parseChoiceUtcTimestamp(pkg?.rate_group_expire)
  const expiresAt = latestExpiry || fallbackExpiry

  const rawStatus = typeof pkg?.status === 'string' ? pkg.status : ''
  const packageStatus = typeof pkg?.package_status === 'string' ? pkg.package_status : ''

  return {
    ok: true,
    usage: {
      dataUsedMB: used,
      dataTotalMB: totalMB,
      dataRemainingMB: remaining,
      percentageUsed: percentage,
      ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
      status: normalizeChoiceStatus(rawStatus, packageStatus, currentStatus).status,
      rawMetadata: sanitizeChoiceStatusMetadata(rawJson ?? { package: pkg }),
    },
  }
}

export class UrlTokenConnector extends RestCatalogConnector {
  protected override config: UrlTokenConfig

  constructor(providerId: string, name: string | undefined, config: UrlTokenConfig) {
    super(providerId, name, config)
    this.config = config
  }

  private get fieldMappings(): Record<string, any> {
    return (this.config as any).fieldMappings || {}
  }

  /**
   * Resolve the effective Choice user_id with the approved precedence:
   * explicit admin override (fieldMappings.userId) → authenticated
   * provider.config.userId → selectedAccountId fallback → '' (caller fails
   * safely). Legacy placeholders ('onesim' etc.) are rejected at every step.
   */
  private resolveEffectiveChoiceUserId(): string {
    return normalizeChoiceUserId(this.fieldMappings.userId)
      || normalizeChoiceUserId((this.config as any)?.userId)
      || normalizeChoiceUserId((this.config as any)?.selectedAccountId)
  }

  protected get headers(): Record<string, string> {
    return {}
  }

  async getBalance(): Promise<ConnectorResult<{ balance: number | null; currency: string | null; accountId?: string | null; accountName?: string | null }>> {
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'API base URL not configured' } }
    const token = this.config.apiToken || ''
    if (!token) return { success: false, error: { code: 'CHOICE_CREDENTIALS_MISSING', message: 'No Choice API token configured' } }

    const balancePath = this.config.balancePath || '/account/v03_09/prepaid_balance'
    const url = this.baseUrl(`${balancePath}/${encodeURIComponent(token)}`)
    const host = urlHostname(url)

    console.log(`[PROVIDER_BALANCE_REQUEST] providerCode=CHOICE hostname=${host} endpoint=${balancePath}`)

    const start = Date.now()
    const { text, error, status, contentType } = await fetchText(url, {
      headers: { Accept: 'application/json' },
      timeoutMs: this.config.timeoutMs,
    })
    const durationMs = Date.now() - start

    if (error) {
      let code = error.code
      let message = error.message
      if (status === 401 || status === 403) {
        code = 'CHOICE_AUTH_UNAUTHORIZED'
        message = 'Choice balance endpoint returned unauthorized'
      }
      if (status === 404) {
        code = 'CHOICE_BALANCE_ENDPOINT_NOT_FOUND'
        message = 'Choice balance endpoint not found (404)'
      }
      console.log(`[PROVIDER_BALANCE_RESULT] providerCode=CHOICE success=false error=${code} httpStatus=${status ?? 'unknown'} hostname=${host} endpoint=${balancePath} durationMs=${durationMs}`)
      return { success: false, error: { code, message } }
    }
    if (!text) return { success: false, error: { code: 'EMPTY', message: 'Empty balance response' } }

    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      console.log(`[PROVIDER_BALANCE_RESULT] providerCode=CHOICE success=false error=CHOICE_BALANCE_NON_JSON httpStatus=${status ?? 'unknown'} contentType=${contentType || 'unknown'} hostname=${host} endpoint=${balancePath}`)
      return { success: false, error: { code: 'CHOICE_BALANCE_NON_JSON', message: 'Choice balance response is not valid JSON' } }
    }

    this.logBalanceDiagnostics(status, contentType, json, token)

    const normalized = normalizeBalanceResponse(json, { fallbackCurrency: this.config.currency })
    if (!normalized.success) {
      console.log(`[PROVIDER_BALANCE_RESULT] providerCode=CHOICE success=false error=CHOICE_BALANCE_FIELD_MISSING reason=${normalized.reason} httpStatus=${status ?? 'unknown'} hostname=${host} endpoint=${balancePath} durationMs=${durationMs}`)
      return { success: false, error: { code: 'CHOICE_BALANCE_FIELD_MISSING', message: 'No numeric balance field found in Choice balance response' } }
    }

    console.log(`[PROVIDER_BALANCE_RESULT] providerCode=CHOICE success=true balance=${normalized.balance} currency=${normalized.currency} path=${normalized.balancePath} httpStatus=${status ?? 'unknown'} hostname=${host} endpoint=${balancePath} durationMs=${durationMs}`)
    return {
      success: true,
      data: {
        balance: normalized.balance,
        currency: normalized.currency,
        accountId: json.account_id || json.accountId || json.data?.account_id || json.data?.accountId || null,
        accountName: json.account_name || json.accountName || json.data?.account_name || json.data?.accountName || null,
      },
    }
  }

  private logBalanceDiagnostics(httpStatus: number | undefined, contentType: string | undefined, json: any, token: string): void {
    if (!choiceBalanceDiagnosticsEnabled()) return
    const sanitized = sanitizeDiagnosticSensitive(json)
    let safeJson = JSON.stringify(sanitized)
    if (token) safeJson = safeJson.split(token).join('[REDACTED]')
    console.log(`[CHOICE_BALANCE_RESPONSE] httpStatus=${httpStatus ?? 'unknown'} contentType=${contentType || 'unknown'} topKeys=${Object.keys(json ?? {}).join(',')} balanceFields=${JSON.stringify(probeBalanceFields(json))} full=${safeJson}`)
  }

  async getRoamingProfiles(): Promise<ConnectorResult<Array<{ id: string; code: string; name: string; description?: string; isDefault?: boolean }>>> {
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'API base URL not configured' } }
    const token = this.config.apiToken || ''
    if (!token) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'No API token configured' } }

    const path = `/account/v03_09/roaming_profiles/${token}`
    console.log(`[PROVIDER_ROAMING_REQUEST] providerCode=CHOICE endpoint=/account/v03_09/roaming_profiles/[REDACTED]`)

    const { text, error } = await fetchText(this.baseUrl(path), { headers: this.headers })
    if (error) {
      console.log(`[PROVIDER_ROAMING_RESULT] providerCode=CHOICE success=false error=${error.code}`)
      return { success: false, error }
    }
    if (!text) return { success: false, error: { code: 'EMPTY', message: 'Empty roaming profiles response' } }

    try {
      const json = JSON.parse(text)
      const list = Array.isArray(json) ? json : (json.data || json.profiles || json.roaming_profiles || [])
      if (!Array.isArray(list)) return { success: false, error: { code: 'INVALID_RESPONSE', message: 'Roaming profiles response is not an array' } }

      const profiles = list.map((p: any) => ({
        id: String(p.id || p.code || p.roaming_profile_id || p.profile_id || ''),
        code: String(p.code || p.id || p.roaming_profile_code || ''),
        name: String(p.name || p.roaming_profile_name || p.profile_name || p.code || ''),
        description: p.description || p.desc || undefined,
        isDefault: typeof p.isDefault === 'boolean' ? p.isDefault : typeof p.default === 'boolean' ? p.default : undefined,
      }))

      console.log(`[PROVIDER_ROAMING_RESULT] providerCode=CHOICE success=true profileCount=${profiles.length}`)
      return { success: true, data: profiles }
    } catch {
      return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse roaming profiles response' } }
    }
  }

  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    const token = this.config.apiToken || ''
    const path = `/account/v03_09/bundle_templates/${token}`
    return this.runDiagnostics('GET', path, { tokenPlacement: 'URL_PATH', authType: 'credentials' })
  }

  async authenticate(credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    const authUrl = credentials.authUrl || this.config.authUrl
    const username = credentials.username
    const password = credentials.password

    console.log(`[CHOICE_AUTH_START] providerId=${this.providerId} usernamePresent=${!!username} passwordPresent=${!!password}`)

    if (!authUrl || !username || !password) {
      console.log(`[CHOICE_AUTH_START] Missing: authUrl=${!!authUrl} username=${!!username} password=${!!password} — falling back`)
      return super.authenticate(credentials)
    }

    console.log(`[CHOICE_AUTH_URL] resolvedUrl=${authUrl}`)
    console.log(`[CHOICE_AUTH_REQUEST] method=POST bodyFields=request.un,request.pw,request.command`)
    console.log(`[CHOICE_AUTH_REQUEST] target=${authUrl}`)

    // Try JSON auth first (Choice/VirtuoLink style)
    const jsonResult = await this.jsonAuthenticate(authUrl, username, password, credentials.environment)
    if (jsonResult.success) return jsonResult

    // If JSON auth failed with a non-network error (bad credentials, wrong format), don't retry SOAP
    if (jsonResult.error && jsonResult.error.code !== 'AUTH_NETWORK_ERROR' && jsonResult.error.code !== 'TIMEOUT' && jsonResult.error.code !== 'NETWORK_ERROR') {
      return jsonResult
    }

    // Fall back to SOAP XML auth (iBASIS/Choice legacy style)
    return this.soapAuthenticate(authUrl, username, password, credentials.environment)
  }

  private async jsonAuthenticate(authUrl: string, username: string, password: string, _environment?: string): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    try {
      const res = await fetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: { un: username, pw: password, command: 'accounts_getaccounts' },
        }),
      })

      const status = res.status
      const contentType = res.headers.get('content-type') || ''
      const text = await res.text()

      // If response is not JSON, can't handle with this method
      if (!contentType.includes('json') && !text.trim().startsWith('{')) {
        return { success: false, error: { code: 'NOT_JSON', message: 'Response is not JSON, falling back to SOAP' } }
      }

      let json: any
      try { json = JSON.parse(text) } catch {
        return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse auth response as JSON' } }
      }

      // Navigate response.response.data or response.data or data
      const resp = json.response || json
      if (resp.status !== undefined && resp.status !== 0) {
        const msg = resp.message || resp.error || `Auth refused (status ${resp.status})`
        return { success: false, error: { code: 'AUTH_FAILED', message: msg } }
      }

      const rawData = resp.data || json.data || json
      const accountsList = Array.isArray(rawData) ? rawData : (Array.isArray(json.data) ? json.data : null)

      if (!accountsList || accountsList.length === 0) {
        return { success: false, error: { code: 'AUTH_FAILED', message: 'No accounts returned' } }
      }

      const accounts: AuthAccount[] = accountsList.map((a: any) => ({
        account: String(a.account || a.id || ''),
        accountName: a.accountName || a.name || a.account_name || '',
        token: a.token || a.api_token || a.apiToken || '',
        uaid: a.uaid || a.UAID || '',
        userId: a.userId || a.user_id || a.UserId || '',
      })).filter((a: AuthAccount) => a.account || a.token)

      if (accounts.length === 0) {
        return { success: false, error: { code: 'AUTH_FAILED', message: 'No accounts with valid tokens found' } }
      }

      const diag = {
        authMode: 'JSON_USERNAME_PASSWORD',
        statusCode: status,
        contentType,
        topLevelKeys: Object.keys(json),
        accountCount: accounts.length,
        accountNames: accounts.map((a: AuthAccount) => a.accountName),
        maskedTokens: accounts.map((a: AuthAccount) => maskToken(a.token)),
      }

      console.log(`[CHOICE_AUTH_RESPONSE] httpStatus=${status} choiceStatus=${resp.status} accountCount=${accounts.length} responseKeys=${Object.keys(json).join(',')}`)
      console.log(`[CHOICE_AUTH_RESULT] success=true selectedAccountId=${accounts[0].account} selectedAccountName=${accounts[0].accountName}`)

      return {
        success: true,
        data: { token: accounts[0].token, accountInfo: { accounts, account: accounts[0], authDiagnostics: diag } },
      }
    } catch (e: any) {
      return { success: false, error: { code: 'AUTH_NETWORK_ERROR', message: `JSON auth failed: ${e.message}` } }
    }
  }

  private async soapAuthenticate(authUrl: string, username: string, password: string, _environment?: string): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
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
      const status = res.status
      const contentType = res.headers.get('content-type') || ''
      const xml = await res.text()

      const accounts = this.parseSoapAccounts(xml)
      const diag = {
        authMode: 'SOAP_USERNAME_PASSWORD',
        statusCode: status,
        contentType,
        accountCount: accounts.length,
        accountNames: accounts.map((a: AuthAccount) => a.accountName),
        maskedTokens: accounts.map((a: AuthAccount) => maskToken(a.token)),
      }

      if (accounts.length === 0) {
        return { success: false, error: { code: 'AUTH_FAILED', message: 'No accounts returned', details: diag } }
      }

      return {
        success: true,
        data: { token: accounts[0].token, accountInfo: { accounts, account: accounts[0], authDiagnostics: diag } },
      }
    } catch (e: any) {
      return { success: false, error: { code: 'AUTH_NETWORK_ERROR', message: `SOAP auth failed: ${e.message}` } }
    }
  }

  private parseSoapAccounts(xml: string): AuthAccount[] {
    const accounts: AuthAccount[] = []
    const blocks = xml.split(/<Account[ >]/i).slice(1)
    for (const block of blocks) {
      const end = block.indexOf('</Account>')
      const content = end > -1 ? block.substring(0, end) : block
      const extract = (tag: string): string => {
        const m = content.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'))
        return m ? m[1].trim() : ''
      }
      const account = extract('Account')
      const accountName = extract('AccountName') || extract('Name')
      const token = extract('Token') || extract('token')
      const uaid = extract('UAID') || extract('Uaid')
      const userId = extract('UserId') || extract('UserID')
      if (account || token) accounts.push({ account, accountName, uaid, userId, token })
    }
    return accounts
  }

  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const token = this.config.apiToken || ''
    const path = `/account/v03_09/bundle_templates/${token}`
    const { text, error } = await fetchText(this.baseUrl(path), { headers: this.headers })
    if (error) return { success: false, error }
    if (!text) return { success: false, error: { code: 'EMPTY', message: 'Empty response' } }
    try {
      const json = JSON.parse(text)
      const items = this.extractList(json, 'bundle_template_list')
      if (!Array.isArray(items)) return { success: false, error: { code: 'INVALID_RESPONSE', message: 'bundle_template_list not found in response' } }
      const plans: ConnectorPlan[] = items.map((item: any) => this.mapTemplatePlan(item))
      return { success: true, data: plans }
    } catch {
      return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse response JSON' } }
    }
  }

  async validatePurchase(_params: { planId: string; quantity: number; subscriber: { email: string } }): Promise<{ valid: boolean; reason?: string }> {
    if (!this.config.apiBaseUrl) {
      return { valid: false, reason: 'API base URL not configured' }
    }
    if (!this.config.apiToken) {
      return { valid: false, reason: 'API token not configured' }
    }
    const payloadType = this.fieldMappings.activationPayloadType
    if (!payloadType) {
      return { valid: false, reason: `Choice activation payload type is not configured.` }
    }
    // Resolve effective userId — legacy placeholders like 'onesim' are rejected.
    const effectiveUserId = this.resolveEffectiveChoiceUserId()
    if (!effectiveUserId) {
      return { valid: false, reason: `Choice user_id could not be resolved from the authenticated account. Re-authenticate or select a Choice account.` }
    }
    return { valid: true }
  }

  async activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    const token = this.config.apiToken || ''
    const path = `/template/v03_09/add_bundle_using_template_from_pool/${token}`
    const maskedPath = path.replace(token, token.slice(0, 4) + '••••')
    const payloadType = this.fieldMappings.activationPayloadType

    let body: Record<string, any>
    let maskedBody: Record<string, any>

    if (payloadType === 'CHOICE_ADD_BUNDLE_FROM_POOL') {
      // Never send a legacy/placeholder user_id (e.g. 'onesim') upstream — fail
      // BEFORE the provider mutation when no real account id can be resolved.
      const effectiveUserId = this.resolveEffectiveChoiceUserId()
      if (!effectiveUserId) {
        return { success: false, error: { code: 'CHOICE_USER_ID_MISSING', message: 'Choice user_id could not be resolved from the authenticated account' } }
      }
      body = {
        sku: params.planId,
        user_id: effectiveUserId,
        eu_email_address: params.subscriber.email || undefined,
      }

      const roamingProfileId = this.fieldMappings.roamingProfileId
      if (roamingProfileId && typeof roamingProfileId === 'string' && roamingProfileId.trim()) {
        body.imsi1_roaming_profile = roamingProfileId.trim()
      }

      maskedBody = { ...body, sku: body.sku }
      if (body.imsi1_roaming_profile) maskedBody.imsi1_roaming_profile = body.imsi1_roaming_profile
      console.log(`[UrlTokenConnector] Choice activation:\n  URL: ${this.baseUrl(maskedPath)}\n  Body: ${JSON.stringify(maskedBody)}`)
    } else {
      body = { template_id: params.planId, quantity: params.quantity, email: params.subscriber.email }
      maskedBody = { ...body, template_id: body.template_id }
      console.log(`[UrlTokenConnector] Generic activation:\n  URL: ${this.baseUrl(maskedPath)}\n  Body: ${JSON.stringify(maskedBody)}`)
    }

    // Remove undefined values
    Object.keys(body).forEach(k => { if (body[k] === undefined) delete body[k] })

    const { text, error, status } = await fetchText(this.baseUrl(path), {
      method: 'POST', headers: this.headers, body: JSON.stringify(body),
    })

    if (error) {
      console.log(`[UrlTokenConnector] activateESIM FAILED: status=${status} error=${error.code} msg=${error.message}`)
      return { success: false, error }
    }
    if (!text) {
      console.log(`[UrlTokenConnector] activateESIM FAILED: empty response`)
      return { success: false, error: { code: 'EMPTY', message: 'Empty activation response' } }
    }

    console.log(`[UrlTokenConnector] activateESIM response (${text.length} chars): ${text.substring(0, 500)}`)

    try {
      const json = JSON.parse(text)

      // Check for explicit provider failure
      if (json.success === false || json.status === 'failed' || json.status === 'error') {
        const errMsg = json.message || json.error || json.error_message || 'Provider rejected activation'
        console.log(`[UrlTokenConnector] Provider returned failure: ${errMsg}`)
        return { success: false, error: { code: 'PROVIDER_FAILED', message: errMsg } }
      }

      const topKeys = Object.keys(json)

      if (payloadType === 'CHOICE_ADD_BUNDLE_FROM_POOL' && Array.isArray(json.data?.imsis)) {
        // Choice-specific response: data.imsis[].iccid, .imsi, .activation_code, .qr_code_link
        const imsis = json.data.imsis as Array<any>
        const iccids = imsis.map((s: any) => s.iccid).filter(Boolean)
        const imsis_arr: string[] = imsis.map((s: any) => s.imsi != null ? String(s.imsi) : null).filter((v): v is string => v !== null)
        const activationCodes = imsis.map((s: any) => s.activation_code).filter(Boolean)
        const qrCodeUrl = imsis[0]?.qr_code_link || ''

        if (iccids.length === 0) {
          console.log(`[UrlTokenConnector] WARNING: Choice response has no ICCIDs in data.imsis. Top keys: ${topKeys.join(', ')}`)
          return { success: false, error: { code: 'NO_ICCIDS', message: 'Provider returned 0 ICCIDs' } }
        }

        return {
          success: true,
          data: {
            activationId: json.transaction_id || json.order_id || json.id || '',
            iccids,
            imsis: imsis_arr,
            activationCodes,
            qrCodeUrl: qrCodeUrl || undefined,
            status: json.status || 'ACTIVATED',
          },
        }
      }

      // Generic response extraction
      const iccids: string[] = (() => {
        if (Array.isArray(json.iccids) && json.iccids.length > 0) return json.iccids
        if (json.iccid) return [json.iccid]
        if (Array.isArray(json.iccid_list) && json.iccid_list.length > 0) return json.iccid_list
        if (json.data?.iccids) return json.data.iccids
        if (json.data?.iccid) return [json.data.iccid]
        if (json.response?.iccids) return json.response.iccids
        if (json.response?.iccid) return [json.response.iccid]
        if (json.sim?.iccid) return [json.sim.iccid]
        if (Array.isArray(json.sims)) return json.sims.map((s: any) => s.iccid).filter(Boolean)
        if (json.esim?.iccid) return [json.esim.iccid]
        if (json.order?.iccids) return json.order.iccids
        if (json.bundle?.iccid) return [json.bundle.iccid]
        console.log(`[UrlTokenConnector] WARNING: No ICCID field found in response. Top keys: ${topKeys.join(', ')}`)
        return []
      })()

      return {
        success: true,
        data: {
          activationId: json.transaction_id || json.order_id || json.id || json.response?.transaction_id || '',
          iccids,
          qrCodeUrl: json.qr_code_url || json.qrCodeUrl || json.data?.qr_code_url || '',
          status: json.status || 'ACTIVATED',
        },
      }
    } catch (e: any) {
      console.log(`[UrlTokenConnector] activateESIM PARSE FAILED: ${e.message}`)
      return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse activation response' } }
    }
  }

  async getStatus(identifier: string | StatusLookupIdentifier): Promise<ConnectorResult<StatusResult>> {
    if (identifier && typeof identifier === 'object') {
      return this.getChoicePackageDetailStatus(identifier)
    }
    return this.getLegacyUrlTokenStatus(String(identifier || ''))
  }

  /**
   * Choice status lookup is OBJECT-only (package_detail by ICCID/IMSI/
   * imsi_version). Never send a string here — a raw string would hit the legacy
   * template route. Returns the structured identifier when any Choice identifier
   * exists, otherwise null so the caller skips the provider call safely.
   */
  resolveStatusLookup(esim: StatusLookupEsim): string | StatusLookupIdentifier | null {
    if (esim.iccid || esim.imsi || esim.imsiVersion != null) {
      return {
        ...(esim.iccid ? { iccid: esim.iccid } : {}),
        ...(esim.imsi ? { imsi: esim.imsi } : {}),
        ...(esim.imsiVersion != null ? { imsiVersion: esim.imsiVersion } : {}),
        ...(esim.status ? { currentStatus: esim.status } : {}),
      }
    }
    return null
  }

  /**
   * Shared Choice package_detail fetch used by both status and usage lookups:
   * GET {baseUrl}/account/v03_09/package_detail/{token}?iccid=...|imsi=...|imsi_version=...
   * Token is path-based and URL-encoded; never logged in full. Error codes are
   * parameterized so status and usage surface their own (CHOICE_STATUS_* / CHOICE_USAGE_*).
   */
  private async fetchChoicePackageDetail(
    lookup: StatusLookupIdentifier,
    mode: 'STATUS' | 'USAGE',
  ): Promise<{ ok: true; json: any; pkg: any; durationMs: number } | { ok: false; error: { code: string; message: string } }> {
    if (!this.config.apiBaseUrl) return { ok: false, error: { code: 'NOT_CONFIGURED', message: 'API base URL not configured' } }
    const token = this.config.apiToken || ''
    if (!token) return { ok: false, error: { code: 'CHOICE_CREDENTIALS_MISSING', message: 'No Choice API token configured' } }

    const resolved = resolveChoiceStatusIdentifier(lookup)
    if (!resolved) {
      return { ok: false, error: { code: `CHOICE_${mode}_IDENTIFIER_MISSING`, message: `No Choice ${mode.toLowerCase()} identifier (ICCID/IMSI/imsi_version) provided` } }
    }

    const path = (this.config.packageDetailPath || '/account/v03_09/package_detail').replace(/\/$/, '')
    const url = `${this.baseUrl(`${path}/${encodeURIComponent(token)}`)}?${resolved.key}=${encodeURIComponent(String(resolved.value))}`
    const host = urlHostname(url)

    console.log(`[CHOICE_PACKAGE_REQUEST] providerCode=CHOICE hostname=${host} endpoint=${path} mode=${mode} identifier=${resolved.key}=[REDACTED]`)

    const start = Date.now()
    const { text, error, status } = await fetchText(url, {
      headers: { Accept: 'application/json' },
      timeoutMs: this.config.timeoutMs,
    })
    const durationMs = Date.now() - start

    if (error) {
      console.log(`[CHOICE_PACKAGE_RESULT] providerCode=CHOICE mode=${mode} success=false error=${error.code} httpStatus=${status ?? 'unknown'} durationMs=${durationMs}`)
      return { ok: false, error }
    }
    if (!text) return { ok: false, error: { code: 'EMPTY', message: `Empty Choice ${mode.toLowerCase()} response` } }

    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      console.log(`[CHOICE_PACKAGE_RESULT] providerCode=CHOICE mode=${mode} success=false error=CHOICE_${mode}_NON_JSON httpStatus=${status ?? 'unknown'} durationMs=${durationMs}`)
      return { ok: false, error: { code: `CHOICE_${mode}_NON_JSON`, message: `Choice ${mode.toLowerCase()} response is not valid JSON` } }
    }

    if (json.success === false) {
      const errmsg = String(json.errmsg || json.error_message || json.message || 'Choice reported a failure').slice(0, 300)
      console.log(`[CHOICE_PACKAGE_RESULT] providerCode=CHOICE mode=${mode} success=false error=CHOICE_${mode}_REJECTED errmsg=${errmsg.slice(0, 120)} httpStatus=${status ?? 'unknown'} durationMs=${durationMs}`)
      return { ok: false, error: { code: `CHOICE_${mode}_REJECTED`, message: errmsg } }
    }

    const pkg = json?.package || json?.data?.package || json?.response?.package
    if (!pkg || typeof pkg !== 'object') {
      return { ok: false, error: { code: `CHOICE_${mode}_PACKAGE_MISSING`, message: `Choice ${mode.toLowerCase()} response is missing the package object` } }
    }

    return { ok: true, json, pkg, durationMs }
  }

  /**
   * Choice package_detail status lookup (official source, shared with usage).
   */
  private async getChoicePackageDetailStatus(lookup: StatusLookupIdentifier): Promise<ConnectorResult<StatusResult>> {
    const fetched = await this.fetchChoicePackageDetail(lookup, 'STATUS')
    if (!fetched.ok) return { success: false, error: fetched.error }
    const { json, pkg, durationMs } = fetched

    const rawStatus = typeof pkg.status === 'string' ? pkg.status : ''
    const packageStatus = typeof pkg.package_status === 'string' ? pkg.package_status : ''
    const normalized = normalizeChoiceStatus(rawStatus, packageStatus, lookup.currentStatus)

    const rateGroups = Array.isArray(pkg.rate_groups) ? pkg.rate_groups : []
    const firstExpiry = rateGroups.length > 0 ? String(rateGroups[0]?.rate_group_expire || '') : ''

    console.log(`[CHOICE_STATUS_RESULT] providerCode=CHOICE success=true status=${normalized.status} raw=${normalized.providerStatus || '(empty)'} durationMs=${durationMs}`)

    return {
      success: true,
      data: {
        status: normalized.status,
        rawStatus: normalized.providerStatus,
        iccid: pkg.iccid != null ? String(pkg.iccid) : undefined,
        iccids: pkg.iccid != null ? [String(pkg.iccid)] : undefined,
        imsiVersion: pkg.imsi_version != null ? pkg.imsi_version : undefined,
        packageName: pkg.package_name || undefined,
        rateGroupStarttime: pkg.rate_group_starttime || undefined,
        rateGroupExpire: pkg.rate_group_expire || undefined,
        expiresAt: pkg.rate_group_expire || firstExpiry || undefined,
        rawMetadata: sanitizeChoiceStatusMetadata(json),
      },
    }
  }

  /**
   * Choice usage lookup from the same package_detail source as status.
   * Object identifiers route here (ICCID → IMSI → imsi_version); a raw string is
   * rejected before any HTTP call so a local OneSIM id is never sent upstream.
   */
  async getUsage(identifier: string | StatusLookupIdentifier): Promise<ConnectorResult<UsageResult>> {
    if (identifier && typeof identifier === 'object') {
      return this.getChoicePackageDetailUsage(identifier)
    }
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Usage requires a Choice identifier (ICCID/IMSI/imsi_version); local ids are never sent' } }
  }

  private async getChoicePackageDetailUsage(lookup: StatusLookupIdentifier): Promise<ConnectorResult<UsageResult>> {
    const fetched = await this.fetchChoicePackageDetail(lookup, 'USAGE')
    if (!fetched.ok) return { success: false, error: fetched.error }
    const { json, pkg, durationMs } = fetched

    const outcome = normalizeChoiceUsage(pkg, lookup.currentStatus, json)
    if (!outcome.ok) {
      console.log(`[CHOICE_USAGE_RESULT] providerCode=CHOICE success=false error=${outcome.error.code} durationMs=${durationMs}`)
      return { success: false, error: outcome.error }
    }

    console.log(`[CHOICE_USAGE_RESULT] providerCode=CHOICE success=true dataUsedMB=${outcome.usage.dataUsedMB} dataTotalMB=${outcome.usage.dataTotalMB} remainingMB=${outcome.usage.dataRemainingMB} percentage=${outcome.usage.percentageUsed} durationMs=${durationMs}`)

    return {
      success: true,
      data: {
        iccid: pkg.iccid != null ? String(pkg.iccid) : '',
        dataUsedMB: outcome.usage.dataUsedMB,
        dataTotalMB: outcome.usage.dataTotalMB,
        dataRemainingMB: outcome.usage.dataRemainingMB,
        percentageUsed: outcome.usage.percentageUsed,
        ...(outcome.usage.expiresAt ? { expiresAt: outcome.usage.expiresAt } : {}),
        status: outcome.usage.status,
        rawMetadata: outcome.usage.rawMetadata,
      },
    }
  }

  /** Legacy path kept for non-Choice URL_TOKEN providers that pass a string identifier. */
  private async getLegacyUrlTokenStatus(subscriptionId: string): Promise<ConnectorResult<StatusResult>> {
    const token = this.config.apiToken || ''
    const path = `/template/v03_09/package_detail/${token}/${subscriptionId}`
    const { text, error } = await fetchText(this.baseUrl(path), { headers: this.headers })
    if (error) return { success: false, error }
    if (!text) return { success: false, error: { code: 'EMPTY', message: 'Empty status response' } }
    try {
      const json = JSON.parse(text)
      return {
        success: true,
        data: {
          status: json.status || json.package_status || 'UNKNOWN',
          iccid: json.iccid || '',
          iccids: json.iccid ? [json.iccid] : [],
        },
      }
    } catch {
      return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse status response' } }
    }
  }

  /**
   * Suspend a Choice eSIM via `POST {baseUrl}/account/v03_09/suspend_imsi/{token}`
   * with exactly one identifier in the JSON body (iccid / imsi / imsi_version).
   * Object identifiers use the shared Choice resolution; a raw string keeps the
   * legacy template route for non-Choice URL_TOKEN providers.
   */
  async suspendESIM(subscriptionId: string | StatusLookupIdentifier): Promise<ConnectorResult<EsimLifecycleResult>> {
    if (subscriptionId && typeof subscriptionId === 'object') {
      return this.performChoiceLifecycleAction('SUSPEND', subscriptionId)
    }
    return this.performLegacyUrlTokenLifecycle('SUSPEND', String(subscriptionId || ''))
  }

  /**
   * Resume a Choice eSIM via `POST {baseUrl}/account/v03_09/resume_imsi/{token}`
   * with exactly one identifier in the JSON body (iccid / imsi / imsi_version).
   * Object identifiers use the shared Choice resolution; a raw string keeps the
   * legacy template route for non-Choice URL_TOKEN providers.
   */
  async resumeESIM(subscriptionId: string | StatusLookupIdentifier): Promise<ConnectorResult<EsimLifecycleResult>> {
    if (subscriptionId && typeof subscriptionId === 'object') {
      return this.performChoiceLifecycleAction('RESUME', subscriptionId)
    }
    return this.performLegacyUrlTokenLifecycle('RESUME', String(subscriptionId || ''))
  }

  /**
   * Choice suspend/resume against the account lifecycle endpoints. Token is
   * path-based and URL-encoded; never logged in full. Error codes are
   * parameterized so suspend and resume surface their own
   * (CHOICE_SUSPEND_* / CHOICE_RESUME_*).
   */
  private async performChoiceLifecycleAction(
    action: 'SUSPEND' | 'RESUME',
    lookup: StatusLookupIdentifier,
  ): Promise<ConnectorResult<EsimLifecycleResult>> {
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'API base URL not configured' } }
    const token = this.config.apiToken || ''
    if (!token) return { success: false, error: { code: 'CHOICE_CREDENTIALS_MISSING', message: 'No Choice API token configured' } }

    const resolved = resolveChoiceStatusIdentifier(lookup)
    if (!resolved) {
      return {
        success: false,
        error: { code: `CHOICE_${action}_IDENTIFIER_MISSING`, message: `No Choice ${action.toLowerCase()} identifier (ICCID/IMSI/imsi_version) provided` },
      }
    }

    const path = (action === 'SUSPEND'
      ? (this.config.suspendPath || '/account/v03_09/suspend_imsi')
      : (this.config.resumePath || '/account/v03_09/resume_imsi')).replace(/\/$/, '')
    const url = `${this.baseUrl(`${path}/${encodeURIComponent(token)}`)}`
    const host = urlHostname(url)

    console.log(`[CHOICE_LIFECYCLE_REQUEST] providerCode=CHOICE action=${action} hostname=${host} endpoint=${path} identifier=${resolved.key} identifierPresent=true`)

    const start = Date.now()
    const { text, error, status } = await fetchText(url, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: JSON.stringify({ [resolved.key]: resolved.value }),
      timeoutMs: this.config.timeoutMs,
    })
    const durationMs = Date.now() - start

    if (error) {
      let code = error.code
      let message = error.message
      if (status === 401 || status === 403) {
        code = 'CHOICE_AUTH_UNAUTHORIZED'
        message = 'Choice lifecycle endpoint returned unauthorized'
      }
      if (status === 404) {
        code = `CHOICE_${action}_ENDPOINT_NOT_FOUND`
        message = `Choice ${action.toLowerCase()} endpoint not found (404)`
      }
      console.log(`[CHOICE_LIFECYCLE_RESULT] providerCode=CHOICE action=${action} success=false error=${code} httpStatus=${status ?? 'unknown'} durationMs=${durationMs}`)
      return { success: false, error: { code, message } }
    }
    if (!text) return { success: false, error: { code: 'EMPTY', message: `Empty Choice ${action.toLowerCase()} response` } }

    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      console.log(`[CHOICE_LIFECYCLE_RESULT] providerCode=CHOICE action=${action} success=false error=CHOICE_${action}_NON_JSON httpStatus=${status ?? 'unknown'} durationMs=${durationMs}`)
      return { success: false, error: { code: `CHOICE_${action}_NON_JSON`, message: `Choice ${action.toLowerCase()} response is not valid JSON` } }
    }

    const errmsg = String(json.errmsg || json.message || json.error_message || '')
    if (json.success === false) {
      const message = errmsg || `Choice ${action.toLowerCase()} was rejected`
      console.log(`[CHOICE_LIFECYCLE_RESULT] providerCode=CHOICE action=${action} success=false error=CHOICE_${action}_REJECTED messagePresent=${!!errmsg} httpStatus=${status ?? 'unknown'} durationMs=${durationMs}`)
      return { success: false, error: { code: `CHOICE_${action}_REJECTED`, message } }
    }

    console.log(`[CHOICE_LIFECYCLE_RESULT] providerCode=CHOICE action=${action} success=true messagePresent=${!!errmsg} httpStatus=${status ?? 'unknown'} durationMs=${durationMs}`)

    return {
      success: true,
      data: {
        status: action === 'SUSPEND' ? 'SUSPENDED' : 'ACTIVE',
        providerStatus: action === 'SUSPEND' ? 'suspended' : 'active',
        ...(errmsg ? { message: errmsg } : {}),
        rawMetadata: sanitizeChoiceStatusMetadata(json),
      },
    }
  }

  /** Legacy template-route suspend/resume kept for non-Choice URL_TOKEN providers that pass a string identifier. */
  private async performLegacyUrlTokenLifecycle(action: 'SUSPEND' | 'RESUME', subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    const token = this.config.apiToken || ''
    const path = `/template/v03_09/${action.toLowerCase()}/${token}/${subscriptionId}`
    const { error } = await fetchText(this.baseUrl(path), { method: 'POST', headers: this.headers })
    if (error) return { success: false, error }
    return { success: true, data: { status: action === 'SUSPEND' ? 'SUSPENDED' : 'ACTIVE', providerStatus: action === 'SUSPEND' ? 'suspended' : 'active' } }
  }

  async topUpESIM(params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> {
    const token = this.config.apiToken || ''
    const topUpPath = this.fieldMappings.topUpPath || `/account/v03_09/update_imsi/${token}`
    const maskedPath = topUpPath.replace(token, token.slice(0, 4) + '••••')

    const payloadType = this.fieldMappings.topUpPayloadType

    let body: Record<string, any>

    if (payloadType === 'CHOICE_UPDATE_IMSI') {
      // Never send a legacy/placeholder user_id (e.g. 'onesim') upstream.
      const userId = this.resolveEffectiveChoiceUserId()
      if (!userId) {
        return { success: false, error: { code: 'CHOICE_USER_ID_MISSING', message: 'Choice user_id could not be resolved from the authenticated account' } }
      }
      body = {
        user_id: userId,
        iccid: params.iccid,
        package_name: params.sku || params.packageName || params.planId,
        top_up_occurrences: this.fieldMappings.topUpOccurrences || 1,
        top_up_allow_days: this.fieldMappings.topUpAllowDays || 30,
        top_up_quantity: params.quantity || 1,
      }
    } else {
      body = {
        iccid: params.iccid,
        plan_id: params.planId,
        quantity: params.quantity,
        email: params.subscriber?.email,
      }
    }

    // Remove undefined values
    Object.keys(body).forEach(k => { if (body[k] === undefined) delete body[k] })

    console.log(`[UrlTokenConnector] topUpESIM:\n  URL: ${this.baseUrl(maskedPath)}\n  Body: ${JSON.stringify(body)}`)

    const url = topUpPath.startsWith('http') ? topUpPath : this.baseUrl(topUpPath)
    const { text, error, status } = await fetchText(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    })

    if (error) {
      console.log(`[UrlTokenConnector] topUpESIM FAILED: status=${status} error=${error.code} msg=${error.message}`)
      return { success: false, error }
    }
    if (!text) {
      return { success: false, error: { code: 'EMPTY', message: 'Empty top-up response' } }
    }

    console.log(`[UrlTokenConnector] topUpESIM response (${text.length} chars): ${text.substring(0, 500)}`)

    try {
      const json = JSON.parse(text)

      if (json.success === false || json.status === 'failed' || json.status === 'error') {
        const errMsg = json.message || json.error || json.error_message || 'Provider rejected top-up'
        return { success: false, error: { code: 'PROVIDER_FAILED', message: errMsg } }
      }

      // Extract data added from package info or response
      let dataAddedMB: number | undefined
      let validityDaysAdded: number | undefined

      if (params.sku) {
        // If we have a top-up package, use its data from field mappings
        dataAddedMB = this.fieldMappings.topUpDataMB || undefined
        validityDaysAdded = this.fieldMappings.topUpValidityDays || undefined
      }

      return {
        success: true,
        data: {
          providerReference: json.transaction_id || json.order_id || json.id || json.reference || '',
          dataAddedMB,
          validityDaysAdded,
          status: json.status || 'COMPLETED',
          newExpiry: json.expiry_date || json.expires_at || undefined,
          newDataTotalMB: json.data_total_mb || json.dataTotalMB || undefined,
          newDataRemainingMB: json.data_remaining_mb || json.dataRemainingMB || undefined,
        },
      }
    } catch (e: any) {
      return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse top-up response' } }
    }
  }

  private mapTemplatePlan(item: any): ConnectorPlan {
    const name = item.bundle_name || item.bundleName || item.name || ''
    const allowance = parseFloat(item.rate_group_allowance ?? 0)
    const unit = (item.rate_group_allow_qtyp || 'GB').toUpperCase()
    const dataGB = unit === 'GB' ? allowance : unit === 'MB' ? Math.round(allowance / 1024) : allowance
    const days = parseInt(item.rate_group_allow_days ?? 30)
    const price = parseFloat(item.price_usd ?? item.priceUSD ?? 0)
    const id = item.bundle_template_id || item.id || ''
    const version = item.template_version || item.templateVersion || ''
    return {
      id: String(id), name: String(name),
      data_gb: Math.max(1, dataGB || 1), validity_days: Math.max(1, days || 30),
      price_usd: price, currency: 'USD',
      sku: String(id), templateVersion: String(version), raw_data: item,
    }
  }

  // ── Additional Choice API endpoints ──

  /** GET /account/v03_09/imsis_from_iccid/{token}?iccid=... */
  async getImsisFromIccid(iccid: string): Promise<ConnectorResult<{ imsis: string[] }>> {
    await this.ensureAuthenticated()
    const token = this.config.apiToken || ''
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const path = `/account/v03_09/imsis_from_iccid/${token}?iccid=${encodeURIComponent(iccid)}`
    const { text, error } = await fetchText(this.baseUrl(path), { headers: this.headers })
    if (error) return { success: false, error }
    try {
      const json = JSON.parse(text || '{}')
      return { success: true, data: { imsis: Array.isArray(json.imsis || json.data) ? (json.imsis || json.data) : [] } }
    } catch { return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse response' } } }
  }

  /** GET /account/v03_09/allocated_imsi_list/{token} — inventory diagnostics */
  async getAllocatedImsiList(): Promise<ConnectorResult<{ items: any[] }>> {
    await this.ensureAuthenticated()
    const token = this.config.apiToken || ''
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const path = `/account/v03_09/allocated_imsi_list/${token}`
    const { text, error } = await fetchText(this.baseUrl(path), { headers: this.headers })
    if (error) return { success: false, error }
    try {
      const json = JSON.parse(text || '{}')
      return { success: true, data: { items: Array.isArray(json) ? json : (json.data || json.allocated_list || []) } }
    } catch { return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse response' } } }
  }

  /** GET /account/v03_09/imsi_version/{token}?imsi=...&iccid=... */
  async getImsiVersion(identifier: { imsi?: string; iccid?: string }): Promise<ConnectorResult<{ imsiVersion: string }>> {
    await this.ensureAuthenticated()
    const token = this.config.apiToken || ''
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const params = new URLSearchParams()
    if (identifier.imsi) params.set('imsi', identifier.imsi)
    if (identifier.iccid) params.set('iccid', identifier.iccid)
    const path = `/account/v03_09/imsi_version/${token}?${params}`
    const { text, error } = await fetchText(this.baseUrl(path), { headers: this.headers })
    if (error) return { success: false, error }
    try {
      const json = JSON.parse(text || '{}')
      return { success: true, data: { imsiVersion: String(json.imsi_version || json.version || json.data?.imsi_version || '') } }
    } catch { return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse response' } } }
  }

  /** GET /account/v03_09/event_logs/{token} — provider event history */
  async getEventLogs(limit = 50): Promise<ConnectorResult<{ events: any[] }>> {
    await this.ensureAuthenticated()
    const token = this.config.apiToken || ''
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const path = `/account/v03_09/event_logs/${token}?limit=${limit}`
    const { text, error } = await fetchText(this.baseUrl(path), { headers: this.headers })
    if (error) return { success: false, error }
    try {
      const json = JSON.parse(text || '{}')
      return { success: true, data: { events: Array.isArray(json.events || json) ? (json.events || json) : [] } }
    } catch { return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse response' } } }
  }

  /** GET /account/v03_09/prepaid_rates_list/{token} — rate intelligence */
  async getPrepaidRatesList(): Promise<ConnectorResult<{ rates: any[] }>> {
    await this.ensureAuthenticated()
    const token = this.config.apiToken || ''
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const path = `/account/v03_09/prepaid_rates_list/${token}`
    const { text, error } = await fetchText(this.baseUrl(path), { headers: this.headers })
    if (error) return { success: false, error }
    try {
      const json = JSON.parse(text || '{}')
      return { success: true, data: { rates: Array.isArray(json.rates || json) ? (json.rates || json) : [] } }
    } catch { return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse response' } } }
  }

  /** POST /account/v03_09/add_imsi/{token} — create/add IMSI bundle */
  async addImsi(params: { sku: string; user_id?: string; [key: string]: any }): Promise<ConnectorResult<any>> {
    await this.ensureAuthenticated()
    const token = this.config.apiToken || ''
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const path = `/account/v03_09/add_imsi/${token}`
    const body = JSON.stringify(params)
    try {
      const { text, error, status } = await fetchText(this.baseUrl(path), { method: 'POST', headers: this.headers, body })
      if (error) return { success: false, error }
      return { success: true, data: JSON.parse(text || '{}') }
    } catch (e: any) {
      return { success: false, error: { code: 'CHOICE_ADD_IMSI_FAILED', message: e.message } }
    }
  }

  /** GET /account/v03_09/imsi_list/{token} — list bundles for account/IMSI */
  async getImsiList(imsi?: string): Promise<ConnectorResult<{ items: any[] }>> {
    await this.ensureAuthenticated()
    const token = this.config.apiToken || ''
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const params = imsi ? `?imsi=${encodeURIComponent(imsi)}` : ''
    const path = `/account/v03_09/imsi_list/${token}${params}`
    try {
      const { text, error } = await fetchText(this.baseUrl(path), { headers: this.headers })
      if (error) return { success: false, error }
      const json = JSON.parse(text || '{}')
      return { success: true, data: { items: Array.isArray(json) ? json : (json.data || json.imsi_list || []) } }
    } catch { return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse response' } } }
  }

  /** POST /account/v03_09/create_bundle_template/{token} — create SKU/bundle template */
  async createBundleTemplate(params: {
    sku: string; bundle_name: string; pool: number | string; user_id?: string
    rate_group_allow_days?: number; rate_group_occurrences?: number; allow_throttle?: boolean
    allow_tethering?: boolean; roaming_profile_id?: string; serving_networks?: string
    rate_groups?: any[]; [key: string]: any
  }): Promise<ConnectorResult<{ sku: string; template_version?: string }>> {
    await this.ensureAuthenticated()
    const token = this.config.apiToken || ''
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const path = `/account/v03_09/create_bundle_template/${token}`
    const body = JSON.stringify(params)
    try {
      const { text, error } = await fetchText(this.baseUrl(path), { method: 'POST', headers: this.headers, body })
      if (error) return { success: false, error }
      const json = JSON.parse(text || '{}')
      return { success: true, data: { sku: params.sku, template_version: json.template_version || json.version || json.data?.template_version } }
    } catch (e: any) {
      return { success: false, error: { code: 'CHOICE_CREATE_BUNDLE_FAILED', message: e.message } }
    }
  }

  /** POST /account/v03_09/update_bundle_template/{token} — update an SKU; creates new version */
  async updateBundleTemplate(params: {
    sku: string; bundle_name?: string; pool?: number | string; user_id?: string
    [key: string]: any
  }): Promise<ConnectorResult<{ sku: string; template_version?: string; previous_version?: string }>> {
    await this.ensureAuthenticated()
    const token = this.config.apiToken || ''
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    let previousVersion = ''
    try {
      const v = await this.getImsiVersion({})
      if (v.success && v.data) previousVersion = v.data.imsiVersion
    } catch {}
    const path = `/account/v03_09/update_bundle_template/${token}`
    const body = JSON.stringify(params)
    try {
      const { text, error } = await fetchText(this.baseUrl(path), { method: 'POST', headers: this.headers, body })
      if (error) return { success: false, error }
      const json = JSON.parse(text || '{}')
      return { success: true, data: { sku: params.sku, template_version: json.template_version || json.version, previous_version: previousVersion } }
    } catch (e: any) {
      return { success: false, error: { code: 'CHOICE_UPDATE_BUNDLE_FAILED', message: e.message } }
    }
  }

  /** POST /template/v03_09/add_bundle_using_template/{token} — non-pool purchase with explicit IMSI/ICCID */
  async addBundleUsingTemplate(params: {
    user_id: string; sku: string; imsi?: string; iccid?: string; template_version?: string
  }): Promise<ConnectorResult<any>> {
    await this.ensureAuthenticated()
    const token = this.config.apiToken || ''
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const path = `/template/v03_09/add_bundle_using_template/${token}`
    const body = JSON.stringify(params)
    try {
      const { text, error } = await fetchText(this.baseUrl(path), { method: 'POST', headers: this.headers, body })
      if (error) return { success: false, error }
      return { success: true, data: JSON.parse(text || '{}') }
    } catch (e: any) {
      return { success: false, error: { code: 'CHOICE_TEMPLATE_PURCHASE_FAILED', message: e.message } }
    }
  }

  /** Override getQRCode — use package_detail endpoint for delayed installation lookup */
  async getQRCode(iccid: string): Promise<ConnectorResult<QRCodeResult>> {
    await this.ensureAuthenticated()
    if (!iccid) return { success: false, error: { code: 'MISSING_ICCID', message: 'No ICCID available' } }
    const { text, error } = await fetchText(this.baseUrl(`/account/v03_09/package_detail/${this.config.apiToken}?iccid=${encodeURIComponent(iccid)}`), { headers: this.headers })
    if (error) return { success: false, error }
    try {
      const json = JSON.parse(text || '{}')
      const pkg = json.package || json.data?.package || json
      const qr = pkg?.qr_code_link || pkg?.qr_code_url || pkg?.qrCodeUrl || ''
      const code = pkg?.activation_code || pkg?.activationCode || ''
      const smdp = pkg?.smdp_address || pkg?.smdp || pkg?.smdpAddress || ''
      const matching = pkg?.matching_id || pkg?.matchingId || ''
      // Success when ANY usable install field is present — an activation code
      // (often an LPA string) alone is enough to install.
      if (qr || code || smdp || matching) {
        return {
          success: true,
          data: {
            ...(qr ? { qrCodeUrl: qr } : {}),
            ...(code ? { activationCode: code } : {}),
            ...(smdp ? { smdpAddress: smdp } : {}),
            ...(matching ? { matchingId: matching } : {}),
          },
        }
      }
      return { success: false, error: { code: 'NO_QR_CODE', message: 'No QR code found in package detail' } }
    } catch { return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse response' } } }
  }
}
