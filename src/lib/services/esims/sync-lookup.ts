import type { IProviderConnector, StatusLookupIdentifier, StatusLookupEsim } from '@/lib/providers/connectors/connector-interface'

/**
 * Canonical, provider-neutral eSIM identity bundle passed to connector
 * resolvers. Only provider-owned identifiers — a local OneSIM esim.id is never
 * included, so it can never leak upstream.
 */
export interface EsimProviderIdentity {
  iccid?: string | null
  imsi?: string | null
  imsiVersion?: string | number | null
  providerActivationId?: string | null
  providerSubscriptionId?: string | null
  providerSubscriberId?: string | null
  providerResponse?: unknown
  status?: string | null
  /** Provider-owned package identity (provider package UUID / plan id). */
  providerPackageId?: string | null
  providerPlanId?: string | null
}

export type SyncSkipReason = 'CAPABILITY_NOT_SUPPORTED' | 'IDENTIFIER_MISSING' | 'PROVIDER_NOT_CONFIGURED'

/** Result of resolving an upstream identifier for a sync operation. */
export type SyncLookupResult =
  | { ok: true; identifier: string | StatusLookupIdentifier }
  | { ok: false; skipReason: SyncSkipReason }

/** Shape accepted by the resolver (works from a full ESIM row or a lean bundle). */
export type SyncLookupEsim = StatusLookupEsim & Pick<EsimProviderIdentity, 'providerSubscriberId' | 'providerResponse'>

function pick<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v
}

/** Build the canonical identity bundle from a Prisma ESIM row (or lean object). */
export function toEsimProviderIdentity(esim: SyncLookupEsim): EsimProviderIdentity {
  return {
    iccid: pick(esim.iccid),
    imsi: pick(esim.imsi),
    imsiVersion: esim.imsiVersion != null ? esim.imsiVersion : undefined,
    providerActivationId: pick(esim.providerActivationId),
    providerSubscriptionId: pick(esim.providerSubscriptionId),
    providerSubscriberId: pick(esim.providerSubscriberId),
    providerResponse: esim.providerResponse ?? undefined,
    status: pick(esim.status),
    providerPackageId: pick(esim.providerPackageId),
    providerPlanId: pick(esim.providerPlanId),
  }
}

/**
 * Canonical STATUS lookup resolution (Part 2).
 *
 * Order:
 *   1. connector.resolveStatusLookup(esim) when implemented
 *   2. safe provider-neutral fallback:
 *      providerSubscriptionId → providerActivationId → providerSubscriberId → ICCID
 *
 * Returns ok=false with a structured skip reason when no safe identifier exists
 * — the caller must NOT make a provider call.
 */
export function resolveStatusLookup(
  connector: IProviderConnector,
  esim: SyncLookupEsim,
): SyncLookupResult {
  if (typeof connector.resolveStatusLookup === 'function') {
    const id = connector.resolveStatusLookup(esim)
    if (id !== undefined && id !== null) return { ok: true, identifier: id }
  }
  // Safe provider-neutral fallback (never a local OneSIM id).
  const fallback = esim.providerSubscriptionId || esim.providerActivationId || esim.providerSubscriberId || esim.iccid
  if (fallback) return { ok: true, identifier: fallback }
  return { ok: false, skipReason: 'IDENTIFIER_MISSING' }
}

/**
 * Canonical USAGE lookup resolution (Part 3).
 *
 * Uses connector.resolveUsageLookup(esim) when implemented; otherwise a safe
 * provider-neutral fallback (provider reference → ICCID). CHOICE uses its
 * structured identifier; TELNA_FLEX uses ICCID; future US-Matrix may resolve
 * packageEsimId from provider metadata. Never a local OneSIM id.
 */
export function resolveUsageLookup(
  connector: IProviderConnector,
  esim: SyncLookupEsim,
): SyncLookupResult {
  if (typeof (connector as any).resolveUsageLookup === 'function') {
    const id = (connector as any).resolveUsageLookup(esim)
    if (id !== undefined && id !== null) return { ok: true, identifier: id }
    // The connector implements a usage resolver but found NO safe upstream
    // identifier. Do NOT fall back to an ICCID the connector may consider
    // unsafe (e.g. US-Matrix requires the provider packageEsimId, and Choice
    // requires a structured iccid/imsi/imsi_version object — never a bare
    // string). The caller must skip cleanly.
    return { ok: false, skipReason: 'IDENTIFIER_MISSING' }
  }
  // Safe fallback — only for connectors WITHOUT a usage resolver.
  // Never a local OneSIM id.
  const fallback = esim.providerSubscriptionId || esim.providerActivationId || esim.providerSubscriberId || esim.iccid
  if (fallback) return { ok: true, identifier: fallback }
  return { ok: false, skipReason: 'IDENTIFIER_MISSING' }
}

/**
 * Merge a provider-discovered package↔eSIM association id into the eSIM's
 * providerResponse WITHOUT overwriting existing keys. Provider-neutral — only
 * the `packageEsimId` key is written when a value is present. Returns undefined
 * when there is nothing to persist.
 */
export function mergeProviderPackageEsimId(
  providerResponse: unknown,
  packageEsimId: string | null | undefined,
): Record<string, unknown> | undefined {
  if (typeof packageEsimId !== 'string' || !packageEsimId) return undefined
  const base = providerResponse && typeof providerResponse === 'object'
    ? { ...(providerResponse as Record<string, unknown>) }
    : {}
  base.packageEsimId = packageEsimId
  return base
}

/**
 * Connector error codes that mean "no safe usage identifier could be resolved"
 * (no association / ambiguous associations / missing identifier). These are a
 * CLEAN SKIP — never a retryable failure. Provider-neutral vocabulary.
 */
export const USAGE_LOOKUP_SKIP_CODES = new Set(['IDENTIFIER_MISSING', 'NO_ASSOCIATION', 'AMBIGUOUS_ASSOCIATION'])

export function isUsageLookupSkip(errorCode: string | null | undefined): boolean {
  return typeof errorCode === 'string' && USAGE_LOOKUP_SKIP_CODES.has(errorCode)
}

/**
 * Provider-neutral capability gate: a connector must actually declare the
 * capability before the sync layer invokes it. Unsupported → clean skip,
 * never a failure/retry.
 */
export function capabilitySupported(connector: IProviderConnector, capability: 'statusLookup' | 'usageLookup'): boolean {
  return connector.capabilities?.[capability] === true
}

/** Provider-neutral connector construction (dynamic import avoids cycles). */
export async function buildProviderConnector(providerId: string): Promise<IProviderConnector | null> {
  const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
  return buildConnectorFromProvider(providerId) as any
}
