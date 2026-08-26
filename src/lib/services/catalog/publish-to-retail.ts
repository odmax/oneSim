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
 * 2. Run finalizeCatalogPackageConfiguration() in PRE_PUBLISH mode (creates
 *    snapshot, sets pricingStatus=READY, verifies eligibility + readiness
 *    WITHOUT requiring PUBLISHED).
 * 2b. RELOAD ProviderPackage — finalization may have updated sellingPrice,
 *    markupPercent, effectiveCostPrice, costStatus, activePriceSnapshotId.
 *    The retail write MUST use post-finalization values, not the stale
 *    initial load.
 * 3. Create or update the retail ESIMPackage (first-time publish creates it).
 * 4. Transition ProviderPackage → PUBLISHED (same transaction as retail so
 *    there is no partial state where PUBLISHED but retail creation failed).
 * 5. Perform STRICT PURCHASE readiness verification on the final state —
 *    this requires publishStatus === PUBLISHED.
 * 6. Return success only when the final state is genuinely purchasable.
 *
 * This is the ONLY path that may set publishStatus=PUBLISHED.
 */
export async function publishProviderPackageToRetailCatalog(
  providerPackageId: string,
  options?: { reason?: string },
): Promise<PublishToRetailResult> {
  const reason = options?.reason || 'PUBLISH'

  // Step 1: Load ProviderPackage with provider
  const initialPp = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    include: { provider: { select: { id: true, name: true, code: true } } },
  })
  if (!initialPp) {
    return { success: false, providerPackageId, created: false, updated: false, publishStatusSet: false, ready: false, readinessReasons: [], failedStage: 'PROVIDER_PACKAGE_NOT_FOUND', error: 'Provider package not found' }
  }

  // Step 2: Finalize — create snapshot + pricing (PRE_PUBLISH readiness)
  const finalized = await finalizeCatalogPackageConfiguration(providerPackageId, { reason })
  if (!finalized.success) {
    return { success: false, providerPackageId, created: false, updated: false, publishStatusSet: false, ready: false, readinessReasons: finalized.readinessReasons, failedStage: 'FINALIZATION_FAILED', error: finalized.error || 'Finalization failed' }
  }

  // Step 2b: RELOAD ProviderPackage after finalization.
  // recalculatePackagePrice() inside finalization may have updated sellingPrice,
  // sellingCurrency, markupPercent, effectiveCostPrice, costStatus, and
  // activePriceSnapshotId. The initial load (Step 1) is stale — the retail write
  // MUST use the post-finalization values.
  const pp = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    include: { provider: { select: { id: true, name: true, code: true } } },
  })
  if (!pp) {
    return { success: false, providerPackageId, created: false, updated: false, publishStatusSet: false, ready: false, readinessReasons: [], failedStage: 'PROVIDER_PACKAGE_NOT_FOUND', error: 'Provider package not found after finalization' }
  }

  // Step 3 + 4: Create/update the retail ESIMPackage AND transition to
  // PUBLISHED in the same transaction so a partial state can never exist.
  let retailPackageId: string | undefined
  let created = false
  let updated = false
  let publishStatusSet = false

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

      // Transition to PUBLISHED in the same transaction as retail create/update.
      await tx.providerPackage.update({
        where: { id: providerPackageId },
        data: { publishStatus: 'PUBLISHED' },
      })
      publishStatusSet = true
    })
  } catch (e: any) {
    return { success: false, providerPackageId, created, updated, publishStatusSet: false, ready: false, readinessReasons: [], failedStage: 'TRANSACTION_FAILED', error: e.message || 'Retail package creation failed' }
  }

  // Step 5: STRICT PURCHASE readiness verification on the final state.
  // PUBLISHED was already set inside the transaction, so this genuinely
  // verifies the package is purchasable by clients (publishStatus === PUBLISHED).
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

  // Default mode is PURCHASE (strict): requires publishStatus === PUBLISHED.
  const readiness = getPackagePurchaseReadiness({
    pkg: { isActive: retail.isActive, hiddenFromCatalog: retail.hiddenFromCatalog, archivedAt: retail.archivedAt, source: retail.source, providerPackageId: retail.providerPackageId },
    providerPkg: retail.providerPackage,
    provider: retail.provider,
  })

  if (!readiness.ready) {
    return { success: false, providerPackageId, retailPackageId, created, updated, publishStatusSet: false, ready: false, readinessReasons: readiness.reasons, failedStage: 'RETAIL_READINESS_FAILED', error: readiness.reasons[0] }
  }

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
