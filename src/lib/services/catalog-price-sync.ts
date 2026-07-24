'use server'

import type { PrismaClient } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'

import type { ProviderPackageInput, CatalogProductSummary } from './catalog-price-utils'
import { decimalValuesEqual, parseDecimalSafe, buildCatalogProductSyncData, getCatalogPricingDifferences } from './catalog-price-utils'
export type { ProviderPackageInput, CatalogProductSummary }
export { decimalValuesEqual, parseDecimalSafe, buildCatalogProductSyncData, getCatalogPricingDifferences }

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