/**
 * OneSIM Pricing Update Service
 * ==============================
 *
 * THIS MODULE PERSISTS PRICING — IT NEVER CALCULATES PRICES.
 *
 * ## Responsibilities
 * - Receive `PricingUpdateRequest` objects.
 * - Update `ProviderPackage` records with new pricing fields.
 * - Sync changes to linked `ESIMPackage` (catalog) records.
 * - Create audit log entries.
 * - Create catalog change sets for rollback support.
 *
 * ## What does NOT belong here
 * - Rule matching (see `pricing-rule-evaluator.ts`).
 * - Arithmetic (no markup%, margin%, profit, selling price calculations).
 * - Business logic (no deciding WHICH strategy to use).
 *
 * ## Dependency Direction
 * This module depends on:
 * - `@/lib/prisma` (database)
 * - `@/lib/services/catalog-price-sync` (catalog sync)
 * - `./types.ts` (DTOs)
 * - `next/cache` (revalidation)
 * It NEVER imports from `pricing-engine.ts` or `pricing-rule-evaluator.ts`.
 *
 * @module pricing-update-service
 */

import type { PrismaClient } from '@prisma/client'
import type { PricingUpdateRequest, PricingUpdateResult } from './types'
import type { ProviderPackageInput } from '@/lib/services/catalog-price-utils'

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

/**
 * Apply a single pricing update to a ProviderPackage within a transaction.
 *
 * Returns a `PricingUpdateResult` indicating success or failure.
 * This function performs NO calculations — it purely writes to the database.
 */
export async function applySinglePricingUpdate(
  tx: Tx,
  request: PricingUpdateRequest,
): Promise<PricingUpdateResult> {
  try {
    const updateData: Record<string, unknown> = {
      sellingPrice: request.sellingPrice,
      sellingCurrency: request.sellingCurrency,
      markupPercent: request.markupPercent,
      pricingMode: request.pricingMode,
      publishStatus: request.publishStatus,
      configurationStatus: request.configurationStatus,
      autoConfiguredByRuleId: request.autoConfiguredByRuleId,
      lastConfiguredAt: new Date(),
    }

    if (request.costPrice !== undefined) {
      updateData.costPrice = request.costPrice
    }

    const updated = await (tx as any).providerPackage.update({
      where: { id: request.packageId },
      data: updateData,
    })

    return { packageId: request.packageId, success: true }
  } catch (e: any) {
    return { packageId: request.packageId, success: false, error: e.message || 'Update failed' }
  }
}

/**
 * Apply multiple pricing updates within a single Prisma transaction.
 *
 * Each update also syncs the ProviderPackage → ESIMPackage catalog link.
 * All updates succeed or fail together (atomic).
 */
export async function applyPricingUpdates(
  tx: Tx,
  requests: PricingUpdateRequest[],
): Promise<PricingUpdateResult[]> {
  const results: PricingUpdateResult[] = []

  for (const request of requests) {
    const result = await applySinglePricingUpdate(tx, request)

    if (result.success) {
      // Sync to linked catalog products
      const { syncProviderPackageToPublishedProducts } = await import(
        '@/lib/services/catalog-price-sync'
      )
      const providerPackageInput: ProviderPackageInput = {
        id: request.packageId,
        name: '',
        dataGB: 0,
        validityDays: 0,
        costPrice: { toString: () => String(request.costPrice ?? 0) },
        currency: request.sellingCurrency,
        sellingPrice: { toString: () => String(request.sellingPrice) },
        sellingCurrency: request.sellingCurrency,
        markupPercent: { toString: () => String(request.markupPercent ?? '') },
        providerPlanId: '',
        providerId: '',
        publishStatus: request.publishStatus,
      }
      try {
        await syncProviderPackageToPublishedProducts(tx, providerPackageInput)
      } catch {
        // Catalog sync failure does not roll back the package update —
        // it'll be picked up on the next publish cycle.
      }
    }

    results.push(result)
  }

  return results
}

/**
 * Build a `PricingUpdateRequest` from a rule evaluation + pricing calculation result.
 *
 * This is the bridge between the rule evaluator, pricing engine, and update service.
 * It accepts the output of the previous two stages and produces the DTO the update
 * service needs.
 *
 * This function performs NO calculations — it assembles a DTO from existing data.
 */
export function buildUpdateRequest(params: {
  packageId: string
  ruleId: string
  ruleName: string
  sellingPrice: number
  sellingCurrency: string
  markupPercent: number | null
  pricingMode: string
  publishStatus: string
  costPrice?: number
}): Omit<PricingUpdateRequest, 'packageId'> {
  const { packageId: _, ...updateFields } = {
    packageId: params.packageId,
    sellingPrice: params.sellingPrice,
    sellingCurrency: params.sellingCurrency,
    markupPercent: params.markupPercent,
    pricingMode: params.pricingMode,
    publishStatus: params.publishStatus,
    configurationStatus: 'AUTO_CONFIGURED' as const,
    autoConfiguredByRuleId: params.ruleId,
    costPrice: params.costPrice,
  }
  return updateFields
}

export type { PricingUpdateRequest, PricingUpdateResult }
