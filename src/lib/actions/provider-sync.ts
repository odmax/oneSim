'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { generateSku, generatePackageCode } from '@/lib/packages/resolve-package'
import { buildAdapter, isTemplateDrivenProvider } from '@/lib/providers/adapter-manager'
import { normalizePlan } from '@/lib/providers/plan-utils'
import type { ProviderPlan } from '@/lib/providers/adapter-types'
import { buildComparableKey, computeEffectiveCost, recalculateCheapestPlans } from '@/lib/packages/cheapest-utils'
import { inferProviderCapabilities, getPersistableCapabilities } from '@/lib/providers/capabilities'
import { advanceCertificationTo } from '@/lib/providers/certification-machine'
import { startPipelineRun, recordStageFromCounts, completePipelineRun, failPipelineRun } from '@/lib/catalog-pipeline'
import { normalizeTravelDateRequirement, withTravelDateMarker } from '@/lib/providers/travel-date-utils'
import { resolvePricingStateOnCostSync, PRICING_STATUS } from '@/lib/pricing/pricing-state'
import { recalculatePackagePrice } from '@/lib/pricing/price-recalculation-service'
import { syncProviderPackageToPublishedProducts } from '@/lib/services/catalog-price-sync'

export type { ProviderPlan }

function extractCountry(rawData: string): string | null {
  try {
    const parsed = JSON.parse(rawData)
    return parsed.country || parsed.region || null
  } catch {
    return null
  }
}

