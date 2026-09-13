/**
 * Canonical provider-neutral PUBLIC package presentation (text fields).
 *
 * Provider confidentiality must apply not only to SKU/identifier fields but also
 * to client-facing textual metadata: name, displayName, description and
 * customerDescription. This module is the SINGLE component that converts
 * provider-authored (possibly provider-branded) package copy into a
 * provider-neutral public presentation, consumed by every client-facing
 * serializer/exporter/page/API.
 *
 * Sanitization is **provider-aware** (fail closed for newly-connected providers
 * whose name was copied into a package name): the token set is built from the
 * ACTUAL internal provider identity passed in (provider.name / provider.code /
 * persisted providerName) PLUS a static safety-net alias list for the known
 * provider families. Provider identity is used ONLY to remove tokens — it is
 * never returned.
 *
 * Fallback: if sanitization cannot produce a useful public name, a neutral
 * product name is generated from safe product attributes
 * (region/country, dataGB, validityDays). Manually curated provider-neutral
 * customer copy (displayName / customerDescription that are already clean) is
 * preserved unchanged.
 */

const KNOWN_PROVIDER_ALIASES = [
  'AIRHUB',
  'AIRHUB OUTREACH',
  'CHOICE',
  'CHOICE WIRELESS',
  'TELNA',
  'IBASIS',
  '24MOBILE',
  '24 MOBILE',
  '24MOBILECONNECT',
  '24 MOBILE CONNECT',
  'USMATRIX',
  'US MATRIX',
  'US-MATRIX',
  'USMATRIX CONNECT',
]

export interface PublicPackagePresentationInput {
  name?: string | null
  displayName?: string | null
  description?: string | null
  customerDescription?: string | null
  country?: string | null
  region?: string | null
  dataGB?: number | null
  validityDays?: number | null
  productType?: string | null
  /** Internal provider identity used ONLY for sanitization — never returned. */
  provider?: { name?: string | null; code?: string | null } | null
  /** Persisted providerName fallback (ESIMPackage.providerName). */
  providerName?: string | null
}

export interface PublicPackagePresentation {
  name: string
  displayName: string | null
  description: string | null
  customerDescription: string | null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Normalize a provider token variant (strip spaces/underscores/dashes). */
function variantsOf(token: string): string[] {
  const t = token.trim()
  if (!t) return []
  const normalized = t.replace(/[\s_-]+/g, '')
  const out = new Set<string>()
  out.add(t)
  if (normalized !== t) out.add(normalized)
  return Array.from(out)
}

export function buildProviderTokens(provider?: { name?: string | null; code?: string | null } | null, providerName?: string | null): string[] {
  const set = new Set<string>()
  for (const alias of KNOWN_PROVIDER_ALIASES) for (const v of variantsOf(alias)) set.add(v)
  const identityTokens = [provider?.code, provider?.name, providerName]
  for (const t of identityTokens) if (t && typeof t === 'string') for (const v of variantsOf(t)) set.add(v)
  // Longest-first so e.g. "24 Mobile Connect" is removed before "24 Mobile".
  return Array.from(set).sort((a, b) => b.length - a.length)
}

const LEADING_POWERS = /^(?:powered\s+by|provided\s+by|branded\s+by|by)\b/gi

export function sanitizePublicText(text: string | null | undefined, provider?: { name?: string | null; code?: string | null } | null, providerName?: string | null): string {
  if (!text) return ''
  let s = String(text)
  for (const token of buildProviderTokens(provider, providerName)) {
    // Whole-token removal with word boundaries (case-insensitive).
    s = s.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'gi'), ' ')
  }
  // Collapse spaces and strip leading/trailing separators left by removal.
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/^(?:[\s\-|:.,/]+)/, '').replace(/(?:[\s\-|:.,/]+)$/, '').trim()
  s = s.replace(LEADING_POWERS, '').trim()
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

function geoLabel(country?: string | null, region?: string | null): string {
  const raw = (region || country || '').trim()
  return raw.replace(/[^\p{L}\p{N}\s-]/gu, '').trim() || 'Global'
}

export function neutralPublicName(input: PublicPackagePresentationInput): string {
  const geo = geoLabel(input.country, input.region)
  const dataGB = Math.max(1, Math.round(Number(input.dataGB) || 0))
  const validity = Math.max(1, Math.round(Number(input.validityDays) || 0))
  return `OneSIM ${geo} - ${dataGB}GB - ${validity}D`
}

/**
 * Derive the canonical provider-neutral public presentation for a retail
 * package. Deterministic and stable; the same package yields the same public
 * text on every surface.
 */
export function derivePublicPackagePresentation(input: PublicPackagePresentationInput): PublicPackagePresentation {
  const provider = input.provider || null

  const nameRaw = sanitizePublicText(input.name, provider, input.providerName) || neutralPublicName(input)
  const displayNameRaw = input.displayName
    ? sanitizePublicText(input.displayName, provider, input.providerName) || nameRaw
    : nameRaw

  const description = input.description ? sanitizePublicText(input.description, provider, input.providerName) : ''
  const customerDescription = input.customerDescription ? sanitizePublicText(input.customerDescription, provider, input.providerName) : ''

  return {
    name: nameRaw,
    displayName: displayNameRaw || null,
    description: description || null,
    customerDescription: customerDescription || null,
  }
}