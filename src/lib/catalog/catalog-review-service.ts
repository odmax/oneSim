/**
 * OneSIM Catalog Review Service — Phase 3C
 * ==========================================
 *
 * Persists pipeline results as reviewable records with idempotency.
 */

import { prisma } from '@/lib/prisma'
import type { PipelineResult } from './catalog-pipeline'

export async function persistPipelineReview(
  pipelineResult: PipelineResult,
  idempotencyKey: string,
  userId: string,
): Promise<{ runId: string; created: number; skipped: number; error?: string }> {
  const existing = await prisma.pipelineRun.findUnique({ where: { idempotencyKey } })
  if (existing) {
    return { runId: existing.id, created: 0, skipped: existing.totalPackages }
  }

  const run = await prisma.pipelineRun.create({
    data: {
      idempotencyKey,
      trigger: 'MANUAL',
      status: 'COMPLETED',
      totalPackages: pipelineResult.totalProcessed,
      newPackages: pipelineResult.byState.READY_FOR_REVIEW,
      updatedPackages: pipelineResult.byState.SIMULATED + pipelineResult.byState.OPTIMIZED,
      readyForReview: pipelineResult.byState.READY_FOR_REVIEW,
      needsAttention: 0,
      unchanged: pipelineResult.byState.SKIPPED,
      estimatedRevenueImpact: pipelineResult.estimatedRevenueImpact,
      estimatedProfitImpact: pipelineResult.estimatedProfitImpact,
      currency: pipelineResult.currency,
      createdById: userId,
      finishedAt: new Date(),
    },
  })

  let created = 0
  for (const item of pipelineResult.reviewItems) {
    if (item.state === 'SKIPPED') continue

    await prisma.catalogReviewItem.upsert({
      where: { pipelineRunId_packageId: { pipelineRunId: run.id, packageId: item.packageId } },
      create: {
        pipelineRunId: run.id,
        packageId: item.packageId,
        packageName: item.packageName,
        providerId: item.currentProvider || undefined,
        providerName: item.providerName,
        classification: item.classification,
        processingState: item.state,
        currentSellingPrice: item.currentSellingPrice,
        proposedSellingPrice: item.simulatedSellingPrice,
        currentMarginPercent: item.currentMargin,
        proposedMarginPercent: item.simulatedMargin,
        currentProviderId: undefined,
        currentProviderName: item.currentProvider,
        recommendedProviderName: item.recommendedProvider,
        costDifference: item.costDifference,
        profitDifference: item.profitDifference,
        suggestedAction: item.suggestedAction,
        confidence: item.confidence,
        reason: item.reason,
        reviewStatus: 'PENDING',
        changes: item.changes.length > 0 ? JSON.parse(JSON.stringify(item.changes)) : undefined,
        warnings: item.warnings.length > 0 ? JSON.parse(JSON.stringify(item.warnings)) : undefined,
        beforeSnapshot: item.currentSellingPrice != null ? JSON.parse(JSON.stringify({ sellingPrice: item.currentSellingPrice, margin: item.currentMargin, provider: item.currentProvider })) : undefined,
      },
      update: { reviewStatus: 'PENDING' },
    })
    created++
  }

  return { runId: run.id, created, skipped: pipelineResult.totalProcessed - created }
}

export async function getReviewStats() {
  const [pending, approved, rejected, ignored] = await Promise.all([
    prisma.catalogReviewItem.count({ where: { reviewStatus: 'PENDING' } }),
    prisma.catalogReviewItem.count({ where: { reviewStatus: 'APPROVED' } }),
    prisma.catalogReviewItem.count({ where: { reviewStatus: 'REJECTED' } }),
    prisma.catalogReviewItem.count({ where: { reviewStatus: 'IGNORED' } }),
  ])
  return { pending, approved, rejected, ignored }
}

export async function getReviewItems(params: {
  status?: string
  providerId?: string
  suggestedAction?: string
  search?: string
  page?: number
  limit?: number
}) {
  const where: any = {}
  if (params.status) where.reviewStatus = params.status
  if (params.providerId) where.providerId = params.providerId
  if (params.suggestedAction) where.suggestedAction = params.suggestedAction
  if (params.search) {
    where.OR = [
      { packageName: { contains: params.search, mode: 'insensitive' } },
    ]
  }

  const page = params.page || 1
  const limit = params.limit || 25

  const [items, total] = await Promise.all([
    prisma.catalogReviewItem.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.catalogReviewItem.count({ where }),
  ])

  return { items, total, page, totalPages: Math.ceil(total / limit) }
}
