import { createHash } from 'node:crypto'

/**
 * Canonical request fingerprint for Mode B (UPSTREAM_CREATE).
 *
 * The fingerprint covers ONLY mutation-critical fields that change the upstream
 * object. UI-only labels, timestamps, sessions, admin display names, and
 * transient ordering noise are excluded.
 *
 * Canonicalization:
 *  - object keys sorted recursively
 *  - strings trimmed + whitespace-collapsed
 *  - numbers normalized (finite, as canonical decimal string)
 *  - booleans as 'true'/'false'
 *  - arrays sorted when order is semantically irrelevant (flag-controlled)
 */
export interface FingerprintSource {
  providerId: string
  /** Provider-side SKU (bundle_code) — this identifies the upstream object. */
  sku: string
  /** Provider-side package/template name. */
  bundleName: string
  /** Data allowance in GB. */
  dataGB: number
  /** Validity in days. */
  validityDays: number
  /** Which unit Choice expects for rate_group_allow_qtyp (e.g. 'GB'). */
  allowQtyp: string
  /** Pool (required by Choice). */
  pool: number | string | null
  /** Roaming profile id (or empty). */
  roamingProfileId?: string | null
  /** Serving networks config (or empty). */
  servingNetworks?: string | null
  /** Occurrences (or null). */
  occurrences?: number | null
  /** Throttle / tethering flags. */
  allowThrottle?: boolean
  allowTethering?: boolean
  /** Any other provider field that alters the upstream object (allowlist pattern). */
  additional?: Record<string, unknown>
}

function normalizeString(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim().replace(/\s+/g, ' ')
}

function normalizeNumber(value: unknown): string {
  if (value === null || value === undefined) return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  return String(n)
}

function normalizeElement(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return normalizeString(value)
  if (typeof value === 'number') return normalizeNumber(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    // Sort arrays when order is semantically irrelevant (scalar arrays only).
    if (value.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      return value.map(normalizeElement).sort()
    }
    return value.map(normalizeElement)
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeElement((value as Record<string, unknown>)[key])
    }
    return out
  }
  return String(value)
}

/** Build the canonical JSON string for a fingerprint source. */
export function canonicalizeUpstreamRequest(source: FingerprintSource): string {
  const payload: Record<string, unknown> = {
    providerId: normalizeString(source.providerId),
    sku: normalizeString(source.sku),
    bundleName: normalizeString(source.bundleName),
    dataGB: normalizeNumber(source.dataGB),
    validityDays: normalizeNumber(source.validityDays),
    allowQtyp: normalizeString(source.allowQtyp || 'GB'),
    pool: source.pool != null ? normalizeElement(source.pool) : null,
    roamingProfileId: source.roamingProfileId ? normalizeString(source.roamingProfileId) : null,
    servingNetworks: source.servingNetworks ? normalizeString(source.servingNetworks) : null,
    occurrences: source.occurrences != null ? normalizeNumber(source.occurrences) : null,
    allowThrottle: source.allowThrottle != null ? (source.allowThrottle ? 'true' : 'false') : null,
    allowTethering: source.allowTethering != null ? (source.allowTethering ? 'true' : 'false') : null,
    additional: source.additional && Object.keys(source.additional).length > 0 ? normalizeElement(source.additional) : null,
  }
  return JSON.stringify(normalizeElement(payload))
}

/** SHA-256 hex fingerprint of the canonicalized upstream request. */
export function computeUpstreamFingerprint(source: FingerprintSource): string {
  return createHash('sha256').update(canonicalizeUpstreamRequest(source)).digest('hex')
}