/**
 * Shared installation/QR-data helpers.
 *
 * These functions are intentionally free of Prisma and of any provider
 * knowledge: they operate only on the normalized ESIM installation columns
 * (`qrCode`, `qrCodeUrl`, `activationCode`, `smdpAddress`, `matchingId`) and
 * on the whitelisted subset of `providerResponse` that may be promoted into
 * those columns. `providerResponse` itself stays internal/diagnostic and is
 * never surfaced through these helpers.
 */

export interface InstallDataFields {
  activationCode?: string | null
  qrCodeUrl?: string | null
  qrCode?: string | null
  smdpAddress?: string | null
  matchingId?: string | null
}

export interface ProviderInstallData {
  activationCode?: string
  qrCodeUrl?: string
  qrCode?: string
  smdpAddress?: string
  matchingId?: string
}

/**
 * Input shape for install data already normalized by a connector/adapter/webhook
 * layer. Provider-specific field names must be normalized before this point;
 * this helper only reconciles plural/singular and strips falsy values.
 */
export interface ConnectorInstallDataInput {
  activationCode?: unknown
  activationCodes?: unknown
  qrCodeUrl?: unknown
  qrCodeUrls?: unknown
  qrCode?: unknown
  smdpAddress?: unknown
  matchingId?: unknown
}

const str = (v: unknown): string | undefined => v == null ? undefined : String(v)
const firstOf = (v: unknown): unknown => Array.isArray(v) && v.length > 0 ? v[0] : undefined

/**
 * Normalize connector/webhook install data into the canonical shape. Reads only
 * the five canonical keys (plus the plural `activationCodes`/`qrCodeUrls`
 * arrays) and drops empty values. Never maps a field into a semantically
 * different column — e.g. an SM-DP+ address stays `smdpAddress` and a QR URL
 * stays `qrCodeUrl`.
 */
export function normalizeConnectorInstallData(raw: ConnectorInstallDataInput | null | undefined): ProviderInstallData {
  if (!raw || typeof raw !== 'object') return {}
  const out: ProviderInstallData = {}
  const activationCode = str(firstOf(raw.activationCodes)) || str(raw.activationCode)
  if (activationCode) out.activationCode = activationCode
  const qrCodeUrl = str(raw.qrCodeUrl) || str(firstOf(raw.qrCodeUrls))
  if (qrCodeUrl) out.qrCodeUrl = qrCodeUrl
  const qrCode = str(raw.qrCode)
  if (qrCode) out.qrCode = qrCode
  const smdpAddress = str(raw.smdpAddress)
  if (smdpAddress) out.smdpAddress = smdpAddress
  const matchingId = str(raw.matchingId)
  if (matchingId) out.matchingId = matchingId
  return out
}

/**
 * True when the eSIM carries any usable install payload: a QR payload, a QR
 * URL, an activation code/LPA string, or a complete manual-install pair
 * (SM-DP+ address AND matching ID). An SM-DP+ address alone is not enough to
 * install manually.
 */
export function hasUsableInstallData(fields: InstallDataFields | null | undefined): boolean {
  if (!fields) return false
  if (fields.qrCode || fields.qrCodeUrl || fields.activationCode) return true
  return Boolean(fields.smdpAddress && fields.matchingId)
}

/** Map the presence of install data to an installationStatus value. */
export function installationStatusFromData(fields: InstallDataFields | null | undefined): 'READY' | 'PENDING' {
  return hasUsableInstallData(fields) ? 'READY' : 'PENDING'
}

/**
 * Whitelist extraction of install data from `providerResponse`. Only known
 * keys are read (including a nested `activationData` object); everything else
 * in the provider payload is ignored. Never throws.
 */
export function extractInstallDataFromProviderResponse(raw: unknown): ProviderInstallData {
  let data: any = raw
  if (data == null) return {}
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { return {} }
  }
  if (!data || typeof data !== 'object') return {}

  const activationCode = str(data.activationCode) || str(data.activation_code)
  const lpa = str(data.lpa) || str(data.LPA) || str(data.lpaProfile)
  const qrCodeUrl = str(data.qrCodeUrl) || str(data.qr_code_url) || str(data.qr_code_link)
  const qrCode = str(data.qrCode) || str(data.qr_code) || str(data.qrCodeValue) || str(data.qrCodeData)
  const smdpAddress = str(data.smdpAddress) || str(data.smdp_address) || str(data.smdp) || str(data.SMDP)
  const matchingId = str(data.matchingId) || str(data.matching_id) || str(data.matchingid)

  const nested = data.activationData && typeof data.activationData === 'object' ? data.activationData : undefined
  const resolvedCode = activationCode || lpa
    || (nested && (str(nested.activationCode) || str(nested.activation_code) || str(nested.lpa) || str(nested.LPA) || str(nested.lpaProfile)))

  const result: ProviderInstallData = {}
  if (resolvedCode) result.activationCode = String(resolvedCode)
  const resolvedQrUrl = qrCodeUrl || (nested && str(nested.qrCodeUrl)) || (nested && str(nested.qr_code_url))
  if (resolvedQrUrl) result.qrCodeUrl = String(resolvedQrUrl)
  const resolvedQr = qrCode || (nested && str(nested.qrCode)) || (nested && str(nested.qr_code))
  if (resolvedQr) result.qrCode = String(resolvedQr)
  const resolvedSmdp = smdpAddress || (nested && str(nested.smdpAddress)) || (nested && str(nested.smdp)) || (nested && str(nested.smdp_address))
  if (resolvedSmdp) result.smdpAddress = String(resolvedSmdp)
  const resolvedMatching = matchingId || (nested && str(nested.matchingId)) || (nested && str(nested.matching_id))
  if (resolvedMatching) result.matchingId = String(resolvedMatching)
  return result
}

/**
 * Merge extracted install data into an existing eSIM's fields. Only fills
 * missing values; never overwrites existing data with null/empty.
 */
export function mergeInstallData(existing: InstallDataFields | null | undefined, source: ProviderInstallData): InstallDataFields {
  const out: InstallDataFields = {}
  const pairs: Array<{ key: keyof ProviderInstallData; target: keyof InstallDataFields }> = [
    { key: 'activationCode', target: 'activationCode' },
    { key: 'qrCodeUrl', target: 'qrCodeUrl' },
    { key: 'qrCode', target: 'qrCode' },
    { key: 'smdpAddress', target: 'smdpAddress' },
    { key: 'matchingId', target: 'matchingId' },
  ]
  for (const pair of pairs) {
    const value = source[pair.key]
    const current = existing ? existing[pair.target] : undefined
    if (value && !current) out[pair.target] = value
  }
  return out
}
