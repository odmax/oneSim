/**
 * Shared, provider-neutral balance response normalization.
 *
 * Used by the Choice connector (and available to any provider whose balance
 * endpoint returns an unknown JSON shape). The extraction rules below probe any
 * shape: number, numeric string, currency-formatted string, nested object,
 * single-item array, or JSON-encoded string. Zero is a valid balance.
 */
import { describeDiagnosticValue, parseMonetaryValue } from './monetary'

export { describeDiagnosticValue }

export interface NormalizedBalance {
  success: boolean
  balance: number
  currency: string
  balancePath: string
  valueType: string
  reason?: string
}

export interface BalanceNormalizeOptions {
  balanceKeys?: string[]
  currencyKeys?: string[]
  fallbackCurrency?: string | null
}

/** Field names probed recursively at any depth, in priority order. */
export const DEFAULT_BALANCE_KEYS = [
  'balance', 'Balance', 'prepaid_balance', 'prepaidBalance', 'PrepaidBalance',
  'current_prepaid_balance', 'currentPrepaidBalance',
  'availableBalance', 'available_balance', 'available',
  'wallet', 'walletBalance', 'wallet_balance',
  'credit', 'amount',
  'runningBalance', 'running_balance', 'currentBalance', 'current_balance',
  'totalBalance', 'total_balance',
  'data', 'response',
]

const DEFAULT_CURRENCY_KEYS = ['currency', 'currencyCode', 'currency_code', 'Currency']

/**
 * Keys whose values are masked case-insensitively in diagnostics (structure is kept).
 * Superset covering tokens, auth, credentials, and PII so no provider-specific
 * list is needed.
 */
const SENSITIVE_KEY_TERMS = [
  'token', 'authorization', 'password', 'secret', 'apikey', 'x-api-key', 'keyhash',
  'activationcode', 'lpa', 'iccid', 'imsi', 'email', 'phone', 'mobile', 'msisdn',
  'traceid', 'cookie', 'header',
]

export function sanitizeDiagnosticSensitive(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map((v) => (v && typeof v === 'object' ? sanitizeDiagnosticSensitive(v) : v))
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    const sensitive = SENSITIVE_KEY_TERMS.some((term) => k.toLowerCase().includes(term))
    if (sensitive) { out[k] = '[REDACTED]'; continue }
    out[k] = v && typeof v === 'object' ? sanitizeDiagnosticSensitive(v) : v
  }
  return out
}

const BALANCE_FIELD_ALIASES: Record<string, string> = {
  balance: 'balance',
  currentbalance: 'balance',
  walletbalance: 'balance',
  prepaidbalance: 'prepaidBalance',
  prepaid_balance: 'prepaidBalance',
  current_prepaid_balance: 'current_prepaid_balance',
  currentprepaidbalance: 'current_prepaid_balance',
  wallet: 'wallet',
  availablebalance: 'availableBalance',
  available: 'availableBalance',
  credit: 'credit',
  amount: 'amount',
  accountid: 'accountId',
  account: 'accountId',
  customerid: 'accountId',
  partnercode: 'partnerCode',
}

/** Collects only balance-like fields at any depth, for key-only diagnostics. */
export function probeBalanceFields(data: any): Record<string, unknown> {
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

/** Recursively finds a numeric balance inside a value (number, monetary/numeric string, object, array, JSON string). */
export function extractBalanceValue(
  node: unknown,
  keys: string[],
  depth = 0,
): { raw: number; currency: string | null; path: string } | null {
  if (node == null || depth > 4) return null
  const direct = parseMonetaryValue(node)
  if (direct.value !== null) return { raw: direct.value, currency: direct.currency, path: '$' }
  if (typeof node === 'string') {
    const t = node.trim()
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t)
        return extractBalanceValue(parsed, keys, depth + 1)
      } catch { return null }
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    if (node.length === 0) return null
    const first = extractBalanceValue(node[0], keys, depth + 1)
    return first ? { raw: first.raw, currency: first.currency, path: `[0]${first.path === '$' ? '' : '.' + first.path}` } : null
  }
  for (const key of keys) {
    if (!(key in node)) continue
    const inner = extractBalanceValue((node as any)[key], keys, depth + 1)
    if (inner) return { raw: inner.raw, currency: inner.currency, path: inner.path === '$' ? key : `${key}.${inner.path}` }
  }
  return null
}

/** Reads a currency from a node, preferring top-level and a few known containers. */
function findCurrency(node: unknown, keys: string[], depth = 0): string | null {
  if (!node || typeof node !== 'object' || depth > 3) return null
  for (const key of keys) {
    const v = (node as any)[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  for (const sub of ['data', 'response', 'wallet']) {
    const nested = (node as any)[sub]
    if (nested && typeof nested === 'object') {
      const found = findCurrency(nested, keys, depth + 1)
      if (found) return found
    }
  }
  return null
}

/**
 * Normalizes an arbitrary balance response into { balance, currency }.
 * Currency priority: response-returned currency → symbol/code parsed from the
 * balance string → provider-configured default → USD.
 * On failure the reason only contains the detected response value type.
 */
export function normalizeBalanceResponse(
  data: unknown,
  opts?: BalanceNormalizeOptions,
): NormalizedBalance {
  const balanceKeys = opts?.balanceKeys || DEFAULT_BALANCE_KEYS
  const currencyKeys = opts?.currencyKeys || DEFAULT_CURRENCY_KEYS
  const fallback = opts?.fallbackCurrency ?? null
  const root = data ?? {}
  const valueType = describeDiagnosticValue(root)

  const extracted = extractBalanceValue(root, balanceKeys)
  if (!extracted) {
    return {
      success: false,
      balance: 0,
      currency: fallback ? String(fallback) : 'USD',
      balancePath: '',
      valueType,
      reason: `No numeric balance field found (response is ${valueType})`,
    }
  }

  const currency =
    findCurrency(root, currencyKeys) ||
    extracted.currency ||
    (fallback ? String(fallback) : null) ||
    'USD'

  return {
    success: true,
    balance: extracted.raw,
    currency,
    balancePath: extracted.path,
    valueType,
  }
}
