'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes, recordCatalogPriceSyncAudit } from '@/lib/services/catalog-price-sync'
import { publishProviderPackageToRetailCatalog } from '@/lib/services/catalog/publish-to-retail'
import { resolvePricingMutation, inferPricingIntent, type PricingMutationIntent } from '@/lib/pricing/pricing-engine'
import { isPackagePublishEligible, getPublishIneligibilityReasons, PUBLISH_INELIGIBLE_MESSAGE } from '@/lib/catalog/publish-eligibility'

/** Convert a Prisma Decimal-ish value (has toString()) to a finite number, else null. */
function decimalToNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(String((v as any).toString?.() ?? v))
  return isNaN(n) || !isFinite(n) ? null : n
}

/**
 * Shared: build the persistable ProviderPackage update from editable pricing/
 * config inputs using the canonical bidirectional resolver. Never sets
 * publishStatus=PUBLISHED here (publication is routed through the canonical
 * gate). Returns the updateData plus the resolved pricing triple.
 */
function buildPricingUpdateData(
  before: {
    costPrice?: unknown
    sellingPrice?: unknown
    markupPercent?: unknown
  },
  data: {
    costPrice?: number
    sellingPrice?: number
    sellingCurrency?: string
    markupPercent?: number
    pricingMode?: string
    publishStatus?: string
    configurationStatus?: string
    notes?: string
    pricingIntent?: PricingMutationIntent
  },
): { updateData: Record<string, unknown>; resolved: { sellingPrice: number | null; markupPercent: number | null } } {
  const updateData: Record<string, unknown> = {}
  const supplied = {
    costPrice: data.costPrice,
    sellingPrice: data.sellingPrice,
    markupPercent: data.markupPercent,
  }
  const existingState = {
    costPrice: decimalToNumber(before.costPrice),
    sellingPrice: decimalToNumber(before.sellingPrice),
    markupPercent: decimalToNumber(before.markupPercent),
  }
  const intent = data.pricingIntent || inferPricingIntent(supplied, existingState)
  const resolved = resolvePricingMutation({ intent, supplied, existing: existingState })
  if (!resolved.valid) throw new Error(`Invalid pricing: ${resolved.errors.join('; ')}`)

  if (data.costPrice !== undefined) updateData.costPrice = resolved.costPrice
  if (data.sellingPrice !== undefined) updateData.sellingPrice = resolved.sellingPrice
  if (data.markupPercent !== undefined) updateData.markupPercent = resolved.markupPercent
  // Always persist the derived dependent so the invariant holds: when the
  // admin edits markup, selling is computed even if left blank; when they
  // edit selling, markup is computed even if left blank; a cost edit
  // recalculates whichever dependent is determinable.
  if (intent === 'COST' || intent === 'MARKUP' || intent === 'SELLING') {
    if (resolved.sellingPrice !== null) updateData.sellingPrice = resolved.sellingPrice
    if (resolved.markupPercent !== null) updateData.markupPercent = resolved.markupPercent
  }
  if (data.sellingCurrency !== undefined) updateData.sellingCurrency = data.sellingCurrency
  if (data.pricingMode !== undefined) updateData.pricingMode = data.pricingMode
  // PUBLISHED is intentionally NOT persisted here — the canonical publish gate handles it.
  if (data.publishStatus !== undefined && data.publishStatus !== 'PUBLISHED') updateData.publishStatus = data.publishStatus
  if (data.configurationStatus !== undefined) { updateData.configurationStatus = data.configurationStatus; updateData.lastConfiguredAt = new Date() }
  if (data.notes !== undefined) updateData.notes = data.notes

  return { updateData, resolved }
}

