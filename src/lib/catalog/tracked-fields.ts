export const TRACKED_FIELDS = [
  'sellingPrice', 'sellingCurrency', 'markupPercent', 'pricingMode',
  'publishStatus', 'configurationStatus', 'tags', 'notes',
  'isPreferred', 'preferredReason', 'preferredAt',
  'excludedFromAutoPick', 'autoPickReason',
  // Phase 5C — Provider Cost Normalization
  'costPrice', 'currency', 'adminCostPrice', 'effectiveCostPrice', 'costSource',
  'costStatus', 'costReceivedAt', 'costExpiresAt', 'isTaxInclusive', 'taxAmount',
  'costDerivationMethod', 'costDerivationConfig', 'pricingStatus',
] as const
