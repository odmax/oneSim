/**
 * OneSIM Catalog Review Apply Service — Phase 3C
 * ================================================
 *
 * ONLY this service may apply approved review decisions.
 * Enforces optimistic concurrency, staleness detection,
 * and transactional safety.
 */

import { prisma } from '@/lib/prisma'
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes } from '@/lib/services/catalog-price-sync'
import { finalizeCatalogPackageConfiguration } from '@/lib/pricing/configuration-finalizer'
import type { ReviewItemStatus } from '@prisma/client'

interface ApplyResult {
  success: boolean
  itemId: string
  message: string
  /** Whether the item was stale and could not be applied */
  isStale?: boolean
}

/**
 * Apply an approved review decision.
 *
 * Before applying, compares the captured `beforeSnapshot` against
 * current database values. If they differ, marks the item as stale.
 */
export async function applyReviewDecision(
  itemId: string,
  userId: string,
  action: 'APPROVE' | 'REJECT' | 'IGNORE' | 'ARCHIVE',
  note?: string,
): Promise<ApplyResult> {
  const item = await prisma.catalogReviewItem.findUnique({ where: { id: itemId } })
  if (!item) return { success: false, itemId, message: 'Review item not found' }
  if (item.reviewStatus !== 'PENDING') return { success: false, itemId, message: `Already ${item.reviewStatus}` }

  const pkg = await prisma.providerPackage.findUnique({
    where: { id: item.packageId },
    include: { provider: { select: { id: true, name: true, code: true } } },
  })

  if (!pkg) return { success: false, itemId, message: 'Provider package no longer exists' }

  const now = new Date()

  // ── Handle non-APPLY actions ──
  if (['REJECT', 'IGNORE'].includes(action)) {
    const status: ReviewItemStatus = action === 'REJECT' ? 'REJECTED' : 'IGNORED'
    await prisma.catalogReviewItem.update({
      where: { id: itemId },
      data: {
        reviewStatus: status,
        reviewedById: userId,
        reviewedAt: now,
        reviewNote: note || null,
        decision: action,
      },
    })
    return { success: true, itemId, message: action === 'REJECT' ? 'Rejected' : 'Ignored' }
  }

  if (action === 'ARCHIVE') {
    await prisma.providerPackage.update({
      where: { id: item.packageId },
      data: { publishStatus: 'ARCHIVED' },
    })
    await prisma.catalogReviewItem.update({
      where: { id: itemId },
      data: {
        reviewStatus: 'APPLIED',
        reviewedById: userId,
        reviewedAt: now,
        reviewNote: note || null,
        decision: 'ARCHIVE',
        applyResult: 'Archived successfully',
        afterSnapshot: { action: 'ARCHIVED' },
      },
    })
    return { success: true, itemId, message: 'Archived' }
  }

  // ── APPROVE — Apply pricing update ──
  if (action === 'APPROVE') {
    // Optimistic concurrency: compare beforeSnapshot with current values
    if (item.beforeSnapshot) {
      try {
        const snap = item.beforeSnapshot as Record<string, unknown>
        const currentSell = pkg.sellingPrice ? parseFloat(pkg.sellingPrice.toString()) : 0
        const snapSell = typeof snap?.sellingPrice === 'number' ? snap.sellingPrice : 0

        if (Math.abs(currentSell - snapSell) > 0.01) {
          await prisma.catalogReviewItem.update({
            where: { id: itemId },
            data: {
              isStale: true,
              staleReason: `Selling price changed: snapshot $${snapSell.toFixed(2)}, current $${currentSell.toFixed(2)}`,
              reviewStatus: 'FAILED',
              reviewedById: userId,
              reviewedAt: now,
            },
          })
          return { success: false, itemId, isStale: true, message: 'Stale recommendation — package data changed since review was created' }
        }
      } catch {
        // Snapshot parse failure — proceed cautiously
      }
    }

    // Apply pricing update
    const newSell = item.proposedSellingPrice || item.currentSellingPrice
    if (!newSell || newSell <= 0) {
      return { success: false, itemId, message: 'No valid selling price to apply' }
    }

    // Guard: finalize pricing + create snapshot + verify readiness before marking configured
    const finalized = await finalizeCatalogPackageConfiguration(item.packageId, { reason: 'CATALOG_REVIEW' })
    if (!finalized.success) {
      return { success: false, itemId, message: `Finalization failed: ${finalized.error} (${finalized.failedStage})` }
    }

    try {
      const updateData: Record<string, unknown> = {
        sellingPrice: newSell,
        configurationStatus: 'CONFIGURED',
        publishStatus: 'READY',
        lastConfiguredAt: now,
      }

      if (item.costDifference != null && item.proposedSellingPrice) {
        // Update is from optimization — store pricing mode
        updateData.pricingMode = 'FIXED_PRICE'
      }

      await prisma.$transaction(async (tx) => {
        const updated = await (tx as any).providerPackage.update({
          where: { id: item.packageId },
          data: updateData,
        })

        await syncProviderPackageToPublishedProducts(tx as any, updated)

        await (tx as any).catalogReviewItem.update({
          where: { id: itemId },
          data: {
            reviewStatus: 'APPLIED',
            reviewedById: userId,
            reviewedAt: now,
            reviewNote: note || null,
            decision: 'APPROVE',
            applyResult: `Applied selling price: $${newSell.toFixed(2)}`,
            afterSnapshot: { sellingPrice: newSell, appliedAt: now.toISOString() },
          },
        })
      })

      await revalidateCatalogRoutes()
      return { success: true, itemId, message: `Applied $${newSell.toFixed(2)}` }
    } catch (e: any) {
      await prisma.catalogReviewItem.update({
        where: { id: itemId },
        data: {
          reviewStatus: 'FAILED',
          reviewedById: userId,
          reviewedAt: now,
          applyResult: e.message || 'Transaction failed',
        },
      }).catch(() => {})
      return { success: false, itemId, message: e.message || 'Apply failed' }
    }
  }

  return { success: false, itemId, message: `Unknown action: ${action}` }
}

/**
 * Bulk-apply multiple review items.
 */
export async function bulkApplyReviewDecisions(
  itemIds: string[],
  userId: string,
  action: 'APPROVE' | 'REJECT' | 'IGNORE' | 'ARCHIVE',
  note?: string,
): Promise<{ results: ApplyResult[]; successCount: number; failureCount: number }> {
  const results: ApplyResult[] = []
  for (const id of itemIds) {
    const result = await applyReviewDecision(id, userId, action, note)
    results.push(result)
  }
  return {
    results,
    successCount: results.filter(r => r.success).length,
    failureCount: results.filter(r => !r.success).length,
  }
}
