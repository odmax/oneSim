import { parseDecimalSafe } from '@/lib/services/catalog-price-utils'

const TOLERANCE = 0.005

export type Classification =
  | 'OK'
  | 'RETAIL_STALE'
  | 'PROVIDER_SNAPSHOT_MISMATCH'
  | 'NO_SNAPSHOT'
  | 'MISSING_RETAIL'
  | 'NOT_READY'
  | 'AMBIGUOUS'
  | 'OTHER'

export interface ClassifierInput {
  retailPackageId: string
  retailDisplayName: string | null
  retailPriceUSD: number | null
  retailLocalPrice: number | null
  retailCurrency: string | null
  providerPackageId: string | null
  providerPackageSellingPrice: number | null
  providerPackageSellingCurrency: string | null
  providerPackageCostStatus: string | null
  providerPackagePricingStatus: string | null
  providerPackagePublishStatus: string | null
  providerPackageConfigurationStatus: string | null
  providerPackageActivePriceSnapshotId: string | null
  linkedRetailCount: number
  snapshotFinalSellingPrice: number | null
  snapshotStatus: string | null
}

export interface ClassificationResult {
  classification: Classification
  reason: string
  repairable: boolean
  retailPackageId: string
  providerPackageId: string | null
  retailPriceUSD: number | null
  providerSellingPrice: number | null
  snapshotFinalSellingPrice: number | null
  snapshotStatus: string | null
}

function valuesEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) < TOLERANCE
}

export function classifyPackage(input: ClassifierInput): ClassificationResult {
  const base = {
    retailPackageId: input.retailPackageId,
    providerPackageId: input.providerPackageId,
    retailPriceUSD: input.retailPriceUSD,
    providerSellingPrice: input.providerPackageSellingPrice,
    snapshotFinalSellingPrice: input.snapshotFinalSellingPrice,
    snapshotStatus: input.snapshotStatus,
  }

  if (!input.providerPackageId) {
    return { ...base, classification: 'OTHER', reason: 'No providerPackageId link', repairable: false }
  }

  if (input.linkedRetailCount > 1) {
    return { ...base, classification: 'AMBIGUOUS', reason: `${input.linkedRetailCount} retail packages linked to this provider package`, repairable: false }
  }

  const validCostStatuses = ['VALID', 'OVERRIDDEN']
  if (!validCostStatuses.includes(input.providerPackageCostStatus ?? '')) {
    return { ...base, classification: 'NOT_READY', reason: `costStatus is ${input.providerPackageCostStatus || 'MISSING'}`, repairable: false }
  }

  if (input.providerPackagePricingStatus !== 'READY') {
    return { ...base, classification: 'NOT_READY', reason: `pricingStatus is ${input.providerPackagePricingStatus || 'COST_UNAVAILABLE'}`, repairable: false }
  }

  if (input.providerPackagePublishStatus !== 'PUBLISHED') {
    return { ...base, classification: 'NOT_READY', reason: `publishStatus is ${input.providerPackagePublishStatus || 'DRAFT'}`, repairable: false }
  }

  const validConfigStatuses = ['CONFIGURED', 'AUTO_CONFIGURED']
  if (!validConfigStatuses.includes(input.providerPackageConfigurationStatus ?? '')) {
    return { ...base, classification: 'NOT_READY', reason: `configurationStatus is ${input.providerPackageConfigurationStatus || 'UNCONFIGURED'}`, repairable: false }
  }

  if (!input.providerPackageActivePriceSnapshotId) {
    return { ...base, classification: 'NO_SNAPSHOT', reason: 'No active price snapshot linked', repairable: false }
  }

  if (input.snapshotFinalSellingPrice === null) {
    return { ...base, classification: 'NO_SNAPSHOT', reason: 'Active snapshot ID set but snapshot record missing', repairable: false }
  }

  if (input.snapshotStatus !== 'ACTIVE') {
    return { ...base, classification: 'NO_SNAPSHOT', reason: `Snapshot status is ${input.snapshotStatus || 'UNKNOWN'} (expected ACTIVE)`, repairable: false }
  }

  if (!valuesEqual(input.providerPackageSellingPrice, input.snapshotFinalSellingPrice)) {
    return { ...base, classification: 'PROVIDER_SNAPSHOT_MISMATCH', reason: `PP sellingPrice ($${input.providerPackageSellingPrice}) ≠ snapshot finalSellingPrice ($${input.snapshotFinalSellingPrice})`, repairable: false }
  }

  if (valuesEqual(input.retailPriceUSD, input.providerPackageSellingPrice)) {
    return { ...base, classification: 'OK', reason: 'All prices consistent', repairable: false }
  }

  if (input.providerPackageSellingCurrency && input.retailCurrency &&
      input.providerPackageSellingCurrency !== input.retailCurrency) {
    return { ...base, classification: 'OTHER', reason: `Currency mismatch: retail=${input.retailCurrency} pp=${input.providerPackageSellingCurrency}`, repairable: false }
  }

  return {
    ...base,
    classification: 'RETAIL_STALE',
    reason: `Retail priceUSD ($${input.retailPriceUSD}) ≠ PP sellingPrice ($${input.providerPackageSellingPrice}) — retail is the only stale field`,
    repairable: true,
  }
}

export function buildSyncDataFromClassifierInput(input: ClassifierInput) {
  return {
    priceUSD: input.providerPackageSellingPrice ?? 0,
    localPrice: input.providerPackageSellingPrice ?? 0,
    currency: input.providerPackageSellingCurrency ?? input.retailCurrency ?? 'USD',
  }
}
