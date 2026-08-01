export type ConnectorType = 'MOCK' | 'REST_CATALOG' | 'URL_TOKEN' | 'HEADER_TOKEN' | 'STANDARD' | 'AIRHUB' | 'TELNA' | 'TELNA_SEAMLESS' | 'IBASIS'

/**
 * Maps a provider's persisted strategy/type onto the concrete connector class.
 *
 * The `adapterStrategy` field is the source of truth. `providerType` only
 * contributes the MOCK short-circuit (legacy behavior). `providerCode` is a
 * safety net: a provider coded AIRHUB that lost its strategy still selects the
 * dedicated AirHub connector instead of falling back to the generic
 * REST_CATALOG adapter.
 */
export function resolveConnectorType(
  adapterStrategy: string | null | undefined,
  providerType: string,
  providerCode?: string | null,
): ConnectorType {
  if (providerType === 'MOCK') return 'MOCK'
  if (adapterStrategy === 'AIRHUB') return 'AIRHUB'
  if (providerCode === 'AIRHUB' && !adapterStrategy) return 'AIRHUB'
  if (adapterStrategy === 'TELNA_SEAMLESS') return 'TELNA_SEAMLESS'
  if (adapterStrategy === 'TELNA') return 'TELNA'
  if (adapterStrategy === 'IBASIS') return 'IBASIS'
  switch (adapterStrategy) {
    case 'STANDARD': return 'STANDARD'
    case 'CHOICE': return 'URL_TOKEN'
    case 'URL_TOKEN': return 'URL_TOKEN'
    case 'HEADER_TOKEN': return 'HEADER_TOKEN'
    case 'REST_CATALOG': return 'REST_CATALOG'
    default: return 'REST_CATALOG'
  }
}
