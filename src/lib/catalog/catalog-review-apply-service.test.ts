import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    pipelineRun: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    catalogReviewItem: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    providerPackage: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('@/lib/services/catalog-price-sync', () => ({
  syncProviderPackageToPublishedProducts: vi.fn(),
  revalidateCatalogRoutes: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }))
vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { persistPipelineReview, getReviewStats, getReviewItems } from './catalog-review-service'
import { applyReviewDecision, bulkApplyReviewDecisions } from './catalog-review-apply-service'
import type { PipelineResult } from './catalog-pipeline'

const mockPipelineResult: PipelineResult = {
  totalProcessed: 3,
  byState: { DETECTED: 0, ANALYZED: 0, SIMULATED: 0, OPTIMIZED: 1, READY_FOR_REVIEW: 2, SKIPPED: 1, ERROR: 0 },
  reviewItems: [
    {
      packageId: 'pkg-1', packageName: 'Plan A', providerName: 'Provider1',
      state: 'READY_FOR_REVIEW', classification: 'NEW', reason: 'New package',
      changes: [], currentSellingPrice: null, simulatedSellingPrice: 125, currentMargin: null,
      simulatedMargin: 20, currentProvider: null, recommendedProvider: null, costDifference: null,
      profitDifference: null, confidence: 80, suggestedAction: 'CONFIGURE', warnings: [],
    },
    {
      packageId: 'pkg-2', packageName: 'Plan B', providerName: 'Provider2',
      state: 'READY_FOR_REVIEW', classification: 'UPDATED', reason: 'Cost changed',
      changes: [{ field: 'cost', before: 100, after: 120, significant: true }],
      currentSellingPrice: 150, simulatedSellingPrice: 180, currentMargin: 33.33,
      simulatedMargin: 44.44, currentProvider: 'Provider2', recommendedProvider: 'Provider3',
      costDifference: 30, profitDifference: 30, confidence: 70, suggestedAction: 'REVIEW_PRICING',
      warnings: [],
    },
    {
      packageId: 'pkg-3', packageName: 'Plan C', providerName: 'Provider1',
      state: 'SKIPPED', classification: 'UNCHANGED', reason: 'No changes',
      changes: [], currentSellingPrice: 100, simulatedSellingPrice: null, currentMargin: 20,
      simulatedMargin: null, currentProvider: 'Provider1', recommendedProvider: null, costDifference: null,
      profitDifference: null, confidence: 50, suggestedAction: 'NO_ACTION', warnings: [],
    },
  ],
  bySuggestedAction: { CONFIGURE: 1, REVIEW_PRICING: 1, NO_ACTION: 1 },
  totalWarnings: 0,
  estimatedRevenueImpact: 30,
  estimatedProfitImpact: 30,
  currency: 'USD',
  durationMs: 50,
  processingLog: ['test log'],
}

describe('catalog-review-service', () => {
  it('persists pipeline results with idempotency key', async () => {
    ;(prisma.pipelineRun.findUnique as any).mockResolvedValue(null)
    ;(prisma.pipelineRun.create as any).mockResolvedValue({ id: 'run-1', totalPackages: 3 })
    ;(prisma.catalogReviewItem.upsert as any).mockResolvedValue({ id: 'item-1' })

    const result = await persistPipelineReview(mockPipelineResult, 'key-abc', 'user-1')

    expect(result.runId).toBe('run-1')
    expect(result.created).toBe(2) // pkg-1 and pkg-2 (pkg-3 is SKIPPED)
    expect(result.skipped).toBe(1)
  })

  it('returns existing run for duplicate idempotency key', async () => {
    ;(prisma.pipelineRun.findUnique as any).mockResolvedValue({ id: 'existing-run', totalPackages: 3 })

    const result = await persistPipelineReview(mockPipelineResult, 'key-abc', 'user-1')

    expect(result.runId).toBe('existing-run')
    expect(result.created).toBe(0)
  })

  it('gets review stats', async () => {
    ;(prisma.catalogReviewItem.count as any)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)

    const stats = await getReviewStats()
    expect(stats.pending).toBe(5)
    expect(stats.approved).toBe(3)
    expect(stats.rejected).toBe(2)
    expect(stats.ignored).toBe(1)
  })
})

describe('catalog-review-apply-service', () => {
  const mockItem = {
    id: 'item-1',
    packageId: 'pkg-1',
    reviewStatus: 'PENDING',
    proposedSellingPrice: 150,
    currentSellingPrice: 100,
    beforeSnapshot: { sellingPrice: 100 },
  }

  const mockPackage = {
    id: 'pkg-1',
    sellingPrice: { toString: () => '100' },
    provider: { name: 'Test' },
  }

  it('rejects when item not found', async () => {
    ;(prisma.catalogReviewItem.findUnique as any).mockResolvedValue(null)

    const result = await applyReviewDecision('missing', 'user-1', 'APPROVE')
    expect(result.success).toBe(false)
    expect(result.message).toContain('not found')
  })

  it('rejects non-pending items', async () => {
    ;(prisma.catalogReviewItem.findUnique as any).mockResolvedValue({ ...mockItem, reviewStatus: 'APPROVED' })

    const result = await applyReviewDecision('item-1', 'user-1', 'APPROVE')
    expect(result.success).toBe(false)
    expect(result.message).toContain('Already')
  })

  it('detects stale recommendations', async () => {
    ;(prisma.catalogReviewItem.findUnique as any).mockResolvedValue(mockItem)
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({
      ...mockPackage,
      sellingPrice: { toString: () => '120' }, // Different from snapshot's 100
    })
    ;(prisma.catalogReviewItem.update as any).mockResolvedValue({})

    const result = await applyReviewDecision('item-1', 'user-1', 'APPROVE')
    expect(result.success).toBe(false)
    expect(result.isStale).toBe(true)
    expect(result.message).toContain('Stale')
  })
})
