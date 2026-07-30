import { prisma } from '@/lib/prisma'
import { PRICING_ENGINE_VERSION } from '../currency/currency-config'
import { convertCurrency } from '../currency/exchange-rate-service'
import { getPlatformBaseCurrency } from '../currency/currency-config'
import { roundCurrencyAmount } from '../currency/currency-rounding'

export type RecalculationReason =
  | 'PROVIDER_COST_CHANGED' | 'ADMIN_OVERRIDE_CHANGED'
  | 'EXCHANGE_RATE_CHANGED' | 'FEE_CHANGED' | 'TAX_CHANGED'
  | 'PRICING_RULE_CHANGED' | 'CURRENCY_CHANGED'
  | 'COST_FRESHNESS_CHANGED' | 'BACKFILL' | 'MANUAL'

export type RecalculationResult = {
  success: boolean
  providerPackageId: string
  pricingStatus: string
  priceSnapshotId?: string
  finalSellingPrice?: number
  sellingCurrency?: string
  reason?: string
}

export async function recalculatePackagePrice(
  packageId: string,
  reason: RecalculationReason,
): Promise<RecalculationResult> {
  const pkg = await prisma.providerPackage.findUnique({
    where: { id: packageId },
    include: { fees: true },
  })
  if (!pkg) return { success: false, providerPackageId: packageId, pricingStatus: 'COST_UNAVAILABLE', reason: 'Package not found' }

  // Step 1: Set RECALCULATING
  await prisma.providerPackage.update({ where: { id: packageId }, data: { pricingStatus: 'REQUIRES_RECALCULATION' } }).catch(() => {})

  const baseCurrency = getPlatformBaseCurrency()
  let effectiveCost = pkg.adminCostPrice ? Number(pkg.adminCostPrice) : Number(pkg.effectiveCostPrice || pkg.costPrice || 0)
  let costCurrency = (pkg as any).currency || 'USD'
  let costConverted = false

  // Step 2: Currency conversion if needed
  if (costCurrency !== baseCurrency && effectiveCost > 0) {
    const conv = await convertCurrency(effectiveCost, costCurrency, baseCurrency)
    if (!conv) {
      await prisma.providerPackage.update({ where: { id: packageId }, data: { pricingStatus: 'EXCHANGE_RATE_MISSING' } }).catch(() => {})
      return { success: false, providerPackageId: packageId, pricingStatus: 'EXCHANGE_RATE_MISSING', reason: `No exchange rate for ${costCurrency}→${baseCurrency}` }
    }
    effectiveCost = conv.amount
    costCurrency = baseCurrency
    costConverted = true
  }

  // Step 3: Add applicable fees (AT_PURCHASE and AT_ACTIVATION with platform-paid)
  const fees = pkg.fees || []
  let totalFees = 0
  for (const fee of fees) {
    if (fee.chargeTiming !== 'AT_PURCHASE' && fee.chargeTiming !== 'AT_ACTIVATION') continue
    let feeAmount = Number(fee.amount)
    if (fee.currency !== baseCurrency) {
      const feeConv = await convertCurrency(feeAmount, fee.currency, baseCurrency)
      if (!feeConv) {
        await prisma.providerPackage.update({ where: { id: packageId }, data: { pricingStatus: 'EXCHANGE_RATE_MISSING' } }).catch(() => {})
        return { success: false, providerPackageId: packageId, pricingStatus: 'EXCHANGE_RATE_MISSING', reason: `No exchange rate for fee ${fee.currency}→${baseCurrency}` }
      }
      feeAmount = feeConv.amount
    }
    totalFees += feeAmount
  }
  effectiveCost += totalFees

  // Step 4: Apply markup from configuration rules
  const rule = await prisma.packageConfigurationRule.findFirst({
    where: { providerId: pkg.providerId, isActive: true },
    orderBy: { priority: 'desc' },
  })

  let sellPrice: number
  if (rule?.fixedPrice && Number(rule.fixedPrice) > 0) {
    sellPrice = Number(rule.fixedPrice)
  } else if (rule?.markupPercent && effectiveCost > 0) {
    sellPrice = effectiveCost * (1 + Number(rule.markupPercent) / 100)
  } else if (pkg.sellingPrice && Number(pkg.sellingPrice) > 0) {
    sellPrice = Number(pkg.sellingPrice)
  } else if (pkg.markupPercent && effectiveCost > 0) {
    sellPrice = effectiveCost * (1 + Number(pkg.markupPercent) / 100)
  } else {
    sellPrice = effectiveCost
  }

  // Step 5: Margin protection
  const profit = sellPrice - effectiveCost
  const marginPercent = sellPrice > 0 ? (profit / sellPrice) * 100 : 0

  if (sellPrice <= effectiveCost && sellPrice > 0) {
    await prisma.providerPackage.update({ where: { id: packageId }, data: { pricingStatus: 'MARGIN_BELOW_MINIMUM' } }).catch(() => {})
    return { success: false, providerPackageId: packageId, pricingStatus: 'MARGIN_BELOW_MINIMUM', reason: `Sell $${sellPrice.toFixed(2)} <= cost $${effectiveCost.toFixed(2)}` }
  }

  if (marginPercent < 5 && sellPrice > 0) {
    await prisma.providerPackage.update({ where: { id: packageId }, data: { pricingStatus: 'MARGIN_BELOW_MINIMUM' } }).catch(() => {})
    return { success: false, providerPackageId: packageId, pricingStatus: 'MARGIN_BELOW_MINIMUM', reason: `Margin ${marginPercent.toFixed(1)}% below 5% minimum` }
  }

  // Step 6: Rounding
  const sellCurrency = pkg.sellingCurrency || baseCurrency
  sellPrice = roundCurrencyAmount(sellPrice, sellCurrency)

  // Step 7: Create snapshot
  const round6dp = (v: number) => Math.round(v * 1000000) / 1000000

  const snapshot = await prisma.packagePriceSnapshot.create({
    data: {
      providerPackageId: packageId,
      originalCostAmount: round6dp(Number(pkg.costPrice)),
      originalCostCurrency: (pkg as any).currency || 'USD',
      effectiveCostAmount: round6dp(effectiveCost),
      effectiveCostCurrency: baseCurrency,
      baseSellingPrice: round6dp(sellPrice),
      finalSellingPrice: round6dp(sellPrice),
      sellingCurrency: sellCurrency,
      profitAmount: round6dp(profit),
      marginPercent: round6dp(marginPercent),
      pricingEngineVersion: PRICING_ENGINE_VERSION,
      reason,
      status: 'ACTIVE',
    },
  })

  // Step 8: Update package
  await prisma.providerPackage.update({
    where: { id: packageId },
    data: {
      sellingPrice: sellPrice,
      sellingCurrency: sellCurrency,
      effectiveCostPrice: round6dp(effectiveCost),
      pricingStatus: 'READY',
    },
  })

  return {
    success: true,
    providerPackageId: packageId,
    pricingStatus: 'READY',
    priceSnapshotId: snapshot.id,
    finalSellingPrice: round6dp(sellPrice),
    sellingCurrency: sellCurrency,
  }
}

export async function recalculateAffectedByCurrency(baseCurrency: string): Promise<{ total: number; recalculated: number }> {
  const packages = await prisma.providerPackage.findMany({
    where: { costStatus: 'VALID', isAvailable: true, pricingStatus: { not: 'DISABLED' } },
    select: { id: true, currency: true },
  })

  let recalculated = 0
  for (const pkg of packages) {
    if ((pkg as any).currency === baseCurrency) {
      const result = await recalculatePackagePrice(pkg.id, 'EXCHANGE_RATE_CHANGED')
      if (result.success) recalculated++
    }
  }

  return { total: packages.length, recalculated }
}
