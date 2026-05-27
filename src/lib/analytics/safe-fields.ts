export function stripPackageProviderFields(pkg: any) {
  if (!pkg) return pkg
  const {
    providerName, providerPlanId, providerId, providerRawData,
    providerMapping, costPriceUSD, markupPercent,
    ...safe
  } = pkg
  return safe
}

export function stripEsimProviderFields(esim: any) {
  if (!esim) return esim
  const {
    providerActivationId, providerSubscriptionId, providerStatus, providerResponse,
    ...safe
  } = esim
  return safe
}

export function stripPurchaseProviderFields(purchase: any) {
  if (!purchase) return purchase
  const {
    providerStatus, providerResponse,
    ...safe
  } = purchase
  return safe
}
