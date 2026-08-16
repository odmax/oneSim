/**
 * Reusable admin display sanitizer for the eSIM `providerResponse` JSON blob.
 *
 * `providerResponse` is the connector-owned metadata blob. Connectors sanitize
 * it at write time, but a future connector could add new fields — so rendering
 * the raw JSON is fragile. This helper renders ONLY a whitelisted set of
 * top-level keys, masks provider identifier values, and recursively drops
 * secret-shaped keys inside nested objects/arrays.
 *
 * NEVER renders: token/password/authorization/secret, activationCode /
 * qrcodeString / qrCode / LPA payload, PIN/PUK/ADM, full ICCID/IMSI/EID, or raw
 * provider payloads containing credentials.
 */

/** Top-level keys that are safe to render (plus whitelisted identifier keys). */
const SAFE_TOP_LEVEL_KEYS = new Set([
  'source',
  'reason',
  'networkAttached',
  'deviceInstalled',
  'networkType',
  'servingNetwork',
  'countryNetwork',
  'observedAt',
  'evidenceObservedAt',
  'assignedAt',
  'evidence',
  'profileLogStates',
  'package_status',
  'status',
  'providerStatus',
  'rateGroupCount',
  'earliestStart',
  'latestExpire',
  'daysUsed',
  'providerEsimId',
  'packageEsimId',
  'package_esim_id',
])

/** Identifier values that must be MASKED, never rendered in full. */
const MASKED_ID_KEYS = new Set([
  'providerEsimId',
  'packageEsimId',
  'package_esim_id',
  'providerSubscriptionId',
  'providerActivationId',
])

/** Defense-in-depth: nested keys that look like credentials are dropped. */
const SECRET_KEY_RE = /token|pass(word|phrase)|authorization|secret|pin|puk|\badm\b|credential|qrcode|qr_?code|lpa|activation.?code|\beid\b|\biccid\b|\bimsi\b/i

/** Mask a provider identifier value (e.g. UUID): `abcd••••wxyz`. */
export function maskIdentifier(value: unknown): string {
  const s = value == null ? '' : String(value)
  if (!s) return ''
  if (s.length <= 8) return '••••'
  return `${s.slice(0, 4)}••••${s.slice(-4)}`
}

function sanitizeValue(value: unknown): unknown {
  if (value == null) return value
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key)) continue
      if (MASKED_ID_KEYS.has(key)) out[key] = maskIdentifier(val)
      else out[key] = sanitizeValue(val)
    }
    return out
  }
  return value
}

/**
 * Build the safe display object for an eSIM's providerResponse. Returns {} for
 * null/non-object input or when nothing safe is present.
 */
export function getSafeProviderResponseForDisplay(providerResponse: unknown): Record<string, unknown> {
  if (!providerResponse || typeof providerResponse !== 'object' || Array.isArray(providerResponse)) return {}

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(providerResponse as Record<string, unknown>)) {
    if (!SAFE_TOP_LEVEL_KEYS.has(key)) continue
    if (MASKED_ID_KEYS.has(key)) out[key] = maskIdentifier(value)
    else out[key] = sanitizeValue(value)
  }
  return out
}
