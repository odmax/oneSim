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
  }
  // Safe fallback — prefer provider-owned references, then ICCID.
  const fallback = esim.providerSubscriptionId || esim.providerActivationId || esim.providerSubscriberId || esim.iccid
  if (fallback) return { ok: true, identifier: fallback }
  return { ok: false, skipReason: 'IDENTIFIER_MISSING' }
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
