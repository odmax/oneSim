'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { startPipelineRun, recordStageFromCounts, completePipelineRun, failPipelineRun } from '@/lib/catalog-pipeline'
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes, recordCatalogPriceSyncAudit } from '@/lib/services/catalog-price-sync'
import { resolvePricingMutation, inferPricingIntent, type PricingMutationIntent } from '@/lib/pricing/pricing-engine'
import { publishProviderPackageToRetailCatalog } from '@/lib/services/catalog/publish-to-retail'
import { isPackagePublishEligible, getPublishIneligibilityReasons } from '@/lib/catalog/publish-eligibility'

/** Convert a Prisma Decimal-ish value (has toString()) to a finite number, else null. */
function decimalToNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(String((v as any).toString?.() ?? v))
  return isNaN(n) || !isFinite(n) ? null : n
}

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
  /** What the administrator actually edited — authority for bidirectional pricing. */
  pricingIntent?: PricingMutationIntent
}

export async function bulkConfigurePackages(params: BulkConfigureParams): Promise<{
  success: boolean
  updated?: number
  published?: number
  publishBlocked?: number
  blockedDetails?: Array<{ packageId: string; name: string; reasons: string[] }>
  error?: string
}> {
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
  // PUBLISHED is intentionally NOT persisted directly here — it is routed
  // through the canonical publication gate per package below.
  if (configUpdates.publishStatus && configUpdates.publishStatus !== 'PUBLISHED') {
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

  // PUBLISHED-only intent is valid (route through the canonical gate) even when
  // there are no pricing/config fields to persist.
  if (Object.keys(updateData).length === 0 && params.publishStatus !== 'PUBLISHED') {
    await recordStageFromCounts({ pipelineRunId, stage: 'CONFIGURATION', startTime: configStartTime, total: 0, passed: 0, failed: 0, skipped: 0, statusOverride: 'FAILED', metadata: { error: 'No options provided' } })
    await failPipelineRun(pipelineRunId, 'No configuration options provided')
    return { success: false, error: 'No configuration options provided' }
  }

  try {
    const beforePackages = await prisma.providerPackage.findMany({
      where: { id: { in: packageIds } },
      select: { id: true, name: true, dataGB: true, validityDays: true, costPrice: true, currency: true, sellingPrice: true, sellingCurrency: true, markupPercent: true, providerPlanId: true, providerId: true, publishStatus: true, configurationStatus: true },
    })

    // CANONICAL bidirectional pricing: resolve a consistent triple per package
    // so cost+markup → selling and cost+selling → markup always hold, even when
    // the admin supplies only two of the three values (the reported bug).
    const supplied = {
      costPrice: configUpdates.costPrice,
      sellingPrice: configUpdates.sellingPrice,
      markupPercent: configUpdates.markupPercent,
    }
    const perPackagePricing = new Map<string, { costPrice: number | null; sellingPrice: number | null; markupPercent: number | null }>()
    for (const bp of beforePackages) {
      const existingState = {
        costPrice: decimalToNumber(bp.costPrice),
        sellingPrice: decimalToNumber(bp.sellingPrice),
        markupPercent: decimalToNumber(bp.markupPercent),
      }
      const intent = params.pricingIntent || inferPricingIntent(supplied, existingState)
      const resolved = resolvePricingMutation({ intent, supplied, existing: existingState })
      if (!resolved.valid) {
        await recordStageFromCounts({ pipelineRunId, stage: 'CONFIGURATION', startTime: configStartTime, total: packageIds.length, passed: 0, failed: packageIds.length, skipped: 0, statusOverride: 'FAILED', metadata: { error: `Invalid pricing for ${bp.id}: ${resolved.errors.join('; ')}` } })
        await failPipelineRun(pipelineRunId, `Invalid pricing for ${bp.id}: ${resolved.errors.join('; ')}`)
        return { success: false, error: `Invalid pricing for ${bp.id}: ${resolved.errors.join('; ')}` }
      }
      perPackagePricing.set(bp.id, { costPrice: resolved.costPrice, sellingPrice: resolved.sellingPrice, markupPercent: resolved.markupPercent })
    }

    await prisma.$transaction(async (tx) => {
      if (Object.keys(updateData).length > 0) {
        const result = await tx.providerPackage.updateMany({
          where: { id: { in: packageIds } },
          data: updateData,
        })

        if (result.count === 0) throw new Error('No packages updated')
      }

      // Persist the resolved pricing triple per package (dependent values are
      // never silently missing), then sync to linked products.
      for (const bp of beforePackages) {
        const p = perPackagePricing.get(bp.id)
        const pricingData: any = {}
        const existingState = {
          costPrice: decimalToNumber(bp.costPrice),
          sellingPrice: decimalToNumber(bp.sellingPrice),
          markupPercent: decimalToNumber(bp.markupPercent),
        }
        const intent = params.pricingIntent || inferPricingIntent(supplied, existingState)
        if (configUpdates.costPrice !== undefined) pricingData.costPrice = p?.costPrice
        if (intent === 'COST' || intent === 'MARKUP' || intent === 'SELLING') {
          if (p?.sellingPrice !== null) pricingData.sellingPrice = p?.sellingPrice
          if (p?.markupPercent !== null) pricingData.markupPercent = p?.markupPercent
        }
        if (Object.keys(pricingData).length > 0) {
          await tx.providerPackage.update({ where: { id: bp.id }, data: pricingData })
        }
        const merged = {
          ...bp,
          ...updateData,
          ...pricingData,
        }
        await syncProviderPackageToPublishedProducts(tx, merged as any)
      }
    })

    // Explicit PUBLISHED intent: route every selected package through the
    // FIRST gate (publish eligibility) and then the canonical publication gate
    // (finalize → snapshot → retail → readiness → PUBLISHED). Ineligible or
    // readiness-failed packages do NOT force PUBLISHED.
    let published = 0
    let publishBlocked = 0
    const blockedDetails: { packageId: string; name: string; reasons: string[] }[] = []
    if (params.publishStatus === 'PUBLISHED') {
      for (const bp of beforePackages) {
        // Prospective status: the bulk form's requested configuration wins;
        // otherwise the current DB state. PUBLISHED intent itself is never a
        // source state — eligibility comes from CONFIGURED/AUTO_CONFIGURED/READY.
        const prospectiveState = {
          configurationStatus: configUpdates.configurationStatus ?? bp.configurationStatus,
          publishStatus: bp.publishStatus,
        }
        if (!isPackagePublishEligible(prospectiveState)) {
          publishBlocked++
          blockedDetails.push({ packageId: bp.id, name: bp.name, reasons: getPublishIneligibilityReasons(prospectiveState) })
          continue
        }
        const result = await publishProviderPackageToRetailCatalog(bp.id, { reason: 'BULK_CONFIGURE_PUBLISH' })
        if (result.success) {
          published++
        } else {
          publishBlocked++
          blockedDetails.push({ packageId: bp.id, name: bp.name, reasons: result.readinessReasons || (result.error ? [result.error] : []) })
        }
      }
    }

    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'BULK_CONFIGURE_PACKAGES',
        entity: 'ProviderPackage',
        details: `Bulk configured ${packageIds.length} packages: ${Object.keys(updateData).join(', ')}${params.publishStatus === 'PUBLISHED' ? ` published=${published} blocked=${publishBlocked}` : ''}`,
      },
    }).catch(() => {})

    const isPublishReady = updateData.publishStatus === 'READY'
    await recordStageFromCounts({
      pipelineRunId, stage: 'CONFIGURATION', startTime: configStartTime,
      total: packageIds.length, passed: packageIds.length, failed: 0, skipped: 0,
      metadata: { publishStatus: updateData.publishStatus, configurationStatus: updateData.configurationStatus, published, publishBlocked },
    })
    if (isPublishReady) {
      const readyStartTime = Date.now()
      await recordStageFromCounts({
        pipelineRunId, stage: 'READY_FOR_PUBLISH', startTime: readyStartTime,
        total: packageIds.length, passed: packageIds.length, failed: 0, skipped: 0,
      })
    }
    if (params.publishStatus === 'PUBLISHED' && publishBlocked > 0) {
      for (const b of blockedDetails.slice(0, 10)) {
        console.log(`[BULK_CONFIGURE_PUBLISH_BLOCKED] ${b.name} (${b.packageId.slice(-8)}): ${b.reasons.join('; ')}`)
      }
      await completePipelineRun(pipelineRunId, 'PARTIAL', published)
      await revalidateCatalogRoutes()
      return { success: true, updated: packageIds.length, published, publishBlocked, blockedDetails }
    }
    await completePipelineRun(pipelineRunId, 'SUCCESS', packageIds.length)

    await revalidateCatalogRoutes()
    return {
      success: true,
      updated: packageIds.length,
      ...(params.publishStatus === 'PUBLISHED' ? { published, publishBlocked } : {}),
    }
  } catch (e: any) {
    await recordStageFromCounts({ pipelineRunId, stage: 'CONFIGURATION', startTime: configStartTime, total: packageIds.length, passed: 0, failed: packageIds.length, skipped: 0, statusOverride: 'FAILED', metadata: { error: e.message } })
    await failPipelineRun(pipelineRunId, e.message || 'Bulk configuration failed')
    return { success: false, error: e.message || 'Bulk configuration failed' }
  }
}