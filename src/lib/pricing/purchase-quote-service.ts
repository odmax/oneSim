import { prisma } from '@/lib/prisma'
import { getQuoteExpiryMinutes, PRICING_ENGINE_VERSION } from '../currency/currency-config'

export async function createPurchaseQuote(params: {
  businessId: string
  providerPackageId: string
  quantity: number
}): Promise<{ success: boolean; quote?: any; error?: string }> {
  const { businessId, providerPackageId, quantity } = params

  const pkg = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    select: { pricingStatus: true, sellingPrice: true, sellingCurrency: true, effectiveCostPrice: true, currency: true, id: true },
  })
  if (!pkg) return { success: false, error: 'Package not found' }
  if (pkg.pricingStatus !== 'READY') return { success: false, error: `Package not available for purchase (${pkg.pricingStatus})` }

  const sellPrice = pkg.sellingPrice ? Number(pkg.sellingPrice) : 0
  if (sellPrice <= 0) return { success: false, error: 'No valid selling price' }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + getQuoteExpiryMinutes() * 60 * 1000)
  const quoteRef = `QT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const totalAmount = sellPrice * quantity
  const costAmount = pkg.effectiveCostPrice ? Number(pkg.effectiveCostPrice) : 0

  const quote = await prisma.purchaseQuote.create({
    data: {
      quoteReference: quoteRef,
      providerPackageId, packagePriceSnapshotId: pkg.id,
      businessId, quantity,
      unitPrice: sellPrice, totalAmount,
      currency: pkg.sellingCurrency || 'USD',
      effectiveCostAmount: costAmount, effectiveCostCurrency: pkg.currency || 'USD',
      pricingEngineVersion: PRICING_ENGINE_VERSION,
      expiresAt,
    },
  })

  return { success: true, quote: { reference: quote.quoteReference, unitPrice: sellPrice, totalAmount, currency: quote.currency, expiresAt: quote.expiresAt.toISOString() } }
}

export async function validatePurchaseQuote(quoteRef: string, businessId: string): Promise<{ valid: boolean; quote?: any; error?: string }> {
  const quote = await prisma.purchaseQuote.findUnique({ where: { quoteReference: quoteRef } })
  if (!quote) return { valid: false, error: 'Quote not found' }
  if (quote.businessId !== businessId) return { valid: false, error: 'Unauthorized' }
  if (quote.status !== 'ACTIVE') return { valid: false, error: `Quote ${quote.status}` }
  if (new Date() > quote.expiresAt) return { valid: false, error: 'Quote expired' }
  return { valid: true, quote }
}

export async function consumePurchaseQuote(quoteRef: string, idempotencyKey?: string): Promise<{ success: boolean; error?: string }> {
  const result = await prisma.purchaseQuote.updateMany({
    where: { quoteReference: quoteRef, status: 'ACTIVE', expiresAt: { gt: new Date() } },
    data: { status: 'CONSUMED', consumedAt: new Date(), idempotencyKey: idempotencyKey || null },
  })
  if (result.count === 0) return { success: false, error: 'Quote not found, already consumed, or expired' }
  return { success: true }
}
