import { prisma } from '@/lib/prisma'
import { finalizeCatalogPackageConfiguration } from '@/lib/pricing/configuration-finalizer'
import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'

export interface PublishToRetailResult {
  success: boolean
  providerPackageId: string
  retailPackageId?: string
  created: boolean
  updated: boolean
  publishStatusSet: boolean
  ready: boolean
  readinessReasons: string[]
  error?: string
  failedStage?: 'PROVIDER_PACKAGE_NOT_FOUND' | 'FINALIZATION_FAILED' | 'RETAIL_READINESS_FAILED' | 'TRANSACTION_FAILED'
}

/**
 * Canonical publish service.
 *
 * Required flow:
 * 1. Load ProviderPackage + provider.
 * 2. Run finalizeCatalogPackageConfiguration() (creates snapshot, sets pricingStatus=READY).
 * 3. Create or update ESIMPackage with correct source/active/visible fields.
 * 4. Link providerPackageId on the retail package.
 * 5. Verify getPackagePurchaseReadiness() returns ready=true.
 * 6. Only then set ProviderPackage.publishStatus=PUBLISHED.
 *
 * This is the ONLY path that may set publishStatus=PUBLISHED.
 */
export async function publishProviderPackageToRetailCatalog(
  providerPackageId: string,
  options?: { reason?: string },
): Promise<PublishToRetailResult> {
  const reason = options?.reason || 'PUBLISH'

  // Step 1: Load ProviderPackage with provider
  const pp = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    include: { provider: { select: { id: true, name: true, code: true } } },
  })
  if (!pp) {
    return { success: false, providerPackageId, created: false, updated: false, publishStatusSet: false, ready: false, readinessReasons: [], failedStage: 'PROVIDER_PACKAGE_NOT_FOUND', error: 'Provider package not found' }
  }

  // Step 2: Finalize — create snapshot + pricing
  const finalized = await finalizeCatalogPackageConfiguration(providerPackageId, { reason })
  if (!finalized.success) {
    return { success: false, providerPackageId, created: false, updated: false, publishStatusSet: false, ready: false, readinessReasons: finalized.readinessReasons, failedStage: 'FINALIZATION_FAILED', error: finalized.error || 'Finalization failed' }
  }

  // Step 3: Create or update the retail ESIMPackage
  let retailPackageId: string | undefined
  let created = false
  let updated = false

  const sellPrice = Number(pp.sellingPrice || 0)

  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.eSIMPackage.findFirst({
        where: { providerPackageId: providerPackageId },
      })

      if (existing) {
        // Update existing: ensure active, visible, correctly sourced
        await tx.eSIMPackage.update({
          where: { id: existing.id },
          data: {
            name: pp.name,
            displayName: pp.name,
            dataGB: pp.dataGB,
            validityDays: pp.validityDays,
            priceUSD: sellPrice,
            localPrice: sellPrice,
            currency: pp.sellingCurrency || 'USD',
            providerName: pp.provider?.name || null,
            providerPlanId: pp.providerPlanId,
            providerId: pp.providerId,
            costPriceUSD: pp.costPrice,
            costCurrency: pp.currency,
            markupPercent: pp.markupPercent,
            source: 'CATALOG_PRODUCT',
            isActive: true,
            hiddenFromCatalog: false,
            archivedAt: null,
            providerPackageId: providerPackageId,
          },
        })
        retailPackageId = existing.id
        updated = true
      } else {
        // Create new retail package
        const sku = await generateSku(tx, pp)
        const retail = await tx.eSIMPackage.create({
          data: {
            name: pp.name,
            displayName: pp.name,
            dataGB: pp.dataGB,
            validityDays: pp.validityDays,
            priceUSD: sellPrice,
            localPrice: sellPrice,
            currency: pp.sellingCurrency || 'USD',
            providerName: pp.provider?.name || null,
            providerPlanId: pp.providerPlanId,
            providerId: pp.providerId,
            sku,
            packageCode: sku,
            costPriceUSD: pp.costPrice,
            costCurrency: pp.currency,
            markupPercent: pp.markupPercent,
            source: 'CATALOG_PRODUCT',
            isActive: true,
            hiddenFromCatalog: false,
            archivedAt: null,
            providerPackageId: providerPackageId,
          },
        })
        retailPackageId = retail.id
        created = true
      }
    })
  } catch (e: any) {
    return { success: false, providerPackageId, created, updated, publishStatusSet: false, ready: false, readinessReasons: [], failedStage: 'TRANSACTION_FAILED', error: e.message || 'Retail package creation failed' }
  }

  // Step 4: Verify readiness with the newly created/updated retail package
  const retail = await prisma.eSIMPackage.findUnique({
    where: { id: retailPackageId },
    include: {
      providerPackage: { select: { costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true } },
      provider: { select: { status: true, enabledCapabilities: true, code: true } },
    },
  })

  if (!retail) {
    return { success: false, providerPackageId, retailPackageId, created, updated, publishStatusSet: false, ready: false, readinessReasons: ['Retail package not found after creation'], failedStage: 'RETAIL_READINESS_FAILED' }
  }

  const readiness = getPackagePurchaseReadiness({
    pkg: { isActive: retail.isActive, hiddenFromCatalog: retail.hiddenFromCatalog, archivedAt: retail.archivedAt, source: retail.source, providerPackageId: retail.providerPackageId },
    providerPkg: retail.providerPackage,
    provider: retail.provider,
  })

  if (!readiness.ready) {
    return { success: false, providerPackageId, retailPackageId, created, updated, publishStatusSet: false, ready: false, readinessReasons: readiness.reasons, failedStage: 'RETAIL_READINESS_FAILED', error: readiness.reasons[0] }
  }

  // Step 5: Set PUBLISHED — only after all checks pass
  await prisma.providerPackage.update({
    where: { id: providerPackageId },
    data: { publishStatus: 'PUBLISHED' },
  })

  return { success: true, providerPackageId, retailPackageId, created, updated, publishStatusSet: true, ready: true, readinessReasons: [] }
}

async function generateSku(tx: any, pp: { id: string; provider?: { code?: string | null; name?: string | null } | null; country?: string | null; dataGB: number; validityDays: number }): Promise<string> {
  const provCode = (pp.provider?.code || pp.provider?.name || 'XX').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase()
  const country = (pp.country || 'XX').toUpperCase()
  const base = `OS-${provCode}-${country}-${pp.dataGB}GB-${pp.validityDays}D-${pp.id.slice(-6).toUpperCase()}`
  let sku = base
  let attempt = 0
  while (attempt < 100) {
    const exists = await tx.eSIMPackage.findUnique({ where: { sku }, select: { id: true } })
    if (!exists) return sku
    attempt++
    sku = `${base}-${attempt}`
  }
  return `${base}-${pp.id.slice(-8).toUpperCase()}`
}