export async function updateSinglePackage(packageId: string, data: {
  costPrice?: number
  sellingPrice?: number
  sellingCurrency?: string
  markupPercent?: number
  pricingMode?: string
  publishStatus?: string
  configurationStatus?: string
  notes?: string
  /** What the administrator actually edited — authority for bidirectional pricing. */
  pricingIntent?: PricingMutationIntent
}): Promise<{ success: boolean; error?: string; readinessReasons?: string[]; eligibilityReasons?: string[] }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  // Explicit PUBLISHED intent: check the FIRST gate (publish eligibility)
  // against the prospective state, then persist the admin's edits, then run
  // canonical finalization + the single publication gate. Never force
  // PUBLISHED on eligibility or readiness failure.
  if (data.publishStatus === 'PUBLISHED') {
    const before = await prisma.providerPackage.findUnique({ where: { id: packageId } })
    if (!before) return { success: false, error: 'Package not found' }

    // Prospective status: requested edits win; otherwise the current DB state.
    const prospectiveState = {
      configurationStatus: data.configurationStatus ?? before.configurationStatus,
      publishStatus: data.publishStatus && data.publishStatus !== 'PUBLISHED' ? data.publishStatus : before.publishStatus,
    }
    if (!isPackagePublishEligible(prospectiveState)) {
      return {
        success: false,
        error: PUBLISH_INELIGIBLE_MESSAGE,
        eligibilityReasons: getPublishIneligibilityReasons(prospectiveState),
      }
    }

    try {
      await prisma.$transaction(async (tx) => {
        const { updateData } = buildPricingUpdateData(before, data)
        if (Object.keys(updateData).length === 0) throw new Error('No fields to update')
        const updated = await tx.providerPackage.update({ where: { id: packageId }, data: updateData })
        await syncProviderPackageToPublishedProducts(tx, updated)
      })
    } catch (e: any) {
      return { success: false, error: e.message || 'Update failed' }
    }

    const result = await publishProviderPackageToRetailCatalog(packageId, { reason: 'MANUAL_EDIT' })
    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Publish failed',
        readinessReasons: result.readinessReasons || (result.failedStage ? [result.error || result.failedStage] : []),
      }
    }
    await revalidateCatalogRoutes()
    return { success: true }
  }

  try {
    const { updated, before } = await prisma.$transaction(async (tx) => {
      const before = await tx.providerPackage.findUnique({ where: { id: packageId } })
      if (!before) throw new Error('Package not found')

      const { updateData } = buildPricingUpdateData(before, data)
      if (Object.keys(updateData).length === 0) throw new Error('No fields to update')

      const updated = await tx.providerPackage.update({ where: { id: packageId }, data: updateData })

      await syncProviderPackageToPublishedProducts(tx, updated)

      return { updated, before }
    })

    await recordCatalogPriceSyncAudit(
      'MANUAL_EDIT',
      packageId,
      { matchedProducts: 1, updatedProducts: 1, skippedProducts: 0, productIds: [], oldSellingPrice: before.sellingPrice?.toString() ?? null, newSellingPrice: updated.sellingPrice?.toString() ?? null, oldMarkup: before.markupPercent?.toString() ?? null, newMarkup: updated.markupPercent?.toString() ?? null, status: 'SYNCED' },
      before.sellingPrice?.toString() ?? null,
      updated.sellingPrice?.toString() ?? null,
      before.markupPercent?.toString() ?? null,
      updated.markupPercent?.toString() ?? null,
    )

    await revalidateCatalogRoutes()
    return { success: true }
  } catch (e: any) {
    if (e.message === 'Package not found' || e.message === 'No fields to update') {
      return { success: false, error: e.message }
    }
    return { success: false, error: e.message || 'Update failed' }
  }
}

export async function undoLastRules(): Promise<{ success: boolean; rolledBack?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const lastRules = await prisma.catalogChangeSet.findFirst({
    where: { actionType: 'RULES_APPLIED' },
    orderBy: { createdAt: 'desc' },
  })

  if (!lastRules) return { success: false, error: 'No rules application found in history' }

  const { rollbackChangeSet } = await import('./catalog-history')
  return rollbackChangeSet(lastRules.id)
}