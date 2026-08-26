import { prisma } from '@/lib/prisma'
import { parseDecimalSafe } from '@/lib/services/catalog-price-utils'

export interface PriceParityCheckInput {
  providerPackageId: string
  providerPackageSellingPrice: number | null
  providerPackageSellingCurrency: string | null
  providerPackageMarkupPercent: number | null
  providerPackageCostPrice: number | null
  providerPackageActivePriceSnapshotId: string | null
  retailPackageId: string | null
  retailPackagePriceUSD: number | null
  retailPackageLocalPrice: number | null
  retailPackageCurrency: string | null
  snapshotFinalSellingPrice: number | null
  snapshotStatus?: string | null
}

export interface PriceParityViolation {
  field: string
  providerValue: number | null
  retailValue: number | null
  snapshotValue: number | null
  message: string
}

export interface PriceParityResult {
  consistent: boolean
  providerPackageId: string
  retailPackageId: string | null
  violations: PriceParityViolation[]
  snapshotFinalSellingPrice: number | null
  snapshotStatus: string | null
}

function numbersEqual(
  a: number | null | undefined,
  b: number | null | undefined,
): boolean {
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  return Math.abs(a - b) < 0.005
}

function buildViolation(
  field: string,
  providerValue: number | null,
  retailValue: number | null,
  snapshotValue: number | null,
  message: string,
): PriceParityViolation {
  return { field, providerValue, retailValue, snapshotValue, message }
}

/**
 * Validates price parity between a BOUND ProviderPackage and its linked
 * retail ESIMPackage.
 *
 * BOUND packages: retail priceUSD must equal provider sellingPrice, which
 * must equal the active PriceSnapshot.finalSellingPrice.
 *
 * Returns detailed violation info for each mismatched field.
 */
export function validatePriceParity(input: PriceParityCheckInput): PriceParityResult {
  const violations: PriceParityViolation[] = []
  const ppSell = input.providerPackageSellingPrice
  const retailPrice = input.retailPackagePriceUSD
  const retailLocal = input.retailPackageLocalPrice
  const snapshotPrice = input.snapshotFinalSellingPrice

  if (retailPrice !== null && !numbersEqual(ppSell, retailPrice)) {
    violations.push(buildViolation(
      'priceUSD',
      ppSell,
      retailPrice,
      snapshotPrice,
      `Retail priceUSD ($${retailPrice}) does not match ProviderPackage sellingPrice ($${ppSell})`,
    ))
  }

  if (retailLocal !== null && !numbersEqual(ppSell, retailLocal)) {
    violations.push(buildViolation(
      'localPrice',
      ppSell,
      retailLocal,
      snapshotPrice,
      `Retail localPrice ($${retailLocal}) does not match ProviderPackage sellingPrice ($${ppSell})`,
    ))
  }

  if (snapshotPrice !== null && !numbersEqual(ppSell, snapshotPrice)) {
    violations.push(buildViolation(
      'sellingPrice_vs_snapshot',
      ppSell,
      retailPrice,
      snapshotPrice,
      `ProviderPackage sellingPrice ($${ppSell}) does not match active snapshot finalSellingPrice ($${snapshotPrice})`,
    ))
  }

  return {
    consistent: violations.length === 0,
    providerPackageId: input.providerPackageId,
    retailPackageId: input.retailPackageId,
    violations,
    snapshotFinalSellingPrice: snapshotPrice,
    snapshotStatus: input.snapshotStatus ?? null,
  }
}

/**
 * Loads a ProviderPackage and its linked retail ESIMPackage from the database,
 * fetches the active PriceSnapshot, and validates price parity.
 *
 * Use this for runtime parity checks (e.g., at purchase time or audit).
 */
export async function validatePriceParityFromDatabase(
  providerPackageId: string,
): Promise<PriceParityResult> {
  const pp = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    select: {
      id: true,
      sellingPrice: true,
      sellingCurrency: true,
      markupPercent: true,
      costPrice: true,
      activePriceSnapshotId: true,
    },
  })

  if (!pp) {
    return {
      consistent: false,
      providerPackageId,
      retailPackageId: null,
      violations: [buildViolation('providerPackage', null, null, null, 'ProviderPackage not found')],
      snapshotFinalSellingPrice: null,
      snapshotStatus: null,
    }
  }

  const retail = await prisma.eSIMPackage.findFirst({
    where: { providerPackageId },
    select: {
      id: true,
      priceUSD: true,
      localPrice: true,
      currency: true,
    },
  })

  let snapshotFinalSellingPrice: number | null = null
  let snapshotStatus: string | null = null

  if (pp.activePriceSnapshotId) {
    const snapshot = await prisma.packagePriceSnapshot.findUnique({
      where: { id: pp.activePriceSnapshotId },
      select: { finalSellingPrice: true, status: true },
    })
    snapshotFinalSellingPrice = snapshot ? Number(snapshot.finalSellingPrice) : null
    snapshotStatus = snapshot?.status ?? null
  }

  const ppSell = parseDecimalSafe(pp.sellingPrice)
  const retailPrice = retail ? parseDecimalSafe(retail.priceUSD) : null
  const retailLocal = retail ? parseDecimalSafe(retail.localPrice) : null
  const retailCurrency = retail?.currency ?? null

  const result = validatePriceParity({
    providerPackageId: pp.id,
    providerPackageSellingPrice: ppSell,
    providerPackageSellingCurrency: pp.sellingCurrency,
    providerPackageMarkupPercent: parseDecimalSafe(pp.markupPercent),
    providerPackageCostPrice: parseDecimalSafe(pp.costPrice),
    providerPackageActivePriceSnapshotId: pp.activePriceSnapshotId,
    retailPackageId: retail?.id ?? null,
    retailPackagePriceUSD: retailPrice,
    retailPackageLocalPrice: retailLocal,
    retailPackageCurrency: retailCurrency,
    snapshotFinalSellingPrice,
  })

  result.snapshotStatus = snapshotStatus
  return result
}
