'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { startPipelineRun, recordStageFromCounts, completePipelineRun, failPipelineRun } from '@/lib/catalog-pipeline'

export interface BulkConfigureParams {
  packageIds: string[]
  costPrice?: number
  sellingPrice?: number
  markupPercent?: number
  pricingMode?: string
  sellingCurrency?: string
  publishStatus?: string
  configurationStatus?: string
  tags?: string[]
  notes?: string
}

export async function bulkConfigurePackages(params: BulkConfigureParams): Promise<{ success: boolean; updated?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const { packageIds, ...configUpdates } = params

  if (!packageIds || packageIds.length === 0) {
    return { success: false, error: 'No packages selected' }
  }

  const pipelineRunId = await startPipelineRun({ trigger: 'MANUAL', totalInput: packageIds.length })
  const configStartTime = Date.now()

  // When publishStatus is READY, validate and auto-default configurationStatus
  if (configUpdates.publishStatus === 'READY') {
    const missing: string[] = []

    // Auto-default configurationStatus to CONFIGURED if not explicitly set
    if (!configUpdates.configurationStatus) {
      configUpdates.configurationStatus = 'CONFIGURED'
    }

    const finalConfigStatus = configUpdates.configurationStatus
    if (finalConfigStatus !== 'CONFIGURED' && finalConfigStatus !== 'AUTO_CONFIGURED') {
      missing.push('configurationStatus must be CONFIGURED or AUTO_CONFIGURED when publishStatus is READY')
    }

    if (configUpdates.sellingPrice == null || configUpdates.sellingPrice <= 0) {
      missing.push('sellingPrice must be > 0 when publishStatus is READY')
    }

    if (!configUpdates.sellingCurrency) {
      missing.push('sellingCurrency is required when publishStatus is READY')
    }

    if (configUpdates.costPrice == null || configUpdates.costPrice <= 0) {
      missing.push('costPrice must be > 0 when publishStatus is READY')
    }

    if (missing.length > 0) {
      return { success: false, error: `Cannot set publishStatus to READY: ${missing.join('; ')}.` }
    }

    console.log('[BULK_CONFIGURE_READY]', JSON.stringify({
      packageCount: packageIds.length,
      configurationStatus: configUpdates.configurationStatus,
      sellingPrice: configUpdates.sellingPrice,
      sellingCurrency: configUpdates.sellingCurrency,
      costPrice: configUpdates.costPrice,
    }))
  }

  const updateData: any = {}

  if (configUpdates.costPrice != null) {
    updateData.costPrice = configUpdates.costPrice
  }
  if (configUpdates.sellingPrice != null) {
    updateData.sellingPrice = configUpdates.sellingPrice
  }
  if (configUpdates.markupPercent != null) {
    updateData.markupPercent = configUpdates.markupPercent
  }
  if (configUpdates.pricingMode) {
    updateData.pricingMode = configUpdates.pricingMode
  }
  if (configUpdates.sellingCurrency) {
    updateData.sellingCurrency = configUpdates.sellingCurrency
  }
  if (configUpdates.publishStatus) {
    updateData.publishStatus = configUpdates.publishStatus
  }
  if (configUpdates.configurationStatus) {
    updateData.configurationStatus = configUpdates.configurationStatus
    updateData.lastConfiguredAt = new Date()
  }
  if (configUpdates.notes != null) {
    updateData.notes = configUpdates.notes
  }
  if (configUpdates.tags && configUpdates.tags.length > 0) {
    updateData.tags = configUpdates.tags
  }

  if (Object.keys(updateData).length === 0) {
    await recordStageFromCounts({ pipelineRunId, stage: 'CONFIGURATION', startTime: configStartTime, total: 0, passed: 0, failed: 0, skipped: 0, statusOverride: 'FAILED', metadata: { error: 'No options provided' } })
    await failPipelineRun(pipelineRunId, 'No configuration options provided')
    return { success: false, error: 'No configuration options provided' }
  }

  try {
    const result = await prisma.providerPackage.updateMany({
      where: { id: { in: packageIds } },
      data: updateData,
    })

    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'BULK_CONFIGURE_PACKAGES',
        entity: 'ProviderPackage',
        details: `Bulk configured ${result.count} packages: ${Object.keys(updateData).join(', ')}`,
      },
    }).catch(() => {})

    const isPublishReady = updateData.publishStatus === 'READY'
    await recordStageFromCounts({
      pipelineRunId, stage: 'CONFIGURATION', startTime: configStartTime,
      total: packageIds.length, passed: result.count, failed: 0, skipped: packageIds.length - result.count,
      metadata: { publishStatus: updateData.publishStatus, configurationStatus: updateData.configurationStatus },
    })
    if (isPublishReady) {
      const readyStartTime = Date.now()
      await recordStageFromCounts({
        pipelineRunId, stage: 'READY_FOR_PUBLISH', startTime: readyStartTime,
        total: result.count, passed: result.count, failed: 0, skipped: 0,
      })
    }
    await completePipelineRun(pipelineRunId, 'SUCCESS', result.count)

    revalidatePath('/admin/provider-catalog')
    return { success: true, updated: result.count }
  } catch (e: any) {
    await recordStageFromCounts({ pipelineRunId, stage: 'CONFIGURATION', startTime: configStartTime, total: packageIds.length, passed: 0, failed: packageIds.length, skipped: 0, statusOverride: 'FAILED', metadata: { error: e.message } })
    await failPipelineRun(pipelineRunId, e.message || 'Bulk configuration failed')
    return { success: false, error: e.message || 'Bulk configuration failed' }
  }
}
