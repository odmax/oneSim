/**
 * OneSIM Provider Sync Runner — Phase 4A
 * ========================================
 *
 * Executes a provider sync and returns structured results.
 * Delegates pricing to existing engines.
 */

import { prisma } from '@/lib/prisma'
import { runCatalogAutomation } from '@/lib/catalog/catalog-automation'
import { runCatalogPipeline } from '@/lib/catalog/catalog-pipeline'
import { persistPipelineReview } from '@/lib/catalog/catalog-review-service'

export async function executeProviderSync(
  providerId: string,
  userId: string,
): Promise<{ packages: number; changes: number; runId?: string; reviewItems?: number }> {
  // Fetch packages from this provider
  const packages = await prisma.providerPackage.findMany({
    where: { providerId, isAvailable: true },
    include: { provider: { select: { id: true, name: true, code: true, status: true } } },
  })

  // Catalog Automation
  const inputs = packages.map(pp => ({
    packageId: pp.id, packageName: pp.name,
    providerId: pp.providerId, providerName: pp.provider.name, providerCode: pp.provider.code,
    before: null,
    after: {
      cost: parseFloat(pp.costPrice.toString()),
      data: pp.dataGB, validity: pp.validityDays,
      country: pp.country || undefined, name: pp.name,
    },
    hasPricing: !!(pp.sellingPrice && parseFloat(pp.sellingPrice.toString()) > 0),
    isPublished: pp.publishStatus === 'PUBLISHED',
  }))

  const automation = runCatalogAutomation(inputs)
  const pipeline = runCatalogPipeline({ automation, currency: 'USD' })

  // Persist review items
  const idempotencyKey = `sync-${providerId}-${Date.now()}`
  const reviewResult = await persistPipelineReview(pipeline, idempotencyKey, userId)

  return {
    packages: packages.length,
    changes: pipeline.reviewItems.filter(i => i.state === 'READY_FOR_REVIEW').length,
    runId: reviewResult.runId,
    reviewItems: reviewResult.created,
  }
}

export async function executeCatalogPipelineJob(
  providerId: string | undefined,
  userId: string,
): Promise<{ packages: number; runId?: string; reviewItems?: number }> {
  const where: any = { isAvailable: true }
  if (providerId) where.providerId = providerId

  const packages = await prisma.providerPackage.findMany({
    where,
    include: { provider: { select: { id: true, name: true, code: true, status: true } } },
  })

  const inputs = packages.map(pp => ({
    packageId: pp.id, packageName: pp.name,
    providerId: pp.providerId, providerName: pp.provider.name, providerCode: pp.provider.code,
    before: null,
    after: {
      cost: parseFloat(pp.costPrice.toString()),
      data: pp.dataGB, validity: pp.validityDays,
      country: pp.country || undefined, name: pp.name,
    },
    hasPricing: !!(pp.sellingPrice && parseFloat(pp.sellingPrice.toString()) > 0),
    isPublished: pp.publishStatus === 'PUBLISHED',
  }))

  const automation = runCatalogAutomation(inputs)
  const pipeline = runCatalogPipeline({ automation, currency: 'USD' })

  const idempotencyKey = `pipeline-${providerId || 'all'}-${Date.now()}`
  const reviewResult = await persistPipelineReview(pipeline, idempotencyKey, userId)

  return {
    packages: packages.length,
    runId: reviewResult.runId,
    reviewItems: reviewResult.created,
  }
}
