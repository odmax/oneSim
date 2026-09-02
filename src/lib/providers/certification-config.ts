/**
 * PROVIDER CERTIFICATION CONFIG MODEL (READ-ONLY)
 *
 * Typed shape of `provider.config.certification`, persisted as part of the
 * existing Provider.config JSON — NO schema change (mirrors execution-policy).
 *
 * PURPOSE: safely separate the OneSIM deployment environment from the provider
 * endpoint class, and gate CONTROLLED_LIVE_TEST certification behind an explicit
 * typed authorization. This phase performs NO provider HTTP, NO purchases, and
 * NO DB writes: the config is consumed only by the readiness preflight to
 * decide whether a certification MAY proceed.
 *
 * FAIL-CLOSED INVARIANTS:
 *  - The OneSIM environment is NEVER derived from the provider environment and
 *    vice-versa. `onesimEnvironment` comes from APP_ENV; `providerEndpointClass`
 *    from the provider upstream metadata. They are independent dimensions.
 *  - A LIVE/unknown provider WITHOUT an explicit `testAuthorization` block is
 *    BLOCKED for CONTROLLED_LIVE_TEST. A provider name "(Staging)", status
 *    TESTING, package name "TEST", `_productionUrlPending`, APP_ENV, or a host
 *    containing "test" NEVER alone authorize CONTROLLED_LIVE_TEST.
 *  - `evidenceReference` is a SAFE reference/ticket id ONLY. It must never hold
 *    raw emails, credentials, tokens, activation codes, or attachments.
 */

export type OneSIMEnvironment = 'STAGING' | 'TEST' | 'PRODUCTION' | 'UNKNOWN'

export type ProviderEndpointClass = 'SANDBOX' | 'LIVE' | 'UNKNOWN'

export type CertificationMode = 'SANDBOX' | 'CONTROLLED_LIVE_TEST' | 'UNKNOWN'

/** Only CONTROLLED_LIVE_TEST (real purchase spend) uses a typed authorization. */
export type TestAuthorizationType = 'CONTROLLED_LIVE_TEST'

/**
 * Typed operator authorization to run a CONTROLLED_LIVE_TEST certification.
 * SAFE fields only. `evidenceReference` = ticket/request id (no secrets).
 */
export interface ProviderTestAuthorization {
  type: TestAuthorizationType
  /** ISO timestamp when an operator approved controlled live testing. */
  approvedAt: string
  /** Internal operator id (ANALYTICS/MANAGER/role holder) who approved. */
  approvedBy: string
  /** Safe ticket/request reference. NEVER raw emails/credentials/tokens. */
  evidenceReference: string
  /** Canonical ProviderPackage.id values the operator pinned. Exact match, no
   *  fallback/cheapest/alias resolution. Empty/non-matching ⇒ no approved. */
  approvedPackageIds: string[]
  /** Operator-approved count of real purchases against a LIVE endpoint. */
  maxRealPurchases: number
  /** Operator-approved monetary ceiling (in the package cost currency). */
  maxProviderSpend: number
}

/** Typed `provider.config.certification`. */
export interface ProviderCertificationConfig {
  /** Modes this provider is permitted to attempt. Default: SANDBOX only. */
  allowedModes?: CertificationMode[]
  /** Required for CONTROLLED_LIVE_TEST; optional/ignored for SANDBOX. */
  testAuthorization?: ProviderTestAuthorization
}

export const CERTIFICATION_ALLOWED_MODES = {
  SANDBOX: 'SANDBOX',
  CONTROLLED_LIVE_TEST: 'CONTROLLED_LIVE_TEST',
} as const

/**
 * Normalize a raw `provider.config.certification` payload. Invalid values fall
 * back to SAFE defaults (never to a permissive state). Missing `allowedModes`
 * resolves to SANDBOX-only; missing `testAuthorization` resolves to undefined
 * (which anyway fails CONTROLLED_LIVE_TEST closed).
 */
export function normalizeProviderCertificationConfig(raw: unknown): ProviderCertificationConfig {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: ProviderCertificationConfig = {}

  const rawModes = cfg.allowedModes
  if (Array.isArray(rawModes)) {
    const sanitized = [...new Set(rawModes.map((m) => String(m)))] as CertificationMode[]
    const known = sanitized.filter((m) => m === 'SANDBOX' || m === 'CONTROLLED_LIVE_TEST')
    if (known.length > 0) out.allowedModes = known
  }

  const authRaw = cfg.testAuthorization
  if (authRaw && typeof authRaw === 'object') {
    const a = authRaw as Record<string, unknown>
    if (a.type === 'CONTROLLED_LIVE_TEST') {
      const approvedPackageIds = Array.isArray(a.approvedPackageIds)
        ? [...new Set(a.approvedPackageIds.map((p) => String(p).trim()).filter(Boolean))]
        : []
      const maxRealPurchases = Number(a.maxRealPurchases)
      const maxProviderSpend = Number(a.maxProviderSpend)
      // All must be present and sane, else the whole authorization is invalid
      // (fail closed) rather than partially honored.
      if (
        typeof a.approvedAt === 'string' && a.approvedAt.length > 0 &&
        typeof a.approvedBy === 'string' && a.approvedBy.trim().length > 0 &&
        typeof a.evidenceReference === 'string' && a.evidenceReference.trim().length > 0 &&
        approvedPackageIds.length > 0 &&
        Number.isFinite(maxRealPurchases) && maxRealPurchases > 0 &&
        Number.isFinite(maxProviderSpend) && maxProviderSpend > 0
      ) {
        out.testAuthorization = {
          type: 'CONTROLLED_LIVE_TEST',
          approvedAt: a.approvedAt,
          approvedBy: a.approvedBy.trim(),
          evidenceReference: a.evidenceReference.trim(),
          approvedPackageIds,
          maxRealPurchases,
          maxProviderSpend,
        }
      }
      // else: leave undefined → authorization gate fails closed.
    }
  }

  return out
}

/**
 * Resolve the canonical certification config for a persisted provider row.
 * `config` is the raw Provider.config (Json) value. Never throws.
 */
export function resolveProviderCertificationConfig(provider: { config?: any }): ProviderCertificationConfig {
  const raw = provider?.config && typeof provider.config === 'object' ? (provider.config as any)?.certification : undefined
  return normalizeProviderCertificationConfig(raw)
}