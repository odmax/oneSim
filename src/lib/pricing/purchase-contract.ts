import { prisma } from '@/lib/prisma'
import { validatePurchaseQuote } from './purchase-quote-service'
import { PRICING_ENGINE_VERSION } from '../currency/currency-config'
import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'

export interface ValidatedPurchaseContext {
  quoteId: string
  quoteReference: string
  businessId: string
  providerPackageId: string
  providerId: string
  providerPlanId: string
  quantity: number
  unitPrice: number
  totalAmount: number
  sellingCurrency: string
  effectiveCostAmount: number
  effectiveCostCurrency: string
  packagePriceSnapshotId: string
  providerCostSnapshotId?: string
  pricingEngineVersion: string
  idempotencyKey: string
}

export async function buildValidatedPurchaseContext(
  quoteRef: string,
  businessId: string,
  idempotencyKey: string,
): Promise<{ success: boolean; context?: ValidatedPurchaseContext; error?: string }> {
  const validation = await validatePurchaseQuote(quoteRef, businessId)
  if (!validation.valid) return { success: false, error: validation.error }

  const quote = validation.quote!

  const pkg = await prisma.providerPackage.findUnique({
    where: { id: quote.providerPackageId },
    select: {
      providerId: true, providerPlanId: true, activePriceSnapshotId: true,
      costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, sellingPrice: true, costPrice: true,
      provider: { select: { status: true, code: true, enabledCapabilities: true } },
    },
  })
  if (!pkg) return { success: false, error: 'Package not found' }
  if (!pkg.providerPlanId) return { success: false, error: 'Missing provider plan ID' }

  const readiness = getPackagePurchaseReadiness({
    providerPkg: { costStatus: pkg.costStatus, pricingStatus: pkg.pricingStatus, publishStatus: pkg.publishStatus, configurationStatus: pkg.configurationStatus, activePriceSnapshotId: pkg.activePriceSnapshotId, sellingPrice: pkg.sellingPrice, costPrice: pkg.costPrice },
    provider: { status: pkg.provider.status, enabledCapabilities: pkg.provider.enabledCapabilities, code: pkg.provider.code },
  })
  if (!readiness.ready) return { success: false, error: readiness.reasons[0] || 'Package not ready' }

  // Verify quote references the active snapshot
  if (quote.packagePriceSnapshotId !== pkg.activePriceSnapshotId) return { success: false, error: 'Quote snapshot mismatch' }

  return {
    success: true,
    context: {
      quoteId: quote.id,
      quoteReference: quote.quoteReference,
      businessId,
      providerPackageId: quote.providerPackageId,
      providerId: pkg.providerId,
      providerPlanId: pkg.providerPlanId,
      quantity: quote.quantity,
      unitPrice: Number(quote.unitPrice),
      totalAmount: Number(quote.totalAmount),
      sellingCurrency: quote.currency,
      effectiveCostAmount: Number(quote.effectiveCostAmount),
      effectiveCostCurrency: quote.effectiveCostCurrency,
      packagePriceSnapshotId: quote.packagePriceSnapshotId,
      providerCostSnapshotId: quote.providerCostSnapshotId || undefined,
      pricingEngineVersion: PRICING_ENGINE_VERSION,
      idempotencyKey,
    },
  }
}
