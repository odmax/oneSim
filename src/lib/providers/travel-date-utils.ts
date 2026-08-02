/**
 * Travel-date requirement normalization for provider plans.
 *
 * Upstream plan feeds (e.g. AirHub `GetPlanInformation`) expose a per-plan
 * indicator of whether the purchase payload requires a `travelDate`. The field
 * name and value shape vary by provider, so this module normalizes the raw plan
 * metadata into a single provider-neutral boolean, `requiresTravelDate`.
 *
 * Persistence: the normalized boolean is stored on `ProviderPackage` inside the
 * existing `providerRawData` JSON field under the `__requiresTravelDate` key
 * (mirrors the `__syncSig` convention used by Telna). No schema migration.
 */

/** Explicit requirement fields — checked first and most specific. */
const TRAVEL_DATE_REQUIRED_KEYS = [
  'travelDateRequired',
  'isTravelDateRequired',
  'TravelDateRequired',
  'IsTravelDateRequired',
  'travelDateMandatory',
  'isTravelDateMandatory',
  'TravelDateMandatory',
  'travel_date_required',
]

/**
 * Ambiguous fields (a plan's `travelDate` may hold a sample/actual date rather
 * than a requirement flag). Only interpreted when the value is a boolean or one
 * of the known requirement tokens — never a date-looking string.
 */
const TRAVEL_DATE_AMBIGUOUS_KEYS = ['travelDate', 'travel_date', 'traveldate', 'TravelDate']

const TRUE_TOKENS = new Set([
  'mandatory',
  'required',
  'is required',
  'needed',
  'must',
  'true',
  'yes',
  '1',
])

const FALSE_TOKENS = new Set([
  'no need',
  'not required',
  'not needed',
  'optional',
  'not mandatory',
  'false',
  'no',
  '0',
  'none',
  'n/a',
  'na',
])

export const TRAVEL_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

/**
 * Strict `YYYY-MM-DD` validation. Rejects ISO timestamps, locale formats
 * (DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY), and impossible calendar dates.
 */
export function isValidTravelDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const s = value.trim()
  if (!TRAVEL_DATE_REGEX.test(s)) return false
  const [year, month, day] = s.split('-').map(Number)
  if (year < 1900 || year > 2200) return false
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function parseRequirementValue(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return undefined
  }
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === '') return undefined
    // A literal date is data, not a requirement indicator.
    if (TRAVEL_DATE_REGEX.test(s)) return undefined
    if (TRUE_TOKENS.has(s)) return true
    if (FALSE_TOKENS.has(s)) return false
    return undefined
  }
  return undefined
}

/**
 * Normalizes raw plan metadata into a `requiresTravelDate` boolean.
 * Never guesses: unknown field names/values resolve to `false` (no requirement),
 * which keeps fallback behavior safe — a globally-required travel date is never
 * invented.
 */
export function normalizeTravelDateRequirement(raw: any): boolean {
  if (!raw || typeof raw !== 'object') return false

  // Round-trip the stored normalized marker from a previous sync.
  if (typeof raw.__requiresTravelDate === 'boolean') return raw.__requiresTravelDate

  for (const key of TRAVEL_DATE_REQUIRED_KEYS) {
    if (key in raw) {
      const parsed = parseRequirementValue(raw[key])
      if (parsed !== undefined) return parsed
    }
  }
  for (const key of TRAVEL_DATE_AMBIGUOUS_KEYS) {
    if (key in raw) {
      const parsed = parseRequirementValue(raw[key])
      if (parsed !== undefined) return parsed
    }
  }
  return false
}

/**
 * Reads the requirement from a package's persisted metadata (and defensively
 * from the package object itself).
 */
export function requiresTravelDateForPackage(pkg: { providerRawData?: any; [key: string]: any } | null | undefined): boolean {
  if (!pkg) return false
  if (typeof pkg.providerRawData === 'object' && pkg.providerRawData !== null) {
    const fromRaw = normalizeTravelDateRequirement(pkg.providerRawData)
    if (fromRaw) return true
  }
  return normalizeTravelDateRequirement(pkg)
}

/** Wraps a normalized boolean into a persistable raw payload. */
export function withTravelDateMarker(raw: any, requiresTravelDate: boolean): any {
  const base = raw && typeof raw === 'object' ? { ...raw } : {}
  return { ...base, __requiresTravelDate: requiresTravelDate }
}
