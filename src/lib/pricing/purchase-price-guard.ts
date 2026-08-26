import { prisma } from '@/lib/prisma'
import { parseDecimalSafe } from '@/lib/services/catalog-price-utils'

export interface PriceGuardInput {
  providerPackageId: string
  retailPriceUSD: number | null
  retailLocalPrice: number | null
}

export interface PriceGuardResult {
  passed: boolean
  reason?: string
  providerSellingPrice: number | null
  retailPriceUSD: number | null
  snapshotFinalSellingPrice: number | null
  snapshotStatus: string | null
}

/**
 * Fail-closed price parity guard for BOUND packages at purchase time.
 *
 * Verifies that the retail ESIMPackage.priceUSD matches:
 * 1. The ProviderPackage.sellingPrice (source of truth for pricing)
 * 2. The active PriceSnapshot.finalSellingPrice (immutable audit trail)
 *
 * This guard must be called BEFORE any wallet mutations, order creation,
 * or provider dispatch attempts. If parity fails, the purchase must
 * fail-closed with zero side effects.
 *
 * Only applies to BOUND packages (those with a providerPackageId link).
 * CUSTOM packages and packages without a snapshot are not checked.
 */
export async function enforcePurchasePriceGuard(
  input: PriceGuardInput,
): Promise<PriceGuardResult> {
  const { providerPackageId, retailPriceUSD, retailLocalPrice } = input

  const pp = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    select: {
      id: true,
      sellingPrice: true,
      sellingCurrency: true,
      activePriceSnapshotId: true,
    },
  })

  if (!pp) {
    return {
      passed: false,
      reason: 'ProviderPackage not found',
      providerSellingPrice: null,
      retailPriceUSD,
      snapshotFinalSellingPrice: null,
      snapshotStatus: null,
    }
  }

  const ppSell = parseDecimalSafe(pp.sellingPrice)

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

  if (retailPriceUSD !== null && ppSell !== null && Math.abs(retailPriceUSD - ppSell) >= 0.005) {
    return {
      passed: false,
      reason: `Price stale: retail priceUSD ($${retailPriceUSD}) does not match provider sellingPrice ($${ppSell})`,
      providerSellingPrice: ppSell,
      retailPriceUSD,
      snapshotFinalSellingPrice,
      snapshotStatus,
    }
  }

  if (retailLocalPrice !== null && ppSell !== null && Math.abs(retailLocalPrice - ppSell) >= 0.005) {
    return {
      passed: false,
      reason: `Price stale: retail localPrice ($${retailLocalPrice}) does not match provider sellingPrice ($${ppSell})`,
      providerSellingPrice: ppSell,
      retailPriceUSD,
      snapshotFinalSellingPrice,
      snapshotStatus,
    }
  }

  if (snapshotFinalSellingPrice !== null && ppSell !== null && Math.abs(ppSell - snapshotFinalSellingPrice) >= 0.005) {
    return {
      passed: false,
      reason: `Price stale: provider sellingPrice ($${ppSell}) does not match active snapshot finalSellingPrice ($${snapshotFinalSellingPrice})`,
      providerSellingPrice: ppSell,
      retailPriceUSD,
      snapshotFinalSellingPrice,
      snapshotStatus,
    }
  }

  return {
    passed: true,
    providerSellingPrice: ppSell,
    retailPriceUSD,
    snapshotFinalSellingPrice,
    snapshotStatus,
  }
}
