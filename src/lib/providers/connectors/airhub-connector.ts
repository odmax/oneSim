import crypto from 'crypto'
import { encryptToken, decryptToken } from '@/lib/encryption'
import { prisma } from '@/lib/prisma'
import { recordHealthEvent } from '@/lib/services/providers/health-monitor'
import { normalizeTravelDateRequirement, isValidTravelDate, withTravelDateMarker } from '@/lib/providers/travel-date-utils'
import type { IProviderConnector, ConnectorResult, ConnectorPlan, DiagnosticInfo, ActivateESIMParams, ActivateESIMResult, UsageResult, StatusResult, RateResult, TopUpESIMParams, TopUpESIMResult, TokenState, EsimLifecycleResult, QRCodeResult, StatusLookupEsim, ConnectorCapabilities, ConnectorAuthProfile, InstallationLookupInput, InstallationLookupResult, ConnectorInstallDataOutput } from './connector-interface'
import { hasUsableInstallData } from '@/lib/esim/installation-data'
import { describeDiagnosticValue, parseMonetaryValue } from '@/lib/providers/balance/monetary'

export { describeDiagnosticValue } from '@/lib/providers/balance/monetary'

/**
 * Short, non-reversible fingerprint so two call sites can be compared without
 * leaking token characters: SHA-256, first 10 hex chars, 'none' when absent.
 */
export function tokenFingerprint(token: string | null | undefined): string {
  if (!token) return 'none'
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 10)
}

/** Guarded balance diagnostics: OFF unless AIRHUB_BALANCE_DIAGNOSTICS_ENABLED=true. */
function balanceDiagnosticsEnabled(): boolean {
  return process.env.AIRHUB_BALANCE_DIAGNOSTICS_ENABLED === 'true'
}

/** Process-scoped tag so one wallet refresh and one purchase share a correlation. */
const airhubDiagCorrelationId = `airhub-diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Keys whose values are masked case-insensitively in diagnostics (structure is kept). */
const DIAG_SENSITIVE_KEY_TERMS = [
  'token', 'authorization', 'password', 'secret', 'apikey', 'x-api-key', 'keyhash',
  'activationcode', 'lpa', 'iccid', 'email', 'phone', 'mobile', 'msisdn',
  'traceid', 'cookie', 'header',
]

function sanitizeDiagnostic(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map((v) => (v && typeof v === 'object' ? sanitizeDiagnostic(v) : v))
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    const sensitive = DIAG_SENSITIVE_KEY_TERMS.some((term) => k.toLowerCase().includes(term))
    if (sensitive) { out[k] = '[REDACTED]'; continue }
    out[k] = v && typeof v === 'object' ? sanitizeDiagnostic(v) : v
  }
  return out
}

const BALANCE_FIELD_ALIASES: Record<string, string> = {
  balance: 'balance',
  currentbalance: 'balance',
  walletbalance: 'balance',
  wallet: 'wallet',
  availablebalance: 'availableBalance',
  available: 'availableBalance',
  accountid: 'accountId',
  account: 'accountId',
  customerid: 'accountId',
  partnercode: 'partnerCode',
}

/** Collects only balance/wallet/availableBalance/accountId/partnerCode at any depth. */
function probeBalanceFields(data: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      const label = BALANCE_FIELD_ALIASES[k.toLowerCase()]
      if (label && !(label in out)) out[label] = v
      walk(v)
    }
  }
  walk(data)
  return out
}

function safeDiagValue(v: unknown): string {
  if (v === null || v === undefined) return 'undefined'
  return String(v)
}

/** Mask a provider identifier (ICCID/simID) for logs: keep only the first and last 4 chars. */
function maskIdentifier(v: unknown): string {
  const s = String(v ?? '')
  if (s.length <= 8) return '[REDACTED]'
  return `${s.slice(0, 4)}...${s.slice(-4)}`
}

/** The single structured diagnostic entry per call site; emits nothing when disabled. */
function logBalanceDiagnostics(
  scope: 'purchase' | 'wallet',
  ctx: { httpStatus: number; data: any; partnerCode: unknown; token: string | null | undefined },
): void {
  if (!balanceDiagnosticsEnabled()) return
  const sanitized = sanitizeDiagnostic(ctx.data)
  const tag = scope === 'purchase' ? '[AIRHUB_PURCHASE_RESPONSE]' : '[AIRHUB_WALLET_RESPONSE]'
  const base = `${tag} diagCorrelation=${airhubDiagCorrelationId} httpStatus=${ctx.httpStatus} isSuccess=${ctx.data?.isSuccess} message=${String(sanitized?.message ?? '').substring(0, 500)} partnerCode=${safeDiagValue(ctx.partnerCode)} tokenFingerprint=${tokenFingerprint(ctx.token)} topKeys=${Object.keys(ctx.data ?? {}).join(',')}`
  if (scope === 'wallet') {
    console.log(`${base} getwalletType=${describeDiagnosticValue(ctx.data?.getwallet)} balanceFields=${JSON.stringify(probeBalanceFields(ctx.data))} getwallet=${JSON.stringify(sanitized?.getwallet ?? null)} full=${JSON.stringify(sanitized)}`)
  } else {
    console.log(`${base} balanceFields=${JSON.stringify(probeBalanceFields(ctx.data))} full=${JSON.stringify(sanitized)}`)
  }
}

/** Human-readable type of a value for safe, key-only error messages. */
export interface NormalizedWalletBalance {
  success: boolean
  balance: number
  currency: string
  balancePath: string
  getwalletType: string
  reason?: string
}

const GETWALLET_BALANCE_KEYS = [
  'balance', 'Balance', 'wallet', 'walletBalance', 'wallet_balance',
  'availableBalance', 'available_balance', 'available',
  'amount', 'runningBalance', 'running_balance', 'currentBalance', 'current_balance',
  'totalBalance', 'total_balance', 'data',
]

/** Recursively finds a numeric balance inside a value (number, numeric/monetary string, object, array, JSON string). */
function extractWalletBalance(node: unknown, depth = 0): { raw: number; currency: string | null; path: string } | null {
  if (node == null || depth > 4) return null
  const direct = parseMonetaryValue(node)
  if (direct.value !== null) return { raw: direct.value, currency: direct.currency, path: '$' }
  if (typeof node === 'string') {
    const t = node.trim()
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t)
        return extractWalletBalance(parsed, depth + 1)
      } catch { return null }
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    if (node.length === 0) return null
    const first = extractWalletBalance(node[0], depth + 1)
    return first ? { raw: first.raw, currency: first.currency, path: `[0]${first.path === '$' ? '' : '.' + first.path}` } : null
  }
  for (const key of GETWALLET_BALANCE_KEYS) {
    if (!(key in node)) continue
    const inner = extractWalletBalance((node as any)[key], depth + 1)
    if (inner) return { raw: inner.raw, currency: inner.currency, path: inner.path === '$' ? key : `${key}.${inner.path}` }
  }
  return null
}

const PARTNER_CODE_KEYS = ['partnerCode', 'partnercode', 'PartnerCode', 'partner_code']
const PARTNER_CODE_NESTED_KEYS = ['data', 'wallet', 'account', 'accountInfo']

/** Reads the partner code from a wallet row (top-level or a few known nested containers). */
function readPartnerCode(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null
  for (const key of PARTNER_CODE_KEYS) {
    const v = (row as any)[key]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
  }
  for (const key of PARTNER_CODE_NESTED_KEYS) {
    const nested = (row as any)[key]
    if (nested && typeof nested === 'object') {
      const found = readPartnerCode(nested)
      if (found) return found
    }
  }
  return null
}

/** Heuristic for the active/current wallet row when multiple rows are returned. */
function rowLooksActive(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false
  const candidates: unknown[] = []
  for (const key of ['isActive', 'active', 'isactive', 'status', 'Status', 'isCurrent', 'iscurrent', 'current', 'walletType', 'type']) {
    const v = (row as any)[key]
    if (v !== undefined) candidates.push(v)
  }
  return candidates.some((v) => {
    if (v === true) return true
    if (typeof v === 'string') return ['ACTIVE', 'CURRENT', 'ENABLED', 'PRIMARY', 'MAIN'].includes(v.toUpperCase())
    return false
  })
}

/** Reads a currency string from a node, if present. */
function pickCurrency(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null
  for (const key of ['currency', 'currencyCode', 'currency_code', 'Currency']) {
    const v = (node as any)[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return null
}

interface WalletRowCandidate {
  row: any
  index: number
  balance: number
  path: string
  partnerCodeMatch: boolean
  active: boolean
  currency: string | null
}

/** Extracts a numeric balance from one getwallet array entry, keeping its metadata. */
function extractWalletRow(row: any, index: number, partnerCode?: string | number | null): WalletRowCandidate | null {
  const extracted = extractWalletBalance(row)
  if (!extracted) return null
  const rowPartner = readPartnerCode(row)
  return {
    row,
    index,
    balance: extracted.raw,
    path: `[${index}]${extracted.path === '$' ? '' : '.' + extracted.path}`,
    partnerCodeMatch: partnerCode != null && rowPartner != null && rowPartner === String(partnerCode).trim(),
    active: rowLooksActive(row),
    currency: extracted.currency || pickCurrency(row),
  }
}

/** Row selection: partnerCode match → active/current row → first row with a numeric balance. */
function chooseWalletRow(rows: WalletRowCandidate[], partnerCode?: string | number | null): WalletRowCandidate | null {
  if (rows.length === 0) return null
  const partnerMatch = partnerCode != null ? rows.find((r) => r.partnerCodeMatch) : undefined
  if (partnerMatch) return partnerMatch
  const activeRow = rows.find((r) => r.active)
  if (activeRow) return activeRow
  return rows[0]
}

/** Currency priority: matched wallet row (incl. parsed symbol/code) → response → configured default → USD. */
function extractWalletCurrency(data: any, chosen: WalletRowCandidate | null, fallback?: string | null): string {
  return (chosen && chosen.currency) || pickCurrency(data) || pickCurrency(data?.data) || (fallback ? String(fallback) : null) || 'USD'
}

/**
 * Normalizes the AirHub wallet payload into { balance, currency }.
 * getwallet may be a number, numeric string, object, array, or JSON-encoded string.
 * For arrays every row is inspected; rows are never summed — the best row wins.
 * On failure the reason only includes safe response keys and the detected getwallet type.
 */
export function normalizeAirHubWalletBalance(
  data: any,
  opts?: string | null | { fallbackCurrency?: string | null; partnerCode?: string | number | null },
): NormalizedWalletBalance {
  const fallbackCurrency = opts == null ? null : typeof opts === 'string' ? opts : (opts.fallbackCurrency ?? null)
  const partnerCode = opts && typeof opts === 'object' ? (opts.partnerCode ?? null) : null
  const root = data ?? {}
  const getwallet = root.getwallet !== undefined ? root.getwallet : root
  const getwalletType = describeDiagnosticValue(getwallet)

  let chosen: WalletRowCandidate | null = null
  let arrayInput: unknown = getwallet
  if (typeof getwallet === 'string') {
    const t = getwallet.trim()
    if (t.startsWith('[')) {
      try { arrayInput = JSON.parse(t) } catch { arrayInput = getwallet }
    }
  }

  if (Array.isArray(arrayInput)) {
    const rows: WalletRowCandidate[] = []
    for (let i = 0; i < arrayInput.length; i++) {
      const candidate = extractWalletRow(arrayInput[i], i, partnerCode)
      if (candidate) rows.push(candidate)
    }
    chosen = chooseWalletRow(rows, partnerCode)
  } else {
    const extracted = extractWalletBalance(getwallet)
    if (extracted) {
      chosen = {
        row: getwallet,
        index: -1,
        balance: extracted.raw,
        path: extracted.path,
        partnerCodeMatch: false,
        active: false,
        currency: extracted.currency || pickCurrency(getwallet),
      }
    }
  }

  if (chosen) {
    return {
      success: true,
      balance: chosen.balance,
      currency: extractWalletCurrency(root, chosen, fallbackCurrency),
      balancePath: chosen.path,
      getwalletType,
    }
  }

  const safeKeys = Object.keys(root).join(', ')
  const reason = root.getwallet === undefined
    ? `AirHub wallet balance unavailable: response keys (${safeKeys}) contained no numeric balance field`
    : `AirHub wallet balance unavailable: getwallet is ${getwalletType} but no numeric balance field was found`
  return { success: false, balance: 0, currency: fallbackCurrency || 'USD', balancePath: '', getwalletType, reason }
}

function isTokenExpired(expiry: unknown, bufferMs = 5 * 60 * 1000): boolean {
  if (!expiry) return false
  let expiryMs: number
  if (typeof expiry === 'number') {
    expiryMs = expiry * 1000
  } else if (typeof expiry === 'string') {
    const parsed = Date.parse(expiry)
    if (isNaN(parsed)) return false
    expiryMs = parsed
  } else {
    return false
  }
  return Date.now() >= expiryMs - bufferMs
}

/**
 * Normalize a partner code for persistence/use. The login response (top-level
 * `partnerCode`, nested `data.partnerCode`, or an explicit existing config
 * value) may be a number or a numeric string. Returns a trimmed string when a
 * non-empty value exists, else null. NEVER invents a code and never injects a
 * customer-specific literal.
 */
function normalizePartnerCode(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const s = String(value).trim()
  return s.length > 0 ? s : null
}

/** Existing stored token expiry (unix seconds or ISO string), if any. */
function existingTokenExpiry(cfg: Record<string, any> | null | undefined): unknown {
  return cfg?.tokenExpiry ?? null
}

export function urlHostname(baseUrl: string): string {
  try { return new URL(baseUrl).hostname } catch { return baseUrl }
}

/**
 * Guards against sending credentials/tokens to the wrong environment.
 * Only an explicit `config.upstreamEnvironment` counts as intent; a provider
 * label (environment) alone is too ambiguous to block on.
 */
export function environmentMismatchMessage(baseUrl: string, cfg: Record<string, any>): string | null {
  const intended = typeof cfg.upstreamEnvironment === 'string' ? cfg.upstreamEnvironment.toLowerCase() : null
  if (!intended) return null
  const host = urlHostname(baseUrl).toLowerCase()
  const looksStaging = /staging|stg[-.]/.test(host)
  if (intended === 'production' && looksStaging) {
    return `AirHub environment mismatch: config.upstreamEnvironment=production but base URL host "${host}" looks like staging. Refusing to send production credentials to a staging host.`
  }
  if (intended === 'staging' && !looksStaging && host === 'api.airhubapp.com') {
    return `AirHub environment mismatch: config.upstreamEnvironment=staging but base URL host "${host}" is the production host. Refusing to send staging credentials to production.`
  }
  return null
}

export class AirHubConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string = 'AirHub'
  private token: string | null = null

  constructor(providerId: string, token?: string | null) {
    this.providerId = providerId
    this.token = token || null
  }

  private async refreshTokenFromConfig(): Promise<boolean> {
    try {
      const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { config: true } })
      if (!provider) return false
      const cfg = (provider.config as any) || {}
      const username = cfg.username
      const password = cfg.password
      if (!username || !password) return false
      const result = await this.authenticate({ username, password })
      return result.success
    } catch {
      return false
    }
  }

  async getTokenState(): Promise<TokenState> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiToken: true, config: true, environment: true } })
    if (!provider) return { tokenPresent: false, expiryPresent: false, expired: false, expiresSoon: false, tokenExpiry: null }
    const cfg = (provider.config as any) || {}
    const tokenExpiry = cfg.tokenExpiry || null
    const tokenPresent = !!this.token || !!provider.apiToken
    let expired = false
    let expiresSoon = false

    // A token minted under a different environment than the one currently
    // configured must not be reused against the new endpoint.
    const authEnv = cfg.authEnvironmentAtAuth
    const currentEnv = cfg.upstreamEnvironment || provider.environment || 'production'
    const envChanged = typeof authEnv === 'string' && typeof currentEnv === 'string' && authEnv !== currentEnv

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
    if (envChanged) {
      expired = true
      expiresSoon = false
    }
    return { tokenPresent, expiryPresent: !!tokenExpiry, expired, expiresSoon, tokenExpiry }
  }

  async ensureAuthenticated(): Promise<ConnectorResult<void>> {
    const state = await this.getTokenState()
    if (state.tokenPresent && !state.expired && !state.expiresSoon) return { success: true }
    const refreshed = await this.refreshTokenFromConfig()
    if (refreshed) return { success: true }
    if (this.token) return { success: true }
    return { success: false, error: { code: 'NO_TOKEN', message: 'No token. Authenticate first.' } }
  }

  async refreshAuthentication(): Promise<boolean> {
    return this.refreshTokenFromConfig()
  }

  async authenticate(credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const authPath = provider.authUrl || '/api/Authentication/UserLogin'
    const url = `${baseUrl.replace(/\/$/, '')}/${authPath.replace(/^\//, '')}`
    const cfg = (provider.config as any) || {}
    const authEnv = cfg.upstreamEnvironment || provider.environment || 'production'

    console.log(`[AIRHUB_AUTH_START] providerId=${this.providerId} baseHost=${urlHostname(baseUrl)} resolvedUrl=${url} authEnvironment=${authEnv}`)
    console.log(`[AIRHUB_AUTH_REQUEST] method=POST bodyFields=userName,password`)

    // Validate credentials before making HTTP request
    const resolvedUsername = (credentials.username || '').trim()
    const resolvedPassword = (credentials.password || '').trim()
    if (!resolvedUsername || !resolvedPassword) {
      return {
        success: false,
        error: { code: 'AIRHUB_CREDENTIALS_MISSING', message: 'Username and password are required. Add them to provider.config.' },
      }
    }

    // Never send credentials to the wrong environment
    const mismatch = environmentMismatchMessage(baseUrl, cfg)
    if (mismatch) return { success: false, error: { code: 'AIRHUB_ENV_MISMATCH', message: mismatch } }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 25000)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ userName: resolvedUsername, password: resolvedPassword }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const text = await response.text()
      const contentType = response.headers?.get?.('content-type') || ''

      // Handle 401 (invalid login) before attempting JSON parsing — the body
      // is frequently not JSON.
      if (response.status === 401) {
        let safeKeys: string[] = []
        try {
          const parsed = JSON.parse(text)
          if (parsed && typeof parsed === 'object') safeKeys = Object.keys(parsed)
        } catch { /* non-JSON — safeKeys stays empty */ }
        console.log(`[AIRHUB_AUTH_UNAUTHORIZED] httpStatus=401 contentType=${contentType} endpoint=${authPath} topKeys=${safeKeys.join(',')}`)
        return {
          success: false,
          error: {
            code: 'AIRHUB_AUTH_UNAUTHORIZED',
            message: 'AirHub login rejected credentials (HTTP 401)',
            details: { authStage: 'login', providerStatus: 401, retryable: false },
          },
        }
      }

      let data: any
      try { data = JSON.parse(text) } catch {
        console.log(`[AIRHUB_AUTH_RESPONSE] httpStatus=${response.status} contentType=${contentType} parse=NON_JSON`)
        return { success: false, error: { code: 'NON_JSON', message: 'AirHub returned non-JSON response' } }
      }

      const respKeys = Object.keys(data)
      const dataKeys = data.data && typeof data.data === 'object' ? Object.keys(data.data) : []
      console.log(`[AIRHUB_AUTH_RESPONSE] httpStatus=${response.status} isSuccess=${data.isSuccess} topKeys=${respKeys.join(',')} dataKeys=${dataKeys.join(',')} tokenSource=${data.token?'token':data.accessToken?'accessToken':data.data?.token?'data.token':'unknown'}`)

      if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `AirHub auth failed: HTTP ${response.status}` } }
      if (data.isSuccess === false) return { success: false, error: { code: 'AUTH_REJECTED', message: `AirHub rejected: ${data.message || 'unknown'}` } }

      const token = data.token || data.accessToken || data.access_token || data.data?.token || data.data?.accessToken || ''
      if (!token || token.length < 8) return { success: false, error: { code: 'NO_TOKEN', message: 'No valid token returned' } }

      const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token.trim()
      // AirHub-derived partnerCode (canonical source is the login response),
      // falling back to an existing valid config value. Nothing is invented.
      const existingPartnerCode = (provider.config as any)?.partnerCode
      const partnerCode = normalizePartnerCode(
        (data as any).data?.partnerCode ?? (data as any).partnerCode ?? existingPartnerCode,
      )
      const tokenExpiry = data.token_expire || data.expiresAt || existingTokenExpiry((provider.config as any))

      await prisma.provider.update({
        where: { id: this.providerId },
        data: {
          apiToken: encryptToken(cleanToken),
          tokenPlacement: provider.tokenPlacement || 'BEARER_HEADER',
          lastSuccessfulConnection: new Date(),
          lastError: null,
          errorCount: 0,
          config: {
            ...((provider.config as any) || {}),
            ...(partnerCode !== null ? { partnerCode } : {}),
            lastAuthenticatedAt: new Date().toISOString(),
            authEnvironmentAtAuth: ((provider.config as any)?.upstreamEnvironment) || provider.environment || 'production',
            tokenExpiry: tokenExpiry || null,
          },
        },
      })

      await recordHealthEvent(this.providerId, { eventType: 'CONNECTION_TEST', success: true, message: 'AirHub authenticated' })

      console.log(`[AIRHUB_AUTH_RESULT] success=true tokenPersisted=true tokenExpiryPresent=${!!tokenExpiry} partnerCode=${partnerCode} authEnvironment=${authEnv}`)
      this.token = cleanToken
      return { success: true, data: { token: cleanToken, accountInfo: { partnerCode, tokenExpiry } } }
    } catch (e: any) {
      const causeCode = e?.cause?.code || ''
      let msg: string
      if (e.name === 'AbortError') msg = 'AirHub auth timed out after 25 seconds'
      else if (causeCode === 'ENOTFOUND') msg = 'AirHub host not found (DNS failure)'
      else if (causeCode === 'ECONNREFUSED') msg = 'AirHub refused the connection'
      else if (causeCode?.includes('TLS') || causeCode?.includes('CERT')) msg = 'TLS connection to AirHub failed'
      else msg = `AirHub auth failed: ${e.message?.substring(0, 100)}`
      console.log(`[AIRHUB_AUTH_ERROR] ${msg}`)
      await prisma.provider.update({
        where: { id: this.providerId },
        data: { lastFailedConnection: new Date(), lastError: msg.substring(0, 500), errorCount: { increment: 1 } },
      }).catch(() => {})
      return { success: false, error: { code: 'NETWORK_ERROR', message: msg } }
    }
  }

  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, apiToken: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }
    if (!this.token && provider.apiToken) {
      try { this.token = decryptToken(provider.apiToken) || null } catch {}
    }
    if (!this.token) return { success: false, error: { code: 'NO_TOKEN', message: 'No token. Authenticate first.' } }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const startMs = Date.now()
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/Getcountry_regiondetail?flag=2`

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Accept': 'application/json' },
        signal: controller.signal,
      })
      clearTimeout(timeout)
      const latencyMs = Date.now() - startMs
      if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `AirHub returned ${response.status}` } }
      return { success: true, data: { message: `Connected (${latencyMs}ms)`, latencyMs } }
    } catch (e: any) {
      return { success: false, error: { code: 'NETWORK_ERROR', message: e.message?.substring(0, 200) } }
    }
  }

  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, authUrl: true, apiToken: true, tokenPlacement: true, authType: true, config: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }
    if (!this.token && provider.apiToken) {
      try { this.token = decryptToken(provider.apiToken) || null } catch {}
    }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const authUrl = provider.authUrl || '/api/Authentication/UserLogin'
    const path = '/api/ESIM/Getcountry_regiondetail?flag=2'
    const finalUrl = `${baseUrl.replace(/\/$/, '')}${path}`
    const warnings: string[] = []
    const config = (provider.config as any) || {}
    if (!config.partnerCode) warnings.push('partnerCode missing')

    try {
      const startMs = Date.now()
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(finalUrl, {
        method: 'GET',
        headers: { 'Authorization': this.token ? `Bearer ${this.token}` : 'Bearer <missing>', 'Accept': 'application/json' },
        signal: controller.signal,
      })
      clearTimeout(timeout)
      const text = await response.text()
      let data: any = null; try { data = JSON.parse(text) } catch {}
      return {
        success: true,
        data: {
          connectorClass: 'AirHubConnector', method: 'GET', baseUrl, authUrl, path, finalUrl,
          tokenPlacement: (provider.tokenPlacement || 'BEARER_HEADER') as DiagnosticInfo['tokenPlacement'],
          authType: provider.authType || 'credentials', authHeaderPresent: !!this.token, tokenReplaced: false,
          responseStatus: response.status, responseContentType: response.headers.get('content-type') || null,
          responseBody: data ? JSON.stringify(data).substring(0, 300) : text.substring(0, 300),
          latencyMs: Date.now() - startMs, warnings,
        },
      }
    } catch (e: any) {
      return {
        success: false,
        data: {
          connectorClass: 'AirHubConnector', method: 'GET', baseUrl, authUrl, path, finalUrl,
          tokenPlacement: 'HEADER', authType: 'credentials', authHeaderPresent: !!this.token, tokenReplaced: false,
          responseStatus: null, responseContentType: null, responseBody: null, latencyMs: null,
          warnings: [...warnings, e.message?.substring(0, 200)],
        },
        error: { code: 'NETWORK_ERROR', message: e.message?.substring(0, 200) },
      }
    }
  }

  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, apiToken: true, config: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }
    if (!this.token && provider.apiToken) {
      try { this.token = decryptToken(provider.apiToken) || null } catch {}
    }

    const config = (provider.config as any) || {}
    const partnerCode = normalizePartnerCode(config.partnerCode)
    if (partnerCode === null) {
      return { success: false, error: { code: 'AIRHUB_PARTNER_CODE_MISSING', message: 'AirHub partnerCode is not configured. Authenticate to derive and persist it from the login response.' } }
    }
    const flag = config.flag ?? 6
    const countryCode = config.countryCode ?? ''
    const multiplecountrycode = Array.isArray(config.multiplecountrycode) ? config.multiplecountrycode : ['UK']

    // Flag-aware validation
    if ([0, 1, 2, 4].includes(flag)) {
      // Allow empty
    } else if (flag === 5) {
      if (!countryCode) return { success: false, error: { code: 'MISSING_CONFIG', message: 'countryCode required for flag=5' } }
    } else if (flag === 6) {
      if (!multiplecountrycode.length) return { success: false, error: { code: 'MISSING_CONFIG', message: 'multiplecountrycode required for flag=6' } }
    }

    // Token refresh if missing or expired
    const tokenExpiry = config.tokenExpiry
    if (!this.token || (tokenExpiry && isTokenExpired(tokenExpiry))) {
      const reason = !this.token ? 'missing' : 'expired'
      const refreshed = await this.refreshTokenFromConfig()
      console.log(`[AIRHUB_TOKEN_REFRESH] reason=${reason} success=${refreshed}`)
      if (!refreshed && !this.token) {
        return { success: false, error: { code: 'NO_TOKEN', message: 'No token. Authenticate first.' } }
      }
    }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/GetPlanInformation`
    const body = { partnerCode, flag, countryCode, multiplecountrycode }
    const hasToken = !!this.token
    const tokenLooksValid = !!this.token && this.token.length > 20
    const hasBearerPrefix = !!(this.token && this.token.startsWith('Bearer '))
    console.log(`[AIRHUB_GET_PLANS_BODY] partnerCode=${partnerCode} flag=${flag} countryCode="${countryCode}" multiplecountrycode=${JSON.stringify(multiplecountrycode)}`)
    console.log(`[AIRHUB_GET_PLANS_REQUEST] url=${url} partnerCode=${partnerCode} flag=${flag}`)
    console.log(`[AIRHUB_GET_PLANS_AUTH] tokenAvailable=${hasToken} tokenLength=${this.token?.length||0} tokenLooksValid=${tokenLooksValid} hasBearerPrefix=${hasBearerPrefix} hasAuthorization=true scheme=Bearer`)

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 25000)
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const text = await response.text()
        const contentType = response.headers.get('content-type') || ''

        console.log(`[AIRHUB_GET_PLANS_HTTP] status=${response.status} statusText=${response.statusText} contentType=${contentType} bodyLength=${text.length}`)
        if (text.length < 500) console.log(`[AIRHUB_GET_PLANS_HTTP] body=${text.substring(0, 500)}`)

        // 401 on first attempt -> reauthenticate and retry once
        if (response.status === 401 && attempt === 1) {
          const refreshed = await this.refreshTokenFromConfig()
          console.log(`[AIRHUB_TOKEN_REFRESH] reason=401 success=${refreshed}`)
          if (refreshed) {
            console.log(`[AIRHUB_GET_PLANS_RETRY] attempt=${attempt + 1} status=${response.status}`)
            continue
          }
          return { success: false, error: { code: 'HTTP_401', message: 'AirHub GET_PLANS returned 401 and reauthentication failed' } }
        }

        let data: any
        try {
          data = JSON.parse(text)
        } catch (parseErr: any) {
          console.log(`[AIRHUB_GET_PLANS_ERROR] JSON parse failed: ${parseErr.message}`)
          const preview = text.substring(0, 300)
          if (preview.trim().startsWith('<')) {
            return { success: false, error: { code: 'HTML_RESPONSE', message: `AirHub returned HTML instead of JSON. Preview: ${preview}` } }
          }
          return { success: false, error: { code: 'NON_JSON', message: `AirHub returned non-JSON response. Status=${response.status} Preview: ${preview}` } }
        }

        console.log(`[AIRHUB_GET_PLANS_RESPONSE] status=${response.status} isSuccess=${data.isSuccess}`)
        if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `AirHub GET_PLANS returned ${response.status}: ${text.substring(0, 200)}` } }
        if (data.isSuccess === false) return { success: false, error: { code: 'PROVIDER_REJECTED', message: `AirHub rejected GET_PLANS: ${data.message || 'isSuccess=false'}` } }

        const plans = data.getInformation || []
        console.log(`[AIRHUB_SYNC_RESULT] fetched=${plans.length}`)

        let created = 0, updated = 0, failed = 0
        for (const plan of plans) {
          const planCode = plan.planCode
          if (!planCode) { failed++; continue }
          try {
            const cap = parseFloat(plan.capacity || '0')
            const unit = (plan.capacityUnit || 'GB').toUpperCase()
            const dataGB = unit === 'MB' ? Math.round((cap / 1024) * 100) / 100 : unit === 'KB' ? Math.round((cap / 1024 / 1024) * 100) / 100 : cap
            const rawCost = parseFloat(plan.price || '0')
            const hasValidCost = Number.isFinite(rawCost) && rawCost > 0
            // Catalog facts only. Pricing status/cost state is owned by the
            // canonical shared sync (syncProviderPlans) so a connector write can
            // never claim pricingStatus=READY from cost alone (see pricing-state).
            const pkg = {
              name: plan.planName || '',
              dataGB: Math.max(0.01, dataGB || 0.01),
              validityDays: parseInt(plan.validity || '30') || 30,
              costPrice: hasValidCost ? rawCost : 0,
              currency: plan.currency || 'USD',
              country: plan.countryName || null,
              region: plan.countryName || null,
              planType: plan.planType || null,
              providerPlanCode: planCode,
              providerRawData: withTravelDateMarker(plan, normalizeTravelDateRequirement(plan)),
              isAvailable: true,
            }
            const existing = await prisma.providerPackage.findFirst({ where: { providerId: this.providerId, providerPlanId: planCode } })
            if (existing) { await prisma.providerPackage.update({ where: { id: existing.id }, data: pkg }); updated++ }
            else { await prisma.providerPackage.create({ data: { providerId: this.providerId, providerPlanId: planCode, ...pkg } }); created++ }
          } catch { failed++ }
        }

        await prisma.provider.update({
          where: { id: this.providerId },
          data: { lastSyncAt: new Date(), lastSyncCount: plans.length, lastSyncResult: `${plans.length} fetched: ${created}c ${updated}u ${failed}f` },
        }).catch(() => {})

        const resultPlans = await prisma.providerPackage.findMany({
          where: { providerId: this.providerId },
          select: { id: true, name: true, dataGB: true, validityDays: true, costPrice: true, currency: true, providerPlanCode: true, providerRawData: true },
          take: 500,
        })
        return {
          success: true,
          data: resultPlans.map(p => ({
            id: p.providerPlanCode || p.id, name: p.name, data_gb: p.dataGB, validity_days: p.validityDays,
            price_usd: Number(p.costPrice), currency: p.currency, sku: p.providerPlanCode || '', raw_data: p.providerRawData || undefined,
            requiresTravelDate: normalizeTravelDateRequirement(p.providerRawData),
          })),
        }
      } catch (e: any) {
        console.log(`[AIRHUB_GET_PLANS_ERROR] name=${e.name} message=${e.message?.substring(0,200)} causeCode=${e.cause?.code||''} causeMessage=${e.cause?.message?.substring(0,200)||''}`)
        return { success: false, error: { code: 'NETWORK_ERROR', message: e.message?.substring(0, 200) } }
      }
    }
    return { success: false, error: { code: 'UNKNOWN', message: 'syncPlans exhausted retries' } }
  }

  async validatePurchase(_params: { planId: string; quantity: number; subscriber: { email: string } }): Promise<{ valid: boolean; reason?: string }> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, config: true, apiToken: true } })
    if (!provider) return { valid: false, reason: 'Provider not found' }
    if (!provider.apiBaseUrl) return { valid: false, reason: 'API base URL not configured' }
    const cfg = (provider.config as any) || {}
    if (!cfg.partnerCode && cfg.partnerCode !== 0) return { valid: false, reason: 'partnerCode not configured in provider config' }
    const hasCredentials = (!!cfg.username || !!cfg.userName) && (!!cfg.password || !!cfg.pass)
    const hasToken = !!provider.apiToken
    if (!hasCredentials && !hasToken) return { valid: false, reason: 'Credentials (username/password) or an API token are required in provider.config' }
    return { valid: true }
  }

  async activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    const correlationId = `airhub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const startMs = Date.now()

    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, apiToken: true, config: true, code: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }

    const cfg = (provider.config as any) || {}
    const partnerCode = normalizePartnerCode(cfg.partnerCode)
    if (partnerCode === null) {
      return { success: false, error: { code: 'AIRHUB_PARTNER_CODE_MISSING', message: 'AirHub partnerCode is not configured. Authenticate to derive and persist it from the login response.' } }
    }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/PurhaseSim`

    // Never authenticate or purchase against the wrong environment
    const mismatch = environmentMismatchMessage(baseUrl, cfg)
    if (mismatch) return { success: false, error: { code: 'AIRHUB_ENV_MISMATCH', message: mismatch } }

    // Resolve a valid token before the first purchase call. A persisted valid
    // token is decrypted into memory and reused. A missing, expired, or
    // environment-mismatched token triggers a fresh login whose returned token
    // is used immediately — never reloaded from the DB after authenticate().
    const tokenState = await this.getTokenState()
    if (!this.token && tokenState.tokenPresent && !tokenState.expired && !tokenState.expiresSoon) {
      try {
        this.token = provider.apiToken ? decryptToken(provider.apiToken) || null : null
      } catch {
        this.token = null
      }
    }
    if (!this.token) {
      const username = String(cfg.username || '').trim()
      const password = String(cfg.password || '').trim()
      if (!username || !password) {
        return { success: false, error: { code: 'AIRHUB_CREDENTIALS_MISSING', message: 'Username and password are required. Add them to provider.config.' } }
      }
      const auth = await this.authenticate({ username, password })
      if (!auth.success) return { success: false, error: auth.error }
      if (!this.token) this.token = auth.data?.token || null
    }
    if (!this.token) {
      return { success: false, error: { code: 'NO_TOKEN', message: 'No token. Authenticate first.' } }
    }

    // --- Build the exact documented payload. quantity/email/orderId/packageId
    // are OneSIM-internal and MUST NOT be serialized to AirHub. ---
    const planCode = params.planId
    // AirHub treats unique_order_id as its upstream idempotent/order key: it must
    // be deterministic, unique per OneSIM order, and stable across safe retries of
    // the SAME order. The OneSIM ESIMPurchase id (params.orderId) satisfies all
    // three. params.externalId is the business id — shared by many orders, so it
    // is only a legacy fallback for callers that do not pass an orderId. Date.now()
    // remains a last resort for callers that provide neither (never an idempotency
    // retry path).
    const uniqueOrderId = params.orderId || params.externalId || `onesim-${Date.now()}`
    const rawTravelDate = (params as any).travelDate || (params.subscriber as any)?.travelDate || undefined
    console.log(`[TRAVEL_DATE_TRACE] stage=AIRHUB_CONNECTOR travelDatePresent=${!!rawTravelDate}`)

    const validation = this.validatePurchasePayload({ partnerCode, planCode, uniqueOrderId, travelDate: rawTravelDate })
    if (!validation.valid) return { success: false, error: validation.error! }

    const payload: Record<string, string> = {
      partnerCode: String(partnerCode),
      planCode: String(planCode),
      unique_order_id: String(uniqueOrderId),
    }
    if (validation.travelDate) payload.travelDate = validation.travelDate

    // Sanitized pre-flight diagnostics — never logs the token, password, or payload values.
    console.log(`[AIRHUB_PURCHASE_REQUEST] correlationId=${correlationId} endpoint=/api/ESIM/PurhaseSim bodyKeys=${Object.keys(payload).join(',')} partnerCodeType=${typeof payload.partnerCode} planCodeType=${typeof payload.planCode} travelDatePresent=${'travelDate' in payload} uniqueOrderIdPresent=${'unique_order_id' in payload} authorizationPresent=${!!this.token}`)

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30000)
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        clearTimeout(timeout)

        const text = await response.text()
        const contentType = response.headers?.get?.('content-type') || ''
        const durationMs = Date.now() - startMs

        // Handle 401 (rejected/expired purchase token) before attempting JSON
        // parsing — AirHub frequently returns a non-JSON body on 401.
        if (response.status === 401) {
          const hadToken = !!this.token
          let safeKeys: string[] = []
          try {
            const parsed = JSON.parse(text)
            if (parsed && typeof parsed === 'object') safeKeys = Object.keys(parsed)
          } catch { /* non-JSON — safeKeys stays empty */ }
          console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} httpStatus=401 contentType=${contentType} endpoint=/api/ESIM/PurhaseSim topKeys=${safeKeys.join(',')} durationMs=${durationMs}`)

          if (attempt === 1) {
            const refreshed = await this.refreshTokenFromConfig()
            console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} reason=401 refreshSuccess=${refreshed}`)
            if (refreshed) continue
          }

          return {
            success: false,
            error: {
              code: 'AIRHUB_AUTH_UNAUTHORIZED',
              message: hadToken
                ? 'AirHub purchase rejected the token (HTTP 401) and reauthentication failed'
                : 'AirHub purchase requires authentication (HTTP 401)',
              details: { authStage: hadToken ? 'purchase_token_rejected' : 'login_required', retryable: false, providerStatus: 401 },
            },
          }
        }

        let data: any
        try { data = JSON.parse(text) } catch {
          if (response.status === 400) {
            console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} httpStatus=400 contentType=${contentType} durationMs=${durationMs} error=NON_JSON_VALIDATION`)
            return { success: false, error: { code: 'VALIDATION_ERROR', message: 'AirHub validation failed: the request was rejected (HTTP 400) with a non-JSON response.', details: { retryable: false, providerStatus: 400 } } }
          }
          console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} httpStatus=${response.status} contentType=${contentType} durationMs=${durationMs} error=NON_JSON`)
          return { success: false, error: { code: 'PROVIDER_RESPONSE_INVALID', message: `AirHub returned non-JSON response (HTTP ${response.status})` } }
        }

        const dataKeys = data.data && typeof data.data === 'object' ? Object.keys(data.data) : []
        console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} httpStatus=${response.status} isSuccess=${data.isSuccess} durationMs=${durationMs} topKeys=${Object.keys(data).join(',')} dataKeys=${dataKeys.join(',')}`)

        // Guarded full-response diagnostics (off by default). No business logic.
        logBalanceDiagnostics('purchase', { httpStatus: response.status, data, partnerCode, token: this.token })

        // HTTP 400 — ASP.NET ModelState validation. Surface the failing fields
        // instead of dumping the raw RFC 7231 body.
        if (response.status === 400) {
          const parsed = this.parsePurchaseValidationError(data)
          const fieldEntries = Object.entries(parsed.fields)
          console.log(`[AIRHUB_PURCHASE_VALIDATION] fields=${fieldEntries.map(([f]) => f).join(',')} messages=${fieldEntries.map(([, msgs]) => msgs.join(', ')).join(' | ')}`)
          return {
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: parsed.message,
              details: { retryable: false, providerStatus: 400, fields: parsed.fields },
            },
          }
        }

        if (!response.ok) {
          const code = this.classifyHttpError(response.status, data)
          return { success: false, error: { code, message: `AirHub returned HTTP ${response.status}: ${data.message || text.substring(0, 200)}`, details: { retryable: response.status >= 500, providerStatus: response.status } } }
        }

        if (data.isSuccess === false) {
          const code = this.classifyProviderError(data)
          return { success: false, error: { code: this.classifyProviderError(data), message: `AirHub rejected purchase: ${data.message || 'isSuccess=false'}`, details: { retryable: false, providerStatus: response.status } } }
        }

        const d = data.data || data
        const iccids = this.extractIccids(d, params.quantity)
        const simId = d.simID || d.simId || d.sim_id || d.data?.simID || d.data?.simId || undefined
        const orderId = d.orderId || d.order_id || d.orderid || d.orderID || d.OrderID || d.transactionId || d.id || data.orderId || data.order_id || data.orderid || simId || ''

        if (!iccids.length) {
          console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} warning=NO_ICCIDS orderId=${orderId} dataKeys=${Object.keys(d).join(',')}`)
          const pendingStatus = this.detectPendingStatus(d)
          if (pendingStatus) {
            console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} pendingStatus=${pendingStatus}`)
            return { success: true, data: { activationId: orderId, iccids: [], status: pendingStatus } }
          }

          // AirHub confirmed the purchase (HTTP 200 + isSuccess=true) but returned
          // no usable ICCID/status. Only an EXPLICIT provider failure status makes
          // this a definitive failure. Otherwise the upstream mutation may have
          // completed, so flag AMBIGUOUS + upstreamConfirmed: marking a definitive
          // failure here could release the wallet for a purchase the provider has
          // already charged. Any discovered order/sim reference is carried in the
          // details so reconciliation can locate the asset — never re-purchase.
          const explicitFailure = this.detectExplicitFailure(d)
          if (explicitFailure) {
            return { success: false, error: { code: 'NO_ICCIDS', message: explicitFailure, details: { retryable: false, providerStatus: response.status } } }
          }
          return {
            success: false,
            error: {
              code: 'NO_ICCIDS',
              message: 'AirHub confirmed success but returned no usable ICCID — the outcome is ambiguous and requires reconciliation',
              details: {
                retryable: false,
                providerStatus: response.status,
                ambiguous: true,
                upstreamConfirmed: true,
                ...(orderId ? { providerOrderId: orderId } : {}),
                ...(simId ? { simId } : {}),
              },
            },
          }
        }

        const activationCode = d.activationCode || d.data?.activationCode || d.lpa || d.data?.lpa || d.lpaProfile || undefined
        const qrCodeUrl = d.qrCodeUrl || d.qr_code_url || d.data?.qrCodeUrl || d.data?.qr_code_url || undefined
        const matchingId = d.matchingId || d.matching_id || d.data?.matchingId || undefined
        const smdpAddress = d.smdpAddress || d.smdp_address || d.data?.smdpAddress || undefined
        const imsis = d.imsis || (d.imsi ? [d.imsi] : undefined)
        const activationCodes = activationCode ? [activationCode] : d.activationCodes || undefined

        // Purchase completion never implies the eSIM is network-active.
        const status = this.normalizePurchaseStatus(d)
        const rawMetadata: Record<string, any> = {
          orderId,
          ...(simId ? { simId } : {}),
          ...(activationCode ? { activationCode } : {}),
          ...(d.apn ? { apn: d.apn } : {}),
          ...(d.message ? { message: d.message } : {}),
        }

        if (!qrCodeUrl) {
          try {
            console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} step=FETCH_QR iccid=${maskIdentifier(iccids[0])}`)
            const qrResult = await this.getQRCode(iccids[0])
            if (qrResult.success && qrResult.data?.qrCodeUrl) {
              console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} step=FETCH_QR success=true`)
              return {
                success: true,
                data: {
                  activationId: orderId, iccids, imsis: imsis as string[] | undefined,
                  activationCodes, qrCodeUrl: qrResult.data.qrCodeUrl, matchingId, smdpAddress,
                  iccidOrSimId: simId || iccids[0], rawMetadata, status,
                },
              }
            }
            console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} step=FETCH_QR success=false reason=${qrResult.error?.code || 'unknown'}`)
          } catch (qrErr: any) {
            console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} step=FETCH_QR error=${qrErr.message?.substring(0, 100)}`)
          }
        }

        console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} result=SUCCESS orderId=${orderId} iccidCount=${iccids.length} status=${status} durationMs=${durationMs}`)

        return {
          success: true,
          data: {
            activationId: orderId, iccids, imsis: imsis as string[] | undefined,
            activationCodes, qrCodeUrl, matchingId, smdpAddress,
            iccidOrSimId: simId || iccids[0], rawMetadata, status,
          },
        }
      } catch (e: any) {
        const durationMs = Date.now() - startMs
        if (e.name === 'AbortError') {
          console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} error=TIMEOUT durationMs=${durationMs}`)
          return { success: false, error: { code: 'TIMEOUT', message: `AirHub activation timed out after ${durationMs}ms`, details: { retryable: true, providerStatus: undefined } } }
        }
        const causeCode = e?.cause?.code || ''
        let msg: string, code: string
        if (causeCode === 'ENOTFOUND') { code = 'NETWORK_ERROR'; msg = 'AirHub host not found (DNS failure)' }
        else if (causeCode === 'ECONNREFUSED') { code = 'NETWORK_ERROR'; msg = 'AirHub refused the connection' }
        else if (causeCode?.includes('TLS') || causeCode?.includes('CERT')) { code = 'NETWORK_ERROR'; msg = 'TLS connection to AirHub failed' }
        else { code = 'NETWORK_ERROR'; msg = `AirHub activation error: ${e.message?.substring(0, 200)}` }
        console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} error=${code} message=${msg.substring(0, 200)} durationMs=${durationMs}`)
        return { success: false, error: { code, message: msg, details: { retryable: true } } }
      }
    }
    return { success: false, error: { code: 'RETRIES_EXHAUSTED', message: 'AirHub activation exhausted retries' } }
  }

  async getStatus(subscriptionId: string): Promise<ConnectorResult<StatusResult>> {
    const correlationId = `airhub-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, apiToken: true, config: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }

    const tokenResult = await this.ensureAuthenticated()
    if (!tokenResult.success) return { success: false, error: tokenResult.error }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    // The documented AirHub order-detail read is POST /api/ESIM/GetActivationCode,
    // keyed by the purchase-returned AirHub `orderid` (array). There is NO
    // /api/ESIM/OrderDetails endpoint (it returns HTTP 404). The identifier must
    // be the provider-owned order reference — never a local OneSIM id and never
    // an ICCID (this endpoint does not accept ICCIDs).
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/GetActivationCode`
    const cfg = (provider.config as any) || {}
    const partnerCode = normalizePartnerCode(cfg.partnerCode)
    if (partnerCode === null) {
      return { success: false, error: { code: 'AIRHUB_PARTNER_CODE_MISSING', message: 'AirHub partnerCode is not configured. Authenticate to derive and persist it from the login response.' } }
    }
    const body = { partnerCode: Number(partnerCode), orderid: [String(subscriptionId)] }

    console.log(`[AIRHUB_STATUS] correlationId=${correlationId} endpoint=/api/ESIM/GetActivationCode orderid=${subscriptionId}`)

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20000)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const text = await response.text()
      let data: any
      try { data = JSON.parse(text) } catch {
        if (response.status === 404) {
          return { success: false, error: { code: 'NOT_FOUND', message: `AirHub returned HTTP 404 for order ${subscriptionId} — the order was not found` } }
        }
        return { success: false, error: { code: 'PROVIDER_RESPONSE_INVALID', message: 'AirHub returned non-JSON status response' } }
      }

      console.log(`[AIRHUB_STATUS] correlationId=${correlationId} httpStatus=${response.status} isSuccess=${data.isSuccess}`)

      if (!response.ok) {
        const code = this.classifyStatusHttpError(response.status, data)
        return {
          success: false,
          error: {
            code,
            message: `AirHub status returned HTTP ${response.status}: ${data.message || text.substring(0, 200)}`,
            details: { retryable: response.status >= 500, providerStatus: response.status },
          },
        }
      }
      if (data.isSuccess === false) {
        const code = this.classifyStatusRejection(data)
        const retryable = code === 'PROVIDER_UNAVAILABLE' || code === 'RATE_LIMITED'
        return {
          success: false,
          error: { code, message: `AirHub rejected status lookup: ${data.message || 'isSuccess=false'}`, details: { retryable, providerStatus: response.status } },
        }
      }

      // GetActivationCode may return a single object or an array of order rows.
      const rows = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [data.data || data]
      const row: any = rows[0] || {}
      const rawStatus = row.status || row.orderStatus || data.status || data.orderStatus || ''
      const iccids = this.extractIccids(row, 0)
      const fulfilled = iccids.length > 0 || Boolean(row.activationCode) || Boolean(row.activation_code)
      const status = this.normalizeStatusValue(rawStatus, fulfilled)

      const install = {
        ...(row.activationCode || row.activation_code ? { activationCode: row.activationCode || row.activation_code } : {}),
        ...(row.qrCodeUrl || row.qr_code_url ? { qrCodeUrl: row.qrCodeUrl || row.qr_code_url } : {}),
        ...(row.smdpAddress || row.smdp_address ? { smdpAddress: row.smdpAddress || row.smdp_address } : {}),
        ...(row.matchingId || row.matching_id ? { matchingId: row.matchingId || row.matching_id } : {}),
      }

      return {
        success: true,
        data: {
          status,
          iccids: iccids.length ? iccids : undefined,
          iccid: iccids[0] || undefined,
          rawStatus: rawStatus || null,
          ...install,
          rawMetadata: {
            orderid: subscriptionId,
            ...(row.simID || row.simId || row.sim_id ? { simId: row.simID || row.simId || row.sim_id } : {}),
            ...(row.apn ? { apn: row.apn } : {}),
            ...(row.message ? { message: row.message } : {}),
          },
        },
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return { success: false, error: { code: 'TIMEOUT', message: 'AirHub status check timed out' } }
      return { success: false, error: { code: 'NETWORK_ERROR', message: `AirHub status error: ${e.message?.substring(0, 200)}` } }
    }
  }

  /** Maps a raw AirHub status string (or detected fulfillment) into the canonical lifecycle value. */
  private normalizeStatusValue(raw: unknown, fulfilled: boolean): string {
    const s = String(raw || '').trim().toUpperCase()
    if (['ACTIVE', 'ACTIVATED', 'COMPLETED', 'SUCCESS', 'READY'].includes(s)) return 'ACTIVE'
    if (['FAILED'].includes(s)) return 'FAILED'
    if (['CANCELLED', 'CANCELED'].includes(s)) return 'CANCELLED'
    if (['REJECTED', 'REJECT'].includes(s)) return 'REJECTED'
    if (['EXPIRED'].includes(s)) return 'EXPIRED'
    if (['QUEUED', 'PROCESSING', 'IN_PROGRESS', 'PROVISIONING', 'SUBMITTED'].includes(s)) return 'PROCESSING'
    if (fulfilled) return 'ACTIVE'
    return 'PENDING'
  }

  /** Classify an HTTP failure for a status lookup (provider-neutral codes). */
  private classifyStatusHttpError(status: number, data: any): string {
    if (status === 401 || status === 403) return 'AUTH_ERROR'
    if (status === 404) return 'NOT_FOUND'
    if (status === 429) return 'RATE_LIMITED'
    if (status >= 500) return 'PROVIDER_UNAVAILABLE'
    return `HTTP_${status}`
  }

  /** Classify an isSuccess=false status response. */
  private classifyStatusRejection(data: any): string {
    const msg = (data.message || data.error || '').toLowerCase()
    if (/not found|no record|does not exist|invalid order/.test(msg)) return 'NOT_FOUND'
    if (/auth|login|credential/.test(msg)) return 'AUTH_ERROR'
    if (/timeout|unavailable|maintenance/.test(msg)) return 'PROVIDER_UNAVAILABLE'
    return 'PROVIDER_REJECTED'
  }

  /**
   * AirHub GetActivationCode is keyed by the purchase-returned AirHub order id
   * (orderid), so the status lookup must use the provider-owned reference —
   * never a local OneSIM id and never an ICCID. Returns null when no order
   * reference exists so the caller skips.
   */
  resolveStatusLookup(esim: StatusLookupEsim): string | null {
    return esim.providerSubscriptionId || esim.providerActivationId || null
  }

  /** AirHub connector-declared internal capabilities. */
  capabilities: ConnectorCapabilities = {
    installationLookup: true,
    installationDataAtPurchase: true,
    installationLookupHistorical: true, // read-only GetActivationCode by ICCID
    statusLookup: true,
    usageLookup: false,
    topUp: false,
    suspend: false,
    resume: false,
    balance: true,
    inventory: true,
    webhooks: false,
  }

  /** AirHub uses runtime credentials → token. */
  authProfile: ConnectorAuthProfile = {
    mode: 'LOGIN_TOKEN',
    requiresRuntimeAuthentication: true,
    canVerifyCredentials: true,
    supportsRefresh: true,
  }

  /** Canonical AirHub installation lookup — read-only GetActivationCode. */
  async lookupInstallationData(input: InstallationLookupInput): Promise<InstallationLookupResult> {
    if (!input.iccid) {
      return { success: false, state: 'PERMANENT_FAILURE', errorCode: 'IDENTIFIER_MISSING', diagnostics: { methodUsed: 'get_activation_code', identifierType: 'none' } }
    }
    const result = await this.getQRCode(input.iccid)
    if (result.success && result.data) {
      const raw = result.data.qrCodeUrl || ''
      const isLpa = /^LPA:/i.test(raw) || raw.includes('$')
      const data: ConnectorInstallDataOutput = isLpa ? { activationCode: raw } : { qrCodeUrl: raw }
      if (hasUsableInstallData(data)) {
        return { success: true, state: 'READY', data, diagnostics: { methodUsed: 'get_activation_code', identifierType: 'iccid', httpMethod: 'POST', endpointName: 'GetActivationCode' } }
      }
    }
    const code = result.error?.code || ''
    const diag = { methodUsed: 'get_activation_code', identifierType: 'iccid', httpMethod: 'POST', endpointName: 'GetActivationCode' } as const
    if (code === 'NOT_SUPPORTED') return { success: false, state: 'NOT_SUPPORTED', errorCode: 'LOOKUP_NOT_SUPPORTED', diagnostics: { ...diag } }
    if (code === 'TIMEOUT' || code === 'NETWORK_ERROR') return { success: false, state: 'NOT_AVAILABLE_YET', errorCode: 'PROVIDER_TIMEOUT', diagnostics: { ...diag } }
    if (code === 'PROVIDER_REJECTED' || /^HTTP_4/.test(code)) {
      return { success: false, state: 'PERMANENT_FAILURE', errorCode: /^HTTP_40/.test(code) ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_HTTP_ERROR', diagnostics: { ...diag } }
    }
    return { success: false, state: 'NOT_AVAILABLE_YET', errorCode: 'NO_QR_CODE', diagnostics: { ...diag } }
  }

  async getQRCode(iccid: string): Promise<ConnectorResult<QRCodeResult>> {
    const correlationId = `airhub-qr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, apiToken: true, config: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }

    const tokenResult = await this.ensureAuthenticated()
    if (!tokenResult.success) return { success: false, error: tokenResult.error }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/GetActivationCode`
    const cfg = (provider.config as any) || {}
    const partnerCode = normalizePartnerCode(cfg.partnerCode)
    if (partnerCode === null) {
      return { success: false, error: { code: 'AIRHUB_PARTNER_CODE_MISSING', message: 'AirHub partnerCode is not configured. Authenticate to derive and persist it from the login response.' } }
    }
    const body = { partnerCode, iccid }

    console.log(`[AIRHUB_QR] correlationId=${correlationId} iccid=${maskIdentifier(iccid)}`)

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20000)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const text = await response.text()
      let data: any
      try { data = JSON.parse(text) } catch {
        return { success: false, error: { code: 'PROVIDER_RESPONSE_INVALID', message: 'AirHub returned non-JSON QR response' } }
      }

      console.log(`[AIRHUB_QR] correlationId=${correlationId} httpStatus=${response.status} isSuccess=${data.isSuccess}`)

      if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `AirHub QR retrieval returned ${response.status}` } }
      if (data.isSuccess === false) return { success: false, error: { code: 'PROVIDER_REJECTED', message: `AirHub rejected QR request: ${data.message || 'isSuccess=false'}` } }

      const d = data.data || data
      const qrCodeUrl = d.qrCodeUrl || d.qr_code_url || d.qrCode || d.activationCode || d.data?.qrCodeUrl || d.data?.qr_code_url || d.data?.qrCode || d.data?.activationCode || ''

      if (!qrCodeUrl) return { success: false, error: { code: 'NO_QR_CODE', message: 'AirHub returned no QR code data' } }
      return { success: true, data: { qrCodeUrl } }
    } catch (e: any) {
      if (e.name === 'AbortError') return { success: false, error: { code: 'TIMEOUT', message: 'AirHub QR retrieval timed out' } }
      return { success: false, error: { code: 'NETWORK_ERROR', message: `AirHub QR error: ${e.message?.substring(0, 200)}` } }
    }
  }

  async getUsage(_iccid: string): Promise<ConnectorResult<UsageResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Usage retrieval not supported for AirHub' } } }
  async suspendESIM(_subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Suspend not supported for AirHub' } } }
  async resumeESIM(_subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Resume not supported for AirHub' } } }
  async getRates(): Promise<ConnectorResult<RateResult[]>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Rates not supported for AirHub' } } }
  async topUpESIM(_params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Top-up not supported for AirHub' } } }

  private extractIccids(d: any, minCount: number): string[] {
    const iccids: string[] = []
    const candidates = [
      d.iccids, d.iccid_list, d.data?.iccids, d.data?.iccid_list,
      d.esim?.iccids, d.order?.iccids, d.result?.iccids,
      d.simID, d.simId, d.sim_id, d.data?.simID, d.data?.simId,
    ]
    for (const c of candidates) {
      if (Array.isArray(c) && c.length >= minCount) return c.map(String)
      if (Array.isArray(c) && c.length > 0 && !iccids.length) iccids.push(...c.map(String))
      if (typeof c === 'string' && c.length >= 10 && !iccids.includes(c)) iccids.push(c)
    }
    const singles = [d.iccid, d.data?.iccid, d.esim?.iccid, d.result?.iccid, d.sim?.iccid, d.sims?.[0]?.iccid]
    for (const s of singles) {
      if (s && typeof s === 'string' && s.length >= 10 && !iccids.includes(s)) { iccids.push(s); break }
    }

    // AirHub PurhaseSim success responses use a scalar `simID`/`simId`/`sim_id`
    // for the provisioned SIM identifier (top-level or nested under `data`).
    // This is only a FALLBACK: it is used when no stronger canonical ICCID is
    // already captured, and only for a non-empty, non-whitespace value. A
    // numeric simID is normalized to its string form. Pending/provisional
    // identifiers that are empty are rejected.
    if (iccids.length === 0) {
      const simId = this.normalizeSimId(d)
      if (simId) iccids.push(simId)
    }

    return iccids
  }

  /** Normalize a scalar top-level/nested AirHub `simID`/`simId`/`sim_id` value. */
  private normalizeSimId(d: any): string | null {
    const raw = d.simID ?? d.simId ?? d.sim_id ?? d.data?.simID ?? d.data?.simId ?? d.data?.sim_id ?? null
    if (raw === null || raw === undefined) return null
    const s = String(raw).trim()
    if (s.length === 0) return null
    // Numeric strings are accepted as provided by AirHub (a provisioned SIM ref).
    if (isNaN(Number(s))) return s
    return s
  }

  /** Local validation of the documented purchase payload. Rejects before any HTTP call. */
  private validatePurchasePayload(args: { partnerCode: unknown; planCode: unknown; uniqueOrderId: unknown; travelDate?: unknown }): { valid: boolean; error?: { code: string; message: string }; travelDate?: string } {
    if (args.partnerCode === undefined || args.partnerCode === null || String(args.partnerCode).trim() === '') {
      return { valid: false, error: { code: 'AIRHUB_PARTNER_CODE_MISSING', message: 'partnerCode is required' } }
    }
    if (args.planCode === undefined || args.planCode === null || String(args.planCode).trim() === '') {
      return { valid: false, error: { code: 'AIRHUB_PLAN_CODE_MISSING', message: 'planCode is required' } }
    }
    if (args.uniqueOrderId === undefined || args.uniqueOrderId === null || String(args.uniqueOrderId).trim() === '') {
      return { valid: false, error: { code: 'AIRHUB_ORDER_ID_MISSING', message: 'unique_order_id is required' } }
    }
    const raw = args.travelDate
    if (raw === undefined || raw === null || raw === '') return { valid: true }
    const s = String(raw)
    if (!isValidTravelDate(s)) {
      return { valid: false, error: { code: 'AIRHUB_TRAVEL_DATE_INVALID', message: `travelDate must be YYYY-MM-DD, got "${s}"` } }
    }
    return { valid: true, travelDate: s }
  }

  /**
   * Parses ASP.NET ModelState validation bodies:
   * { type, title: "One or more validation errors occurred.", status: 400, traceId, errors: { field: [msg] } }
   * Returns a readable message + field map. Never surfaces the raw body or traceId as the user error.
   */
  private parsePurchaseValidationError(data: any): { message: string; fields: Record<string, string[]> } {
    const fields: Record<string, string[]> = {}
    const errors = data?.errors
    if (errors && typeof errors === 'object') {
      for (const [field, msgs] of Object.entries(errors)) {
        fields[field] = Array.isArray(msgs) ? msgs.map(String) : [String(msgs)]
      }
    }
    if (Object.keys(fields).length > 0) {
      const [field, msgs] = Object.entries(fields)[0]
      return { message: `AirHub validation failed: ${field} — ${msgs[0]}`, fields }
    }
    const title = typeof data?.title === 'string' ? data.title : 'One or more validation errors occurred.'
    return { message: `AirHub validation failed: ${title}`, fields }
  }

  /** Purchase-completion status normalization — never reports ACTIVE from a purchase. */
  private normalizePurchaseStatus(d: any): 'PENDING' | 'PENDING_ACTIVATION' | 'PROCESSING' {
    const raw = (d.status || d.orderStatus || '').toString().toUpperCase()
    if (raw === 'ACTIVE' || raw === 'ACTIVATED' || raw === 'SUCCESS' || raw === 'COMPLETED') return 'PENDING_ACTIVATION'
    if (raw === 'PROCESSING' || raw === 'QUEUED' || raw === 'IN_PROGRESS') return 'PROCESSING'
    if (raw === 'PENDING' || raw === 'INITIATED') return 'PENDING'
    return 'PENDING_ACTIVATION'
  }

  private detectPendingStatus(d: any): 'PENDING' | 'PROCESSING' | null {
    const raw = (d.status || d.orderStatus || '').toString().toUpperCase()
    if (['PROCESSING', 'QUEUED', 'PENDING', 'IN_PROGRESS', 'INITIATED'].includes(raw)) {
      if (raw === 'PROCESSING' || raw === 'QUEUED' || raw === 'IN_PROGRESS') return 'PROCESSING'
      return 'PENDING'
    }
    return null
  }

  /** Returns a message when the response carries an explicit provider failure status. */
  private detectExplicitFailure(d: any): string | null {
    const raw = (d.status || d.orderStatus || '').toString().toUpperCase()
    if (['FAILED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(raw)) {
      return `AirHub reported purchase status ${raw}`
    }
    return null
  }

  private classifyHttpError(status: number, data: any): string {
    const msg = (data?.message || '').toLowerCase()
    if (status === 401 || status === 403) return 'AUTH_ERROR'
    if (status === 404) return 'NOT_FOUND'
    if (status === 429) return 'RATE_LIMITED'
    if (status === 402) return 'INSUFFICIENT_BALANCE'
    if (status === 400) {
      if (msg.includes('balance') || msg.includes('insufficient')) return 'INSUFFICIENT_BALANCE'
      if (msg.includes('plan') || msg.includes('package') || msg.includes('invalid')) return 'VALIDATION_ERROR'
      return 'VALIDATION_ERROR'
    }
    if (status >= 500) return 'PROVIDER_UNAVAILABLE'
    return 'PROVIDER_ERROR'
  }

  private classifyProviderError(data: any): string {
    const msg = (data.message || data.error || '').toLowerCase()
    if (msg.includes('auth') || msg.includes('login') || msg.includes('credential')) return 'AUTH_ERROR'
    if (msg.includes('balance') || msg.includes('insufficient') || msg.includes('credit')) return 'INSUFFICIENT_BALANCE'
    if (msg.includes('plan') || msg.includes('package') || msg.includes('sku')) return 'INVALID_PACKAGE'
    if (msg.includes('duplicate') || msg.includes('already') || msg.includes('exists')) return 'DUPLICATE_REQUEST'
    if (msg.includes('timeout') || msg.includes('unavailable') || msg.includes('maintenance')) return 'PROVIDER_UNAVAILABLE'
    return 'VALIDATION_ERROR'
  }

  /** Standard connector interface — delegates to AirHub's wallet endpoint */
  async getBalance(): Promise<ConnectorResult<{ balance: number | null; currency: string | null; accountId?: string | null; accountName?: string | null }>> {
    const result = await this.getWalletBalance()
    if (!result.success) return result as any
    return {
      success: true,
      data: { balance: result.data!.balance, currency: result.data!.currency, accountId: null, accountName: null },
    }
  }

  async getWalletBalance(): Promise<ConnectorResult<{ balance: number; currency: string; transactions?: any[]; rawAvailable?: any }>> {
    const tokenCheck = await this.ensureAuthenticated()
    if (!tokenCheck.success) return { success: false, error: tokenCheck.error || { code: 'NO_TOKEN', message: 'No token available' } }

    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }

    const cfg = (provider.config as any) || {}
    const partnerCode = cfg.partnerCode
    if (!partnerCode) return { success: false, error: { code: 'NO_PARTNER_CODE', message: 'Partner code not configured' } }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const flag = cfg.flag ?? 6
    const countryCode = cfg.countryCode ?? ''
    const multiplecountrycode = Array.isArray(cfg.multiplecountrycode) ? cfg.multiplecountrycode : ['UK']

    // Use the documented POST /api/ESIM/GetWallet endpoint
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/GetWallet`
    const body = { partnerCode: Number(partnerCode), flag, countryCode, multiplecountrycode }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 25000)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const text = await response.text()
      let data: any
      try { data = JSON.parse(text) } catch {
        return { success: false, error: { code: 'NON_JSON', message: 'Wallet response is not valid JSON' } }
      }

      // Guarded full-response diagnostics (off by default). No business logic.
      logBalanceDiagnostics('wallet', { httpStatus: response.status, data, partnerCode, token: this.token })

      if (response.status === 401) return { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }
      if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `Wallet fetch failed: HTTP ${response.status}` } }
      if (data.isSuccess === false) return { success: false, error: { code: 'PROVIDER_REJECTED', message: data.message || 'Provider rejected wallet request' } }

      // Safe diagnostic logging
      const topKeys = Object.keys(data)
      const nested = data.data && typeof data.data === 'object' ? Object.keys(data.data) : []
      console.log(`[AIRHUB_WALLET] httpStatus=${response.status} topKeys=${topKeys.join(',')} nestedKeys=${nested.join(',')}`)

      // Normalize the real { isSuccess, message, getwallet } shape (number | string | object | array | JSON string).
      const parse = normalizeAirHubWalletBalance(data, { fallbackCurrency: cfg.currency, partnerCode })
      let balanceRaw: number | null = parse.success ? parse.balance : null
      let balanceFieldPath = parse.success ? parse.balancePath : ''

      if (!parse.success) {
        const tryLegacy = async () => {
          const legUrl = `${baseUrl.replace(/\/$/, '')}/api/ESIM/get_wallet_invidual?partnercode=${encodeURIComponent(String(partnerCode))}`
          const lr = await fetch(legUrl, { headers: { 'Authorization': `Bearer ${this.token}`, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) })
          const lt = await lr.text(); try { return JSON.parse(lt) } catch { return null }
        }
        const legacy = await tryLegacy()
        if (legacy) {
          const legacyParse = normalizeAirHubWalletBalance(legacy, { fallbackCurrency: cfg.currency, partnerCode })
          if (legacyParse.success) {
            balanceRaw = legacyParse.balance
            balanceFieldPath = `legacy:get_wallet_invidual.${legacyParse.balancePath}`
          }
        }
      }

      if (balanceRaw == null) {
        return { success: false, error: { code: 'MALFORMED_RESPONSE', message: parse.reason || `No balance field found. Keys: ${topKeys.join(', ')}` } }
      }

      const balance = balanceRaw
      const currency = extractWalletCurrency(data, data.getwallet, cfg.currency)

      // Transaction history extraction
      const txFields = ['transactions', 'transactionHistory', 'transaction_history', 'walletHistory', 'wallet_history',
        'orders', 'orderHistory', 'order_history']
      let txArray: any[] | null = null
      for (const f of txFields) {
        if (Array.isArray(data[f])) { txArray = data[f]; break }
        if (Array.isArray(data.data?.[f])) { txArray = data.data[f]; break }
      }

      const transactions = txArray?.map((t: any, idx: number) => ({
        providerReference: String(t.reference || t.orderId || t.order_id || t.id || `tx-${idx}`),
        orderId: t.orderId || t.order_id || t.OrderID || null,
        occurredAt: t.date || t.transactionDate || t.createdAt || t.created_at || new Date().toISOString(),
        description: t.description || t.note || t.memo || t.Description || '',
        transactionType: normalizeTxType(t.type || t.transactionType || t.TransactionType || t.crDr || ''),
        amount: parseFloat(String(t.amount ?? t.Amount ?? t.value ?? 0)) || 0,
        currency: t.currency || t.Currency || currency,
        balanceBefore: t.balanceBefore != null ? parseFloat(String(t.balanceBefore)) : undefined,
        balanceAfter: t.balanceAfter != null ? parseFloat(String(t.balanceAfter)) : undefined,
        runningBalance: t.runningBalance != null ? parseFloat(String(t.runningBalance)) : undefined,
      })) || []

      console.log(`[AIRHUB_WALLET] balancePath=${balanceFieldPath} balanceType=${typeof balanceRaw} txCount=${transactions.length}`)

      return { success: true, data: { balance, currency, transactions, rawAvailable: data.available || data.data?.available || null } }
    } catch (e: any) {
      if (e.name === 'AbortError') return { success: false, error: { code: 'TIMEOUT', message: 'Wallet fetch timed out after 25 seconds' } }
      if (e?.cause?.code === 'ENOTFOUND') return { success: false, error: { code: 'DNS_ERROR', message: 'AirHub host not found' } }
      return { success: false, error: { code: 'NETWORK_ERROR', message: e.message?.substring(0, 100) || 'Network error' } }
    }
  }
}

function normalizeTxType(raw: string): string {
  const s = (raw || '').toUpperCase()
  if (['DEBIT', 'PURCHASE', 'ORDER', 'CHARGE', 'DEDUCTION', 'OUT'].includes(s)) return 'DEBIT'
  if (['CREDIT', 'REFUND', 'DEPOSIT', 'TOPUP', 'TOP_UP', 'ADD', 'IN'].includes(s)) return 'CREDIT'
  if (['ADJUSTMENT', 'ADJ', 'CORRECTION'].includes(s)) return 'ADJUSTMENT'
  return 'UNKNOWN'
}
