import type { StatusLookupIdentifier } from '@/lib/providers/connectors/connector-interface'

/** Best-effort extraction of the Choice `imsi_version` from persisted provider metadata. */
export function extractChoiceImsiVersion(providerResponse: any): string | number | undefined {
  if (!providerResponse || typeof providerResponse !== 'object') return undefined
  const candidates = [
    providerResponse.imsi_version,
    providerResponse.imsiVersion,
    providerResponse.package?.imsi_version,
    providerResponse.package?.imsiVersion,
    providerResponse.data?.imsi_version,
    providerResponse.data?.package?.imsi_version,
    providerResponse.response?.package?.imsi_version,
  ]
  for (const candidate of candidates) {
    if (candidate != null && String(candidate).trim() !== '') return candidate
  }
  return undefined
}

/**
 * Build the Choice status identifier with priority ICCID → IMSI → imsi_version.
 * Never falls back to a local OneSIM identifier (esim.id / purchase id).
 */
export function buildChoiceStatusLookup(esim: {
  iccid?: string | null
  imsi?: string | null
  providerResponse?: any
  status?: string | null
}): StatusLookupIdentifier {
  const lookup: StatusLookupIdentifier = {}
  const iccid = esim.iccid && String(esim.iccid).trim() ? String(esim.iccid).trim() : ''
  const imsi = esim.imsi && String(esim.imsi).trim() ? String(esim.imsi).trim() : ''
  const imsiVersion = extractChoiceImsiVersion(esim.providerResponse)

  if (iccid) lookup.iccid = iccid
  else if (imsi) lookup.imsi = imsi
  else if (imsiVersion != null) lookup.imsiVersion = imsiVersion

  if (esim.status && String(esim.status).trim()) lookup.currentStatus = String(esim.status).trim()
  return lookup
}

/** True when the Choice lookup carries a usable provider identifier (never a local id). */
export function hasChoiceIdentifier(lookup: StatusLookupIdentifier): boolean {
  return Boolean(
    (lookup.iccid && String(lookup.iccid).trim()) ||
    (lookup.imsi && String(lookup.imsi).trim()) ||
    (lookup.imsiVersion != null && String(lookup.imsiVersion).trim() !== ''),
  )
}
