import { prisma } from '@/lib/prisma'
import { recalculatePackagePrice } from '@/lib/pricing/price-recalculation-service'
import { getPackagePurchaseReadiness, type PackageReadiness } from '@/lib/packages/purchase-readiness'

export interface FinalizeResult {
  success: boolean
  providerPackageId: string
  snapshotCreated: boolean
  snapshotId?: string
  ready: boolean
  readinessReasons: string[]
  failedStage?: 'PACKAGE_NOT_FOUND' | 'PRICING_CALCULATION_FAILED' | 'SNAPSHOT_MISSING' | 'READINESS_FAILED'
  error?: string
}

/**
 * Canonical configuration finalizer.
 *
 * Before marking a provider package as CONFIGURED or PUBLISHED, this function:
 * 1. Loads all required pricing/provider data
 * 2. Runs canonical price recalculation (creates snapshot)
 * 3. Verifies active snapshot exists
 * 4. Runs purchase readiness check
 * 5. Returns success only if all steps pass
 *
 * This is the single gate between raw provider data and a saleable product.
 */
export async function finalizeCatalogPackageConfiguration(
  providerPackageId: string,
  options?: { reason?: string },
): Promise<FinalizeResult> {
  const reason = options?.reason || 'CONFIGURATION_FINALIZATION'

  // Step 1: Load package with all dependencies
  const pp = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    select: {
      id: true, costStatus: true, pricingStatus: true, publishStatus: true,
      configurationStatus: true, activePriceSnapshotId: true,
      sellingPrice: true, sellingCurrency: true, costPrice: true, adminCostPrice: true,
      providerId: true,
      provider: { select: { status: true, enabledCapabilities: true, code: true } },
    },
  })
  if (!pp) {
    return { success: false, providerPackageId, snapshotCreated: false, ready: false, readinessReasons: [], failedStage: 'PACKAGE_NOT_FOUND', error: 'Provider package not found' }
  }

  // Step 2: Run canonical price recalculation. This creates/activates the snapshot
  // and sets pricingStatus=READY with activePriceSnapshotId.
  const calcResult = await recalculatePackagePrice(providerPackageId, reason as any)
  if (!calcResult.success) {
    return {
      success: false, providerPackageId, snapshotCreated: false, ready: false,
      readinessReasons: [calcResult.reason || 'Pricing calculation failed'],
      failedStage: 'PRICING_CALCULATION_FAILED',
      error: calcResult.reason || 'Pricing calculation failed',
    }
  }

  // Step 3: Verify snapshot exists and is ACTIVE on provider package
  const verified = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    select: {
      id: true, activePriceSnapshotId: true, costStatus: true, pricingStatus: true,
      publishStatus: true, configurationStatus: true, sellingPrice: true, costPrice: true,
      provider: { select: { status: true, enabledCapabilities: true, code: true } },
    },
  })

  if (!verified?.activePriceSnapshotId) {
    return {
      success: false, providerPackageId, snapshotCreated: true, ready: false,
      readinessReasons: ['Snapshot link missing after recalculation'],
      failedStage: 'SNAPSHOT_MISSING',
      error: 'Price snapshot was not linked to package',
    }
  }

  // Step 4: Verify snapshot object is ACTIVE
  const snapshot = await prisma.packagePriceSnapshot.findUnique({
    where: { id: verified.activePriceSnapshotId },
    select: { id: true, status: true },
  })
  if (!snapshot || snapshot.status !== 'ACTIVE') {
    return {
      success: false, providerPackageId, snapshotCreated: true, ready: false,
      readinessReasons: ['Snapshot not ACTIVE after recalculation'],
      failedStage: 'SNAPSHOT_MISSING',
      error: 'Price snapshot exists but is not ACTIVE',
    }
  }

  // Step 5: Run centralized purchase readiness
  const readiness = getPackagePurchaseReadiness({
    providerPkg: {
      costStatus: verified.costStatus, pricingStatus: verified.pricingStatus,
      publishStatus: verified.publishStatus, configurationStatus: verified.configurationStatus,
      activePriceSnapshotId: verified.activePriceSnapshotId,
      sellingPrice: verified.sellingPrice, costPrice: verified.costPrice,
    },
    provider: verified.provider ? {
      status: verified.provider.status,
      enabledCapabilities: verified.provider.enabledCapabilities,
      code: verified.provider.code,
    } : null,
  })

  if (!readiness.ready) {
    return {
      success: false, providerPackageId, snapshotCreated: true,
      snapshotId: verified.activePriceSnapshotId,
      ready: false, readinessReasons: readiness.reasons,
      failedStage: 'READINESS_FAILED',
      error: readiness.reasons[0],
    }
  }

  // All checks passed
  return {
    success: true, providerPackageId, snapshotCreated: true,
    snapshotId: verified.activePriceSnapshotId,
    ready: true, readinessReasons: [],
  }
}
