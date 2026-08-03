/**
 * Shared, provider-neutral monetary parsing used by provider wallet/balance
 * normalization (AirHub, Choice, and any future provider).
 *
 * Only the parsing primitives live here; each provider keeps its own
 * response-shape normalization so behavior stays provider-specific.
 */

/** Human-readable type of a value for safe, key-only error messages. */
export function describeDiagnosticValue(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'missing'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'object') return 'object'
  if (typeof v === 'string') return v.trim() ? 'string' : 'empty string'
  if (typeof v === 'number') return isFinite(v) ? 'number' : 'NaN'
  return typeof v
}

const CURRENCY_CODE_MAP: Record<string, string> = {
  USD: 'USD', EUR: 'EUR', GBP: 'GBP', ZAR: 'ZAR',
  NGN: 'NGN', KES: 'KES', GHS: 'GHS', XOF: 'XOF', XAF: 'XAF',
  CAD: 'CAD', AUD: 'AUD', CHF: 'CHF', CNY: 'CNY', JPY: 'JPY', INR: 'INR',
  ZMW: 'ZMW', MWK: 'MWK', ETB: 'ETB', TZS: 'TZS', UGX: 'UGX', RWF: 'RWF',
  BWP: 'BWP', MZN: 'MZN', CDF: 'CDF', ZWL: 'ZWL', GMD: 'GMD', LRD: 'LRD', SLL: 'SLL',
}

interface ParsedMonetaryValue {
  value: number | null
  currency: string | null
}

/**
 * Safely parses a numeric or currency-formatted balance string.
 * Accepts "$0.00", "$5.00", "USD 5.00", "5.00 USD", "1,250.50", "$1,250.50", "  $5.00  ".
 * Rejects "NA", "N/A", "", null, undefined, NaN, "$", "USD", and non-numeric text.
 * Recognized symbols: $→USD, €→EUR, £→GBP, R→ZAR (only as a prefix like "R 100.00").
 * The final normalized string must validate as a plain decimal before conversion.
 */
export function parseMonetaryValue(raw: unknown): ParsedMonetaryValue {
  if (typeof raw === 'number') {
    return isFinite(raw) ? { value: raw, currency: null } : { value: null, currency: null }
  }
  if (typeof raw !== 'string') return { value: null, currency: null }

  let s = raw.trim()
  if (!s) return { value: null, currency: null }
  const upper = s.toUpperCase()
  if (upper === 'NA' || upper === 'N/A') return { value: null, currency: null }

  let currency: string | null = null

  // Symbol prefixes/suffixes: $ € £
  const symbols: Array<[string, string]> = [
    ['$', 'USD'],
    ['€', 'EUR'],
    ['£', 'GBP'],
  ]
  for (const [sym, code] of symbols) {
    if (s.startsWith(sym) || s.endsWith(sym)) {
      currency = code
      s = s.split(sym).join('')
    }
  }

  // R → ZAR only when clearly a currency prefix such as "R 100.00"
  if (currency == null && /^R\s+[-]?\d/.test(s)) {
    currency = 'ZAR'
    s = s.replace(/^R\s+/, '')
  }

  // Leading/trailing ISO-4217-style code, only when it is a recognized code
  if (currency == null) {
    const lead = upper.match(/^([A-Z]{3})(?:\s|$)/)
    const trail = upper.match(/([A-Z]{3})$/)
    const code = (lead && lead[1]) || (trail && trail[1]) || null
    if (code && CURRENCY_CODE_MAP[code]) {
      currency = CURRENCY_CODE_MAP[code]
      s = s.replace(new RegExp(`^${code}\\s*|\\s*${code}$`, 'i'), '')
    }
  }

  // Thousands separators (commas), then final validation
  s = s.replace(/,/g, '').trim()
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { value: null, currency: null }
  const n = Number(s)
  return Number.isNaN(n) ? { value: null, currency: null } : { value: n, currency }
}
