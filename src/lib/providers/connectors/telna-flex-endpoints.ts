/**
 * Telna Connect Flex API — documented endpoints ONLY (official Telna docs).
 *
 * Host: https://ppo-api.telna.com
 * Auth: Authorization: Bearer <KeyID> (Raw KeyID also accepted; RAW only when
 *       the provider config explicitly requests it).
 *
 * Documented endpoints used here (all read-only unless marked):
 *   GET  /v1/ordering/products                 discovery / health
 *   GET  /v1/ordering/products/{product_id}    single product
 *   POST /v1/ordering/work-orders              purchase (NOT wired — mutating)
 *   GET  /v1/diagnostic/usages                 usage (read-only)
 *   GET  /v1/diagnostic/euicc-profiles/{iccid} historical eUICC profile lookup
 *
 * No paths are guessed; every path below comes from the official API reference.
 */
export const TELNA_FLEX_ENDPOINTS = {
  products: '/v1/ordering/products',
  product: '/v1/ordering/products/{product_id}',
  workOrders: '/v1/ordering/work-orders',
  usages: '/v1/diagnostic/usages',
  euiccProfiles: '/v1/diagnostic/euicc-profiles/{iccid}',
} as const

export type TelnaFlexEndpoint = keyof typeof TELNA_FLEX_ENDPOINTS

export function telnaFlexEndpointPath(endpoint: TelnaFlexEndpoint): string {
  return TELNA_FLEX_ENDPOINTS[endpoint]
}

export function buildTelnaFlexUrl(
  baseUrl: string,
  endpoint: TelnaFlexEndpoint,
  pathParams?: Record<string, string | number>,
  query?: Record<string, string | number | undefined>,
): string {
  const base = String(baseUrl || 'https://ppo-api.telna.com').replace(/\/+$/, '')
  let path: string = TELNA_FLEX_ENDPOINTS[endpoint]
  if (pathParams) {
    for (const [key, value] of Object.entries(pathParams)) {
      path = path.replace(`{${key}}`, encodeURIComponent(String(value)))
    }
  }
  let url = `${base}${path}`
  if (query) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
    }
    const qs = params.toString()
    if (qs) url += `?${qs}`
  }
  return url
}
