export const SEAMLESS_ENDPOINTS = {
  productOfferings: '/product-offerings',
  productOffering: '/product-offerings/{productOfferingId}',
  productOfferingCountries: '/product-offerings/countries',
  orders: '/orders',
  order: '/orders/{orderId}',
  orderSubmit: '/orders/{orderId}/submit',
  orderCalculatePrice: '/orders/{orderId}/calculate-price',
  orderCancel: '/orders/{orderId}/cancel',
  orderLineItems: '/orders/{orderId}/line-items',
  orderLineItem: '/orders/{orderId}/line-items/{lineItemId}',
  subscriptions: '/subscriptions',
  subscription: '/subscriptions/{subscriptionId}',
  subscriptionActivate: '/subscriptions/{subscriptionId}/activate',
  subscriptionSuspend: '/subscriptions/{subscriptionId}/suspend',
  subscriptionRestore: '/subscriptions/{subscriptionId}/restore',
  subscriptionCancel: '/subscriptions/{subscriptionId}/cancel',
  subscriptionQR: '/subscriptions/{subscriptionId}/esim/qrcode',
  subscriptionUsage: '/subscriptions/{subscriptionId}/usage',
  subscriptionAddons: '/subscriptions/{subscriptionId}/addons',
  inventorySims: '/inventory/sims/{iccid}',
  inventoryLeaseNumbers: '/inventory/lease-numbers',
} as const

export type SeamlessEndpoint = keyof typeof SEAMLESS_ENDPOINTS

export function buildSeamlessUrl(baseUrl: string, endpoint: SeamlessEndpoint, pathParams?: Record<string, string>): string {
  let path: string = SEAMLESS_ENDPOINTS[endpoint]
  if (pathParams) {
    for (const [key, value] of Object.entries(pathParams)) {
      path = path.replace(`{${key}}`, encodeURIComponent(value))
    }
  }
  return `${baseUrl.replace(/\/$/, '')}${path}`
}
