export interface ProviderPackageInput {
  id: string
  name: string
  dataGB: number
  validityDays: number
  costPrice: { toString(): string }
  currency: string
  sellingPrice: { toString(): string } | null
  sellingCurrency: string | null
  markupPercent: { toString(): string } | null
  providerPlanId: string
  providerId: string
  publishStatus: string | null
}

export interface CatalogProductSummary {
  id: string
  priceUSD: { toString(): string } | null
  markupPercent: { toString(): string } | null
  hiddenFromCatalog: boolean | null
  archivedAt: Date | null
}

export function decimalValuesEqual(
  a: { toString(): string } | null | undefined,
  b: { toString(): string } | null | undefined,
): boolean {
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  return parseFloat(a.toString()) === parseFloat(b.toString())
}

export function parseDecimalSafe(val: { toString(): string } | null): number | null {
  if (val === null || val === undefined) return null
  const n = parseFloat(val.toString())
  return isNaN(n) ? null : n
}

export function buildCatalogProductSyncData(pp: ProviderPackageInput) {
  const sellPrice = parseDecimalSafe(pp.sellingPrice)
  const costPrice = parseDecimalSafe(pp.costPrice)
  const markup = parseDecimalSafe(pp.markupPercent)

  return {
    name: pp.name,
    displayName: pp.name,
    dataGB: pp.dataGB,
    validityDays: pp.validityDays,
    priceUSD: sellPrice ?? 0,
    localPrice: sellPrice ?? 0,
    currency: pp.sellingCurrency ?? pp.currency,
    costPriceUSD: costPrice,
    costCurrency: pp.currency,
    markupPercent: markup,
    providerPlanId: pp.providerPlanId,
    providerId: pp.providerId,
  }
}

export function getCatalogPricingDifferences(
  pp: ProviderPackageInput,
  product: CatalogProductSummary,
): string[] {
  const diffs: string[] = []
  const syncData = buildCatalogProductSyncData(pp)

  if (!decimalValuesEqual(product.priceUSD, pp.sellingPrice)) diffs.push('priceUSD')
  if (!decimalValuesEqual(product.markupPercent, pp.markupPercent)) diffs.push('markupPercent')
  return diffs
}