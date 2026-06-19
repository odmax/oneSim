'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { generateSku, generatePackageCode } from '@/lib/packages/resolve-package'
import { buildAdapter } from '@/lib/providers/adapter-manager'
import { normalizePlan } from '@/lib/providers/plan-utils'
import type { ProviderPlan } from '@/lib/providers/adapter-types'
import { buildComparableKey, computeEffectiveCost } from '@/lib/packages/cheapest-utils'

export type { ProviderPlan }

function extractCountry(rawData: string): string | null {
  try {
    const parsed = JSON.parse(rawData)
    return parsed.country || parsed.region || null
  } catch {
    return null
  }
}

function inferCapabilitiesFromProvider(provider: any): Record<string, boolean> {
  const planListPath = provider.planListPath || ''
  const responseListKey = provider.responseListKey || ''
  const ep = (provider.endpointMappings || {}) as Record<string, string>

  const capabilities: Record<string, boolean> = {}

  // Direct path fields take priority, then endpoint mappings
  capabilities.supportsESIM = true
  capabilities.supportsPlanSync = !!(planListPath || ep.GET_PLANS)
  capabilities.supportsQRCode = !!(provider.activationPath || ep.GET_ACTIVATION_CODE)
  capabilities.supportsUsage = !!(provider.usagePath || provider.statusPath || ep.GET_USAGE)
  capabilities.supportsUsageSync = !!(provider.usagePath || ep.GET_USAGE)
  capabilities.supportsSuspend = !!(provider.suspendPath || ep.SUSPEND_ESIM)
  capabilities.supportsSuspendResume = !!((provider.suspendPath && provider.resumePath) || (ep.SUSPEND_ESIM && ep.RESUME_ESIM))
  capabilities.supportsTopUp = !!(provider.topUpPath || ep.PURCHASE_TOPUP || ep.GET_TOPUP_PLANS || ep.TOP_UP || ep.RENEW_ESIM)
  capabilities.supportsWallet = !!(ep.GET_WALLET || ep.WALLET_BALANCE)
  capabilities.supportsOrderLookup = !!(ep.GET_ORDER_DETAIL || ep.GET_ORDER_DETAILS || ep.ORDER_DETAILS)
  capabilities.supportsInventory = !!(ep.GET_INVENTORY || ep.GET_PARTNER_INVENTORY_COUNT)
  capabilities.supportsCountryCatalog = !!(ep.GET_COUNTRIES || ep.COUNTRY_REGION_DETAILS)
  capabilities.supportsRenewals = !!(ep.INSERT_RENEW || ep.GET_RENEW_DATA || ep.RENEW_ESIM)
  capabilities.supportsBundleTemplates = planListPath.includes('bundle_templates') || responseListKey === 'bundle_template_list'

  return capabilities
}

export async function syncProviderPlans(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { error: 'Provider not found' }

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
    tokenLength: provider.apiToken ? 1 : 0,
    tokenPlacement: provider.tokenPlacement || 'BEARER_HEADER',
    planListPath: resolvedPlanListPath,
    responseListKey: resolvedResponseListKey,
    endpoint: '',
    responseStatus: 0,
    responseKeys: [],
    fetchedCount: 0,
    lowCountWarning: false,
  }

  try {
    const strategy = provider.adapterStrategy
    if (!strategy) {
      return { error: `Cannot sync: adapterStrategy is not configured for provider "${provider.name}". Go to Edit Provider to set a protocol strategy.`, diagnostics }
    }

    const adapter = await buildAdapter(provider)
    if (!adapter) return { error: `No adapter available for provider type "${provider.type}" / strategy "${strategy}"`, diagnostics }

    // Log sync context for debugging
    const isTemplateDriven = !!(provider.providerTemplateId || provider.adapterStrategy === 'TEMPLATE')
    const ep = (provider.endpointMappings || {}) as Record<string, string>
    const rm = (provider.requestMappings || {}) as Record<string, any>
    console.log(`[syncProviderPlans] provider=${provider.code} strategy=${provider.adapterStrategy} isTemplate=${isTemplateDriven} GET_PLANS_EP=${ep.GET_PLANS || '(not set)'} hasRM_GET_PLANS=${!!rm.GET_PLANS}`)

    const planListPath = provider.planListPath || '/plans'
    diagnostics.endpoint = `${provider.apiBaseUrl || '(baseUrl)'}${planListPath.replace(/\{token\}/g, '{token}')}`

    const result = await adapter.syncPlans()

    if (!result.success) {
      diagnostics.responseStatus = -1
      diagnostics.providerError = result.error?.message || 'Unknown adapter error'
      await prisma.provider.update({
        where: { id: providerId },
        data: { lastSyncAt: new Date(), lastSyncResult: `Sync failed: ${result.error?.message || 'Unknown error'}`, lastSyncCount: 0 },
      }).catch(() => {})
      return { error: `Sync failed: ${result.error?.message || 'Unknown'}`, diagnostics }
    }

    const plans = result.data || []

    diagnostics.fetchedCount = plans.length
    diagnostics.lowCountWarning = plans.length > 0 && plans.length < 10

    if (adapter && 'getCapabilities' in adapter) {
      diagnostics.capabilities = adapter.getCapabilities().map((c: any) => c.key)
    }

    // Auto-detect capabilities from provider config (don't override manual true settings)
    const VALID_CAP_KEYS = new Set(['supportsESIM', 'supportsUsage', 'supportsTopUp', 'supportsSuspend', 'supportsQRCode', 'supportsPools', 'supportsTemplates', 'supportsUsageSync', 'supportsWebhookPush', 'supportsSuspendResume'])
    const inferred = inferCapabilitiesFromProvider(provider)
    const capabilitiesUpdate: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(inferred)) {
      if (VALID_CAP_KEYS.has(key) && value && !(provider as any)[key]) {
        capabilitiesUpdate[key] = true
      }
    }

    console.log('[syncProviderPlans] responseListKey=' + resolvedResponseListKey + ' plans=' + plans.length + ' endpointMappings.GET_PLANS=' + (provider.endpointMappings as any)?.GET_PLANS)

    // Create/update ProviderPackage records from synced plans using upsert
    let imported = 0, updated = 0, duplicatesSkipped = 0, skipped = 0
    for (const plan of plans) {
      const raw = plan.raw_data || {}
      const providerPlanId = plan.id || raw.id || raw.planCode || ''
      const providerPlanCode = raw.planCode || raw.sku || plan.sku || ''
      if (!providerPlanId) { skipped++; continue }

      // Look up existing first
      let existing = await prisma.providerPackage.findUnique({
        where: { providerId_providerPlanId: { providerId, providerPlanId } },
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
        isAvailable: true,
        providerRawData: raw,
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

      try {
        if (existing) {
          await prisma.providerPackage.update({
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
          updated++
        } else {
          // Fallback: check by providerId + providerPlanCode if no match by planId
          if (providerPlanCode) {
            const fallback = await prisma.providerPackage.findFirst({
              where: { providerId, providerPlanCode, providerPlanId: { not: providerPlanId } },
            })
            if (fallback) {
              await prisma.providerPackage.update({
                where: { id: fallback.id },
                data: { ...pkgData, providerPlanId, comparableKey, effectiveCostPrice, costSource },
              })
              updated++
              continue
            }
          }

          await prisma.providerPackage.create({
            data: { providerId, providerPlanId, ...pkgData, comparableKey, effectiveCostPrice, costSource },
          })
          imported++
        }
      } catch (e: any) {
        if (e.code === 'P2002') {
          try {
            const retry = await prisma.providerPackage.findUnique({
              where: { providerId_providerPlanId: { providerId, providerPlanId } },
            })
            if (retry) {
              await prisma.providerPackage.update({
                where: { id: retry.id },
                data: { ...pkgData, comparableKey, effectiveCostPrice, costSource, readyToPublish: retry.readyToPublish },
              })
              duplicatesSkipped++
            }
          } catch { skipped++ }
        } else { skipped++ }
      }
    }

    const syncResult = `Synced ${plans.length} plans: ${imported} created, ${updated} updated, ${duplicatesSkipped} duplicate attempts skipped`
    console.log(`[syncProviderPlans] ${syncResult}`)

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
    return { error: `Sync failed: ${error.message || 'Unknown error'}`, diagnostics }
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
    const sku = generateSku(resolvedName, resolvedDataGB, resolvedValidityDays, provider.code)
    let packageCode = generatePackageCode(resolvedDataGB, resolvedValidityDays)

    let existingCode = await prisma.eSIMPackage.findUnique({ where: { packageCode } })
    while (existingCode) {
      packageCode = generatePackageCode(resolvedDataGB, resolvedValidityDays)
      existingCode = await prisma.eSIMPackage.findUnique({ where: { packageCode } })
    }

    const existingPackage = await prisma.eSIMPackage.findFirst({
      where: { providerId, providerPlanId: resolvedPlanId },
    })

    if (existingPackage) {
      await prisma.eSIMPackage.update({
        where: { id: existingPackage.id },
        data: {
          source: 'PROVIDER_PLAN',
          name: resolvedName,
          description: resolvedDescription || existingPackage.description,
          dataGB: resolvedDataGB,
          validityDays: resolvedValidityDays,
          costPriceUSD: resolvedCostPriceUSD,
          priceUSD: 0,
          localPrice: 0,
          providerRawData: resolvedRawData,
          sku: existingPackage.sku || sku,
          packageCode: existingPackage.packageCode || packageCode,
        },
      })

      await prisma.auditLog.create({
        data: { userId: session.user.id, action: 'PROVIDER_PLAN_UPDATED', entity: 'ESIMPackage', entityId: existingPackage.id, details: `Updated package from ${provider.code} plan: ${resolvedName} (${resolvedPlanId})` },
      })

      revalidatePath(`/admin/providers/${providerId}`)
      revalidatePath('/admin/packages')
      redirect(`/admin/providers/${providerId}?synced=true&success=${encodeURIComponent(`Package "${resolvedName}" updated. Set selling price and activate manually.`)}`)
    }

    await prisma.eSIMPackage.create({
      data: {
        source: 'PROVIDER_PLAN',
        name: resolvedName,
        description: resolvedDescription || `Imported from ${provider.name}: ${resolvedName}`,
        dataGB: resolvedDataGB,
        validityDays: resolvedValidityDays,
        priceUSD: 0,
        localPrice: 0,
        currency: 'USD',
        isActive: false,
        sku,
        packageCode,
        providerId,
        providerName: provider.code,
        providerPlanId: resolvedPlanId,
        providerRawData: resolvedRawData,
        costPriceUSD: resolvedCostPriceUSD,
      },
    })

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'PROVIDER_PLAN_IMPORTED', entity: 'ESIMPackage', entityId: resolvedPlanId, details: `Imported package from ${provider.code} plan: ${resolvedName} (${resolvedPlanId})` },
    })

    revalidatePath(`/admin/providers/${providerId}`)
    revalidatePath('/admin/packages')
    redirect(`/admin/providers/${providerId}?synced=true&success=${encodeURIComponent(`Package "${resolvedName}" imported. Set selling price and activate manually.`)}`)
  } catch (error: any) {
    redirect(`/admin/providers/${providerId}?synced=true&error=${encodeURIComponent(`Failed to import: ${error.message || 'Unknown error'}`)}`)
  }
}


