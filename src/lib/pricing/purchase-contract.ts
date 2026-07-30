import { prisma } from '@/lib/prisma'
import { validatePurchaseQuote } from './purchase-quote-service'
import { PRICING_ENGINE_VERSION } from '../currency/currency-config'

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
    select: { providerId: true, providerPlanId: true, provider: { select: { status: true } }, pricingStatus: true },
  })
  if (!pkg) return { success: false, error: 'Package not found' }
  if (pkg.pricingStatus !== 'READY') return { success: false, error: 'Package not available' }
  if (pkg.provider.status !== 'ACTIVE' && pkg.provider.status !== 'TESTING') return { success: false, error: 'Provider not available' }

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