export async function syncProviderPlans(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const provider = await prisma.provider.findUnique({ where: { id: providerId }, include: { providerTemplate: true } })
  if (!provider) return { error: 'Provider not found' }

  const pipelineRunId = await startPipelineRun({
    providerId: provider.id,
    providerCode: provider.code || undefined,
    trigger: 'MANUAL',
  })
  const syncStartTime = Date.now()
  console.log(`[DB_PROVIDER_CONFIG] code=${provider.code} configKeys=${Object.keys((provider.config as any) || {}).join(',')} partnerCode=${(provider.config as any)?.partnerCode} providerMode=${(provider.config as any)?.providerMode}`)

  // Capability guard — connector truth wins. A legacy provider record whose
  // explicit capability array predates CATALOG_SYNC must NOT block sync when the
  // resolved connector genuinely implements it. See
  // providerSupportsConnectorCapability (uses the already-fetched provider row).
  const { providerSupportsConnectorCapability } = await import('@/lib/providers/capability-state')
  if (!(await providerSupportsConnectorCapability(provider, 'CATALOG_SYNC'))) {
    return { error: 'This provider does not support Catalog Sync.' }
  }

  // Resolve plan list path from endpointMappings or template for template-driven providers
  const resolvedPlanListPath = (() => {
    if (provider.planListPath) return provider.planListPath
    const ep = provider.endpointMappings as Record<string, string> | null
    if (ep?.GET_PLANS) return ep.GET_PLANS
    return '(not set)'
  })()

  // Resolve response list key from provider, template, or responseMappings
  const resolvedResponseListKey = (() => {
    if (provider.responseListKey) return provider.responseListKey
    return '(not set)'
  })()

  const diagnostics: any = {
    providerId: provider.id,
    providerName: provider.name,
    providerCode: provider.code,
    providerType: provider.type,
    adapterStrategy: provider.adapterStrategy || provider.type,
    baseUrl: provider.apiBaseUrl || '(not set)',
    authUrl: provider.authUrl || '(not set)',
    tokenPresent: !!provider.apiToken,
    tokenLength: provider.apiToken ? provider.apiToken.length : 0,
    tokenPlacement: provider.tokenPlacement || 'BEARER_HEADER',
    planListPath: resolvedPlanListPath,
    responseListKey: resolvedResponseListKey,
    endpoint: provider.apiBaseUrl ? provider.apiBaseUrl + (provider.planListPath || '/plans') : '(not set)',
    responseStatus: 0,
    responseKeys: [],
    fetchedCount: 0,
    rawResponsePreview: '',
    resolvedArrayLength: 0,
    mappedPackageCount: 0,
    lowCountWarning: false,
  }

  try {
    const strategy = provider.adapterStrategy
    if (!strategy) {
      await recordStageFromCounts({ pipelineRunId, stage: 'PROVIDER_SYNC', startTime: syncStartTime, total: 0, passed: 0, failed: 0, skipped: 0, statusOverride: 'FAILED', metadata: { error: 'No adapter strategy configured' } })
      await failPipelineRun(pipelineRunId, 'No adapter strategy configured')
      return { error: `Cannot sync: adapterStrategy is not configured for provider "${provider.name}". Go to Edit Provider to set a protocol strategy.`, diagnostics }
    }

    const adapter = await buildAdapter(provider)
    if (!adapter) {
      await recordStageFromCounts({ pipelineRunId, stage: 'PROVIDER_SYNC', startTime: syncStartTime, total: 0, passed: 0, failed: 0, skipped: 0, statusOverride: 'FAILED', metadata: { error: 'No adapter available' } })
      await failPipelineRun(pipelineRunId, 'No adapter available')
      return { error: `No adapter available for provider type "${provider.type}" / strategy "${strategy}"`, diagnostics }
    }

    console.log(`[TRACE_SYNC] step=syncProviderPlans code=${provider.code} strategy=${provider.adapterStrategy} adapterClass=${adapter.constructor.name} connectorClass=${(adapter as any).connector?.constructor?.name || 'none'}`)

    // Log sync context — use actual routing, not legacy assumptions
    const isTemplateDriven = isTemplateDrivenProvider(provider)
    const ep = (provider.endpointMappings || {}) as Record<string, string>
    const rm = (provider.requestMappings || {}) as Record<string, any>
    console.log(`[syncProviderPlans] provider=${provider.code} strategy=${provider.adapterStrategy} isTemplate=${isTemplateDriven} GET_PLANS_EP=${ep.GET_PLANS || '(not set)'} hasRM_GET_PLANS=${!!rm.GET_PLANS}`)

    const planListPath = provider.planListPath || '/plans'
    diagnostics.endpoint = `${provider.apiBaseUrl || '(baseUrl)'}${planListPath.replace(/\{token\}/g, '{token}')}`

    // Log sync body for AirHub debugging
    if (provider.code === 'AIRHUB') {
      const config = (provider.config || {}) as any
      const rm = (provider.requestMappings || {}) as any
      console.log(`[AIRHUB_SYNC_BODY] provider.config:`, JSON.stringify({
        partnerCode: config.partnerCode,
        flag: config.flag,
        countryCode: config.countryCode,
        multiplecountrycode: config.multiplecountrycode,
      }))
      console.log(`[AIRHUB_SYNC_BODY] requestMappings.GET_PLANS:`, JSON.stringify(rm.GET_PLANS))
      diagnostics.syncBodyConfig = { partnerCode: config.partnerCode, flag: config.flag, countryCode: config.countryCode, multiplecountrycode: config.multiplecountrycode }
      diagnostics.syncBodyMapping = rm.GET_PLANS
      diagnostics.responseListKey = resolvedResponseListKey
    }

    const result = await adapter.syncPlans()

    if (!result.success) {
      diagnostics.responseStatus = -1
      diagnostics.providerError = result.error?.message || 'Unknown adapter error'
      await prisma.provider.update({
        where: { id: providerId },
        data: { lastSyncAt: new Date(), lastSyncResult: `Sync failed: ${result.error?.message || 'Unknown error'}`, lastSyncCount: 0 },
      }).catch(() => {})
      const errMsg = result.error?.message || 'Unknown error'
      await recordStageFromCounts({ pipelineRunId, stage: 'PROVIDER_SYNC', startTime: syncStartTime, total: 0, passed: 0, failed: 0, skipped: 0, statusOverride: 'FAILED', metadata: { error: errMsg } })
      await failPipelineRun(pipelineRunId, errMsg)
      return { error: `Sync failed: ${errMsg}`, diagnostics }
    }

    const plans = result.data || []

    diagnostics.fetchedCount = plans.length
    diagnostics.resolvedArrayLength = plans.length
    diagnostics.mappedPackageCount = plans.length
    diagnostics.lowCountWarning = plans.length > 0 && plans.length < 10

    if (adapter && 'getCapabilities' in adapter) {
      diagnostics.capabilities = adapter.getCapabilities().map((c: any) => c.key)
    }

    // Auto-detect capabilities from provider config
    const inferred = inferProviderCapabilities(provider)
    const capabilitiesUpdate = getPersistableCapabilities(inferred, provider)

    console.log('[syncProviderPlans] responseListKey=' + resolvedResponseListKey + ' plans=' + plans.length + ' endpointMappings.GET_PLANS=' + (provider.endpointMappings as any)?.GET_PLANS)

    // Create/update ProviderPackage records from synced plans using upsert
    let imported = 0, updated = 0, duplicatesSkipped = 0, skipped = 0
    for (const plan of plans) {
      const raw = plan.raw_data || {}
      const providerPlanId = plan.id || raw.id || raw.planCode || ''
      const providerPlanCode = raw.planCode || raw.sku || plan.sku || ''
      if (!providerPlanId) { skipped++; continue }

      // Look up existing first — use findFirst to avoid "subquery returns more than 1 row" on duplicate data
      let existing = await prisma.providerPackage.findFirst({
        where: { providerId, providerPlanId },
      }).catch(() => null)

      const pkgData = {
        providerPlanCode,
        name: plan.name || raw.planName || '',
        dataGB: plan.data_gb || parseInt(raw.dataAllowance) || 0,
        validityDays: plan.validity_days || parseInt(raw.validity) || 30,
        costPrice: plan.price_usd || parseFloat(raw.retailPrice) || 0,
        currency: plan.currency || 'USD',
        country: raw.country || raw.region || null,
        region: raw.region || null,
        planType: (raw.planType || raw.type || 'STANDARD') as string,
        // Availability is provider-declared (e.g. a deactivated Telna template).
        // Defaults to true when a connector does not set it. Never set to true
        // for a plan the provider marks unavailable.
        isAvailable: plan.isAvailable !== false,
        providerRawData: withTravelDateMarker(raw, normalizeTravelDateRequirement(raw)),
      }

      // Compute comparable key and effective cost
      const comparableKey = buildComparableKey({
        country: pkgData.country, region: pkgData.region, planType: pkgData.planType,
        dataGB: pkgData.dataGB, validityDays: pkgData.validityDays,
      })
      const { effectiveCostPrice, costSource } = computeEffectiveCost(
        Number(pkgData.costPrice),
        existing?.adminCostPrice ? Number(existing.adminCostPrice) : null,
      )

      // Phase 5C — normalize provider cost
      const normalizedStatus = Number(pkgData.costPrice) > 0 ? 'VALID' :
        (existing?.adminCostPrice && Number(existing.adminCostPrice) > 0) ? 'OVERRIDDEN' : 'MISSING'

      // Canonical pricing-state semantics: cost-valid does NOT imply READY. A
      // cost-valid package without an established pricing policy is
      // REQUIRES_PRICING (selling is never fabricated from cost alone). A
      // package with an established policy whose provider cost changed is
      // REQUIRES_RECALCULATION, and repricing runs after the cost write.
      const providerCostWritten = Number(pkgData.costPrice)
      const reportedProviderCost = plan.price_usd ? providerCostWritten : Number(existing?.costPrice ?? providerCostWritten)
      const pricingStatus = resolvePricingStateOnCostSync({
        costStatus: normalizedStatus,
        providerCost: reportedProviderCost,
        previousCost: existing?.costPrice ?? null,
        existingPolicy: existing,
        existingPricingStatus: existing?.pricingStatus,
      })
      const shouldRecalculate = pricingStatus === PRICING_STATUS.REQUIRES_RECALCULATION

      ;(pkgData as any).costStatus = normalizedStatus
      ;(pkgData as any).pricingStatus = pricingStatus
      ;(pkgData as any).costReceivedAt = new Date()

      try {
        let persistedId: string | null = null
        if (existing) {
          const result = await prisma.providerPackage.update({
            where: { id: existing.id },
            data: {
              ...pkgData,
              comparableKey,
              effectiveCostPrice,
              costSource,
              readyToPublish: existing.readyToPublish,
              // Only overwrite costPrice if provider sends it and admin hasn't set a custom one
              ...(plan.price_usd ? {} : { costPrice: existing.costPrice }),
            },
          })
          persistedId = result?.id ?? existing.id
          updated++
        } else {
          // Fallback: check by providerId + providerPlanCode if no match by planId
          if (providerPlanCode) {
            const fallback = await prisma.providerPackage.findFirst({
              where: { providerId, providerPlanCode, providerPlanId: { not: providerPlanId } },
            })
            if (fallback) {
              const result = await prisma.providerPackage.update({
                where: { id: fallback.id },
                data: { ...pkgData, providerPlanId, comparableKey, effectiveCostPrice, costSource },
              })
              persistedId = result?.id ?? fallback.id
              updated++
              // A fallback match means a policy may exist on that row; treat it
              // like an existing row so a cost change reprices it.
              if (shouldRecalculate) {
                await recalculateProviderPackageAfterCostChange(persistedId)
              }
              continue
            }
          }

          const result = await prisma.providerPackage.create({
            data: { providerId, providerPlanId, ...pkgData, comparableKey, effectiveCostPrice, costSource },
          })
          persistedId = result?.id ?? null
          imported++
        }

        // New rows carry no established policy, so create never reprices. Only
        // existing relationships (updated/fallback) can reach REQUIRES_RECALCULATION.
        if (existing && shouldRecalculate) {
          await recalculateProviderPackageAfterCostChange(persistedId)
        }
      } catch (e: any) {
        if (e.code === 'P2002') {
          try {
            const retry = await prisma.providerPackage.findFirst({
              where: { providerId, providerPlanId },
            })
            if (retry) {
              await prisma.providerPackage.update({
                where: { id: retry.id },
                data: { ...pkgData, comparableKey, effectiveCostPrice, costSource, readyToPublish: retry.readyToPublish },
              })
              // The row already existed — honor the policy-implied repricing.
              if (shouldRecalculate) {
                await recalculateProviderPackageAfterCostChange(retry.id)
              }
              duplicatesSkipped++
            }
          } catch { skipped++ }
        } else { skipped++ }
      }
    }

    const syncResult = `Synced ${plans.length} plans: ${imported} created, ${updated} updated, ${duplicatesSkipped} duplicate attempts skipped`
    console.log(`[syncProviderPlans] ${syncResult}`)

    // Update diagnostics with counts after processing loop
    diagnostics.imported = imported
    diagnostics.updated = updated
    diagnostics.skipped = skipped
    diagnostics.duplicatesSkipped = duplicatesSkipped

    // Update sync result with detailed counts
    await prisma.provider.update({
      where: { id: providerId },
      data: {
        lastSyncAt: new Date(),
        lastSyncResult: syncResult,
        lastSyncCount: plans.length,
        ...capabilitiesUpdate,
      },
    })

    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'PROVIDER_PLANS_SYNCED',
        entity: 'Provider',
        entityId: provider.code,
        details: `Synced ${plans.length} plans from "${provider.name}" (strategy: ${diagnostics.adapterStrategy}). Inferred capabilities: ${Object.keys(capabilitiesUpdate).join(', ') || 'none'}`,
      },
    })

    revalidatePath(`/admin/providers/${providerId}`)

    await recordStageFromCounts({
      pipelineRunId, stage: 'PROVIDER_SYNC', startTime: syncStartTime,
      total: plans.length, passed: imported + updated, failed: skipped, skipped: duplicatesSkipped,
      statusOverride: skipped > 0 ? 'PARTIAL' : 'SUCCESS',
      metadata: { imported, updated, duplicatesSkipped, skipped },
    })
    await completePipelineRun(pipelineRunId, skipped > 0 ? 'PARTIAL' : 'SUCCESS', imported + updated)

    const { emitEvent } = await import('@/lib/catalog-events')
    emitEvent({
      eventType: 'PROVIDER_SYNC_COMPLETED',
      providerId: provider.id,
      providerCode: provider.code,
      packageId: null,
      comparableKey: null,
      changedFields: [],
      trigger: 'USER_ACTION',
      userId: session.user.id,
      metadata: { imported, updated, duplicatesSkipped, total: plans.length },
    })

    return { success: `Fetched ${plans.length} plans from ${provider.name}.`, plans, diagnostics, inferredCapabilities: Object.keys(capabilitiesUpdate) }
  } catch (error: any) {
    await prisma.provider.update({
      where: { id: providerId },
      data: {
        lastSyncAt: new Date(),
        lastSyncResult: `Sync failed: ${error.message || 'Unknown error'}`,
        lastSyncCount: 0,
      },
    }).catch(() => {})

    await recordStageFromCounts({ pipelineRunId, stage: 'PROVIDER_SYNC', startTime: syncStartTime, total: 0, passed: 0, failed: 0, skipped: 0, statusOverride: 'FAILED', metadata: { error: error.message || 'Unknown' } })
    await failPipelineRun(pipelineRunId, error.message || 'Unknown error')

    return { error: `Sync failed: ${error.message || 'Unknown error'}`, diagnostics }
  }
}

/**
 * Canonical cost-change repricing after a provider cost write.
 *
 * Runs the single pricing engine (recalculatePackagePrice) which derives the
 * selling price from the established rule/policy, creates a new price snapshot,
 * validates the minimum margin, and sets pricingStatus=READY. Only on success do
 * we synchronize a linked retail ESIMPackage through the existing catalog-price
 * sync service — preserving publication state and never creating a second retail
 * row.
 *
 * On failure the row is left non-ready (recalculatePackagePrice already writes an
 * explicit failure state such as MARGIN_BELOW_MINIMUM / CALCULATION_FAILED /
 * EXCHANGE_RATE_MISSING) and the retail side is NOT rewritten, so purchase
 * readiness stays fail-closed.
 */
async function recalculateProviderPackageAfterCostChange(packageId: string): Promise<void> {
  const result = await recalculatePackagePrice(packageId, 'PROVIDER_COST_CHANGED')
  if (!result.success) {
    console.log(`[PROVIDER_COST_REPRICE] ${packageId} blocked: ${result.reason || result.pricingStatus}`)
    return
  }

  // Success — synchronize a linked retail package to the new canonical selling
  // price (preserving publication, no duplicate retail row). Read once inside a
  // transaction so the sync uses post-recalculation values.
  try {
    await prisma.$transaction(async (tx) => {
      const pp = await tx.providerPackage.findUnique({
        where: { id: packageId },
        select: {
          id: true, name: true, dataGB: true, validityDays: true, costPrice: true, currency: true,
          sellingPrice: true, sellingCurrency: true, markupPercent: true, providerPlanId: true,
          providerId: true, publishStatus: true,
        },
      })
      if (!pp) return
      await syncProviderPackageToPublishedProducts(tx, {
        id: pp.id,
        name: pp.name,
        dataGB: pp.dataGB,
        validityDays: pp.validityDays,
        costPrice: pp.costPrice,
        currency: pp.currency,
        sellingPrice: pp.sellingPrice,
        sellingCurrency: pp.sellingCurrency,
        markupPercent: pp.markupPercent,
        providerPlanId: pp.providerPlanId,
        providerId: pp.providerId,
        publishStatus: pp.publishStatus,
      })
    })
  } catch (e: any) {
    // Retail sync failure must not leave the package priced-but-stale silently:
    // log and surface via the row (recalc already wrote READY; a subsequent
    // purchase-price-guard / parity audit will flag a drift). Do not roll back
    // the provider cost (upstream already changed) and do not rewrite retail.
    console.error(`[PROVIDER_COST_REPRICE] ${packageId} retail sync failed: ${e.message}`)
  }
}

export async function importProviderPlan(providerId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) redirect(`/admin/providers?error=Provider+not+found`)

  const planRawData = formData.get('planRawData') as string
  const planData = planRawData ? (() => { try { return JSON.parse(planRawData) } catch { return null } })() : null

  const planId = formData.get('planId') as string
  const planName = formData.get('planName') as string

  let normalized
  if (!planId || !planName) {
    if (!planData) {
      redirect(`/admin/providers/${providerId}?error=${encodeURIComponent('Invalid plan data: missing id/name and no raw data available')}`)
    }
    normalized = normalizePlan(planData)
    if (!normalized.providerPlanId || !normalized.name) {
      const rawKeys = planData ? Object.keys(planData).join(', ') : 'none'
      redirect(`/admin/providers/${providerId}?error=${encodeURIComponent(`Invalid plan data: could not find id or name in raw data (keys: ${rawKeys})`)}`)
    }
  }

  const resolvedPlanId = normalized ? normalized.providerPlanId : planId
  const resolvedName = normalized ? normalized.name : planName
  const resolvedDataGB = normalized ? normalized.dataGB : (parseInt(formData.get('planDataGB') as string, 10) || 1)
  const resolvedValidityDays = normalized ? normalized.validityDays : (parseInt(formData.get('planValidityDays') as string, 10) || 30)
  const resolvedCostPriceUSD = normalized ? normalized.costPriceUSD : (parseFloat(formData.get('planPriceUSD') as string) || 0)
  const resolvedDescription = normalized ? normalized.description : (formData.get('planDescription') as string || '')
  const resolvedRawData = normalized ? normalized.rawData : planData

  try {
    // Write to ProviderPackage (raw catalog), not ESIMPackage
    const existing = await prisma.providerPackage.findFirst({
      where: { providerId, providerPlanId: resolvedPlanId },
    })

    if (existing) {
      await prisma.providerPackage.update({
        where: { id: existing.id },
        data: {
          name: resolvedName,
          dataGB: resolvedDataGB,
          validityDays: resolvedValidityDays,
          costPrice: resolvedCostPriceUSD,
          providerRawData: resolvedRawData,
          isAvailable: true,
        },
      })

      await advanceCertificationTo(providerId, 'PLANS_IMPORTED')

      await prisma.auditLog.create({
        data: { userId: session.user.id, action: 'PROVIDER_PLAN_UPDATED', entity: 'ProviderPackage', entityId: existing.id, details: `Updated package from ${provider.code} plan: ${resolvedName} (${resolvedPlanId})` },
      })

      revalidatePath(`/admin/providers/${providerId}`)
      revalidatePath('/admin/provider-catalog')
      redirect(`/admin/providers/${providerId}?synced=true&success=${encodeURIComponent(`Package "${resolvedName}" updated. Configure pricing in Provider Catalog.`)}`)
    }

    await prisma.providerPackage.create({
      data: {
        providerId,
        providerPlanId: resolvedPlanId,
        name: resolvedName,
        dataGB: resolvedDataGB,
        validityDays: resolvedValidityDays,
        costPrice: resolvedCostPriceUSD,
        currency: 'USD',
        isAvailable: true,
        providerRawData: resolvedRawData,
        configurationStatus: 'UNCONFIGURED',
      },
    })

    await advanceCertificationTo(providerId, 'PLANS_IMPORTED')

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'PROVIDER_PLAN_IMPORTED', entity: 'ProviderPackage', entityId: resolvedPlanId, details: `Imported package from ${provider.code} plan: ${resolvedName} (${resolvedPlanId})` },
    })

    revalidatePath(`/admin/providers/${providerId}`)
    revalidatePath('/admin/provider-catalog')
    redirect(`/admin/providers/${providerId}?synced=true&success=${encodeURIComponent(`Package "${resolvedName}" imported. Configure pricing in Provider Catalog.`)}`)
  } catch (error: any) {
    redirect(`/admin/providers/${providerId}?synced=true&error=${encodeURIComponent(`Failed to import: ${error.message || 'Unknown error'}`)}`)
  }
}


