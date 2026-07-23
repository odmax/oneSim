'use server'

import type { PrismaClient } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'

export interface CatalogPriceSyncResult {
  matchedProducts: number
  updatedProducts: number
  skippedProducts: number
  productIds: string[]
  oldSellingPrice: string | null
  newSellingPrice: string | null
  oldMarkup: string | null
  newMarkup: string | null
  status: 'SYNCED' | 'NO_LINKED_PRODUCT' | 'ERROR'
}

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

/**
 * Safely compares two Decimal-like values for equality,
 * handling scale differences (e.g. 20.1 === 20.10).
 */
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

/**
 * Builds the data object for updating an ESIMPackage from a ProviderPackage.
 * This is the single authoritative field mapping.
 */
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

/**
 * Checks whether a catalog product's pricing fields differ from the
 * provider package's current values. Returns an array of differing field names.
 */
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

/**
 * Centralized service that synchronizes ProviderPackage pricing fields
 * to all linked ESIMPackage (Product Catalog) records.
 *
 * Designed to be called inside a prisma.$transaction callback.
 * Only updates records that already have a providerPackageId link.
 * Never creates ESIMPackage records — only updates existing ones.
 */
export async function syncProviderPackageToPublishedProducts(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  providerPackage: ProviderPackageInput,
): Promise<CatalogPriceSyncResult> {
  const linkedProducts = await tx.eSIMPackage.findMany({
    where: { providerPackageId: providerPackage.id },
    select: { id: true, priceUSD: true, markupPercent: true, hiddenFromCatalog: true, archivedAt: true },
  }) as CatalogProductSummary[]

  if (linkedProducts.length === 0) {
    const sellPrice = parseDecimalSafe(providerPackage.sellingPrice)
    const markup = parseDecimalSafe(providerPackage.markupPercent)
    console.log('[CATALOG_PRICE_SYNC]', JSON.stringify({
      providerPackageId: providerPackage.id,
      matchedProducts: 0,
      updatedProducts: 0,
      skippedProducts: 0,
      oldSellingPrice: null,
      newSellingPrice: sellPrice?.toFixed(2) ?? null,
      oldMarkup: null,
      newMarkup: markup?.toFixed(2) ?? null,
      status: 'NO_LINKED_PRODUCT',
    }))
    return {
      matchedProducts: 0,
      updatedProducts: 0,
      skippedProducts: 0,
      productIds: [],
      oldSellingPrice: null,
      newSellingPrice: sellPrice?.toFixed(2) ?? null,
      oldMarkup: null,
      newMarkup: markup?.toFixed(2) ?? null,
      status: 'NO_LINKED_PRODUCT',
    }
  }

  const oldSellingPrice = linkedProducts[0]?.priceUSD?.toString() ?? null
  const oldMarkup = linkedProducts[0]?.markupPercent?.toString() ?? null
  let updated = 0
  const productIds: string[] = []
  const syncData = buildCatalogProductSyncData(providerPackage)

  for (const product of linkedProducts) {
    productIds.push(product.id)

    try {
      await tx.eSIMPackage.update({
        where: { id: product.id },
        data: syncData,
      })
      updated++
    } catch (e) {
      console.error(`[CATALOG_PRICE_SYNC] Failed to update product ${product.id}:`, e)
    }
  }

  const skipped = linkedProducts.length - updated
  const sellPrice = parseDecimalSafe(providerPackage.sellingPrice)
  const markup = parseDecimalSafe(providerPackage.markupPercent)

  console.log('[CATALOG_PRICE_SYNC]', JSON.stringify({
    providerPackageId: providerPackage.id,
    matchedProducts: linkedProducts.length,
    updatedProducts: updated,
    skippedProducts: skipped,
    productIds,
    oldSellingPrice,
    newSellingPrice: sellPrice?.toFixed(2) ?? null,
    oldMarkup,
    newMarkup: markup?.toFixed(2) ?? null,
    status: updated > 0 ? 'SYNCED' : 'ERROR',
  }))

  return {
    matchedProducts: linkedProducts.length,
    updatedProducts: updated,
    skippedProducts: skipped,
    productIds,
    oldSellingPrice,
    newSellingPrice: sellPrice?.toFixed(2) ?? null,
    oldMarkup,
    newMarkup: markup?.toFixed(2) ?? null,
    status: updated > 0 ? 'SYNCED' : 'ERROR',
  }
}

/**
 * Revalidates all routes that display catalog pricing data.
 * Should be called after any ProviderPackage → ESIMPackage sync.
 */
export async function revalidateCatalogRoutes(path?: string) {
  revalidatePath('/admin/provider-catalog')
  revalidatePath('/admin/packages')
  revalidatePath('/admin/catalog-products')
  revalidatePath('/business/buy-esim')
  revalidatePath('/business/esims')
  revalidatePath('/api/packages')
  if (path) revalidatePath(path)
}

/**
 * Creates an audit log entry for catalog price sync operations.
 */
export async function recordCatalogPriceSyncAudit(
  source: 'MANUAL_EDIT' | 'RULE_EXECUTION' | 'PUBLISH' | 'BACKFILL' | 'UNDO',
  providerPackageId: string,
  syncResult: CatalogPriceSyncResult,
  oldSellingPrice: string | null,
  newSellingPrice: string | null,
  oldMarkup: string | null,
  newMarkup: string | null,
) {
  const session = await getServerSession(authOptions)
  if (!session) return

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: `CATALOG_PRICE_SYNC_${source}`,
      entity: 'ProviderPackage',
      entityId: providerPackageId,
      details: JSON.stringify({
        source,
        providerPackageId,
        productIds: syncResult.productIds,
        matchedProducts: syncResult.matchedProducts,
        updatedProducts: syncResult.updatedProducts,
        skippedProducts: syncResult.skippedProducts,
        oldSellingPrice,
        newSellingPrice,
        oldMarkup,
        newMarkup,
        status: syncResult.status,
      }),
    },
  }).catch(() => {})
}