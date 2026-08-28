export type ConnectorType = 'MOCK' | 'REST_CATALOG' | 'URL_TOKEN' | 'HEADER_TOKEN' | 'STANDARD' | 'AIRHUB' | 'TELNA' | 'TELNA_SEAMLESS' | 'TELNA_FLEX' | 'IBASIS' | 'USMATRIX'

/**
 * Maps a provider's persisted strategy/type onto the concrete connector class.
 *
 * The `adapterStrategy` field is the source of truth. `providerType` only
 * contributes the MOCK short-circuit (legacy behavior).
 *
 * AIRHUB SAFETY INVARIANT: a provider coded AIRHUB always resolves to the
 * dedicated AirHubConnector and NEVER silently falls back to the generic
 * REST_CATALOG adapter — regardless of a stale persisted strategy (TEMPLATE,
 * legacy CUSTOM / REST_CATALOG / STANDARD, or empty/null). The AirHub clean
 * rebuild (fd3c178) removed the template-driven AirHub mode; a leftover TEMPLATE
 * value in the DB is stale, not an alternate supported integration. This is an
 * EXACT `provider.code === 'AIRHUB'` match — never name or loose matching.
 * Explicit dedicated non-AirHub strategies (TELNA family, IBASIS, USMATRIX)
 * still win, so no generic or unrelated provider is rerouted by the code check.
 */
export function resolveConnectorType(
  adapterStrategy: string | null | undefined,
  providerType: string,
  providerCode?: string | null,
): ConnectorType {
  if (providerType === 'MOCK') return 'MOCK'
  if (adapterStrategy === 'AIRHUB') return 'AIRHUB'
  if (adapterStrategy === 'TELNA_SEAMLESS') return 'TELNA_SEAMLESS'
  if (adapterStrategy === 'TELNA_FLEX') return 'TELNA_FLEX'
  if (adapterStrategy === 'TELNA') return 'TELNA'
  if (adapterStrategy === 'IBASIS') return 'IBASIS'
  if (adapterStrategy === 'USMATRIX') return 'USMATRIX'
  // Exact-code safety net: overrides only stale/generic strategies for AIRHUB.
  if (providerCode === 'AIRHUB') return 'AIRHUB'
  switch (adapterStrategy) {
    case 'STANDARD': return 'STANDARD'
    case 'CHOICE': return 'URL_TOKEN'
    case 'URL_TOKEN': return 'URL_TOKEN'
    case 'HEADER_TOKEN': return 'HEADER_TOKEN'
    case 'REST_CATALOG': return 'REST_CATALOG'
    default: return 'REST_CATALOG'
  }
}
