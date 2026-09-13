/**
 * Canonical, provider-neutral OneSIM public SKU implementation.
 *
 * OneSIM exposes a PRODUCT identity, never an upstream-provider identity. The
 * public SKU therefore NEVER contains a provider code/name, connector type,
 * provider DB id, provider plan/package id, or upstream product code.
 *
 * Format:
 *   OS-{COUNTRY_OR_REGION}-{DATA}GB-{VALIDITY}D-{STABLE_SUFFIX}
 *   e.g. OS-ZA-5GB-30D-X7K29P   OS-XX-35GB-30D-AJ33VU
 *
 * Deterministic + stable: the same retail package produces the same public SKU
 * on every request and across browser preview, JSON/CSV/XLSX exports, and the
 * public catalog/API. The suffix is a stable slice of an INTERNAL id (the
 * ProviderPackage id, else the retail package id) — a random cuid, so it never
 * encodes provider identity and cannot be used to infer the upstream provider.
 *
 * Persisted SKUs from the legacy format (e.g. `OS-AIRHUB-...`) remain RESOLVABLE
 * internally (see resolvePackageIdentifier) but are never surfaced here.
 */

export interface PublicSkuSource {
  /** Retail eSIMPackage id (fallback suffix seed). */
  id: string
  /** ProviderPackage id — an internal random cuid, used as the stable suffix seed. */
  providerPackageId?: string | null
  dataGB: number
  validityDays: number
  country?: string | null
  region?: string | null
}

export const PUBLIC_SKU_PREFIX = 'OS-'

/** Normalize a country/region code to a neutral short token (never provider data). */
function normalizeGeo(value: string | null | undefined): string {
  const s = (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return s.slice(0, 3) || 'XX'
}

/** FNV-1a 32-bit — deterministic, stable, non-invertible short hash. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Stable, provider-neutral 6-char suffix from an internal id. A deterministic
 * HASH of the id is used (not a raw slice) so that even a pathological
 * internal id can never surface a provider word, name, plan, or package token
 * in the public SKU.
 */
function stableSuffix(seed: string): string {
  const h1 = fnv1a(`onesim-public-sku:${seed}`).toString(36).toUpperCase()
  const h2 = fnv1a(`onesim-public-sku:${seed}:salt`).toString(36).toUpperCase()
  return (h1 + h2).slice(0, 6).toUpperCase().padEnd(6, 'Z')
}

/**
 * Derive the canonical provider-neutral public SKU for a retail package.
 * This function is the SINGLE source of truth consumed by every client-facing
 * surface (SKU Downloads page + JSON/CSV/XLSX, the public API catalog, the
 * business developer guide, and the test console).
 */
export function derivePublicSku(src: PublicSkuSource): string {
  const geo = normalizeGeo(src.country || src.region)
  const dataGB = Math.max(1, Math.round(Number(src.dataGB) || 0))
  const validity = Math.max(1, Math.round(Number(src.validityDays) || 0))
  const seed = String(src.providerPackageId || src.id || '')
  return `${PUBLIC_SKU_PREFIX}${geo}-${dataGB}GB-${validity}D-${stableSuffix(seed)}`
}