export function stripPackageProviderFields(pkg: any) {
  if (!pkg) return pkg
  const {
    providerName, providerPlanId, providerId, providerRawData,
    providerMapping, costPriceUSD, markupPercent, costCurrency,
    ...safe
  } = pkg
  return safe
}

export function stripEsimProviderFields(esim: any) {
  if (!esim) return esim
  const {
    providerActivationId, providerSubscriptionId, providerStatus, providerResponse,
    lastSyncAt, lastUsageSyncAt, lastStatusSyncAt, packageSnapshot,
    ...safe
  } = esim
  return safe
}

export function stripPurchaseProviderFields(purchase: any) {
  if (!purchase) return purchase
  const {
    providerStatus, providerResponse,
    providerId, providerReservationId, providerFulfillId,
    providerErrorCode, providerErrorMessage, providerPurchaseKey,
    failureReason, retryCount, maxRetries, nextRetryAt, lastRetryAt, retryReason,
    providerAssignedAt, providerActivatedAt, providerDeactivatedAt,
    ...safe
  } = purchase
  return safe
}
