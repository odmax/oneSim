import { derivePricing } from '@/lib/pricing/pricing-engine'

export function calculatePackageProfit(params: {
  sellingPrice: number | null
  effectiveCostPrice: number | null
}): {
  marginAmount: number | null
  marginPercent: number | null
  markupPercent: number | null
} {
  const { sellingPrice, effectiveCostPrice } = params

  if (effectiveCostPrice == null || effectiveCostPrice <= 0 || sellingPrice == null || sellingPrice <= 0) {
    return { marginAmount: null, marginPercent: null, markupPercent: null }
  }

  const derived = derivePricing(effectiveCostPrice, sellingPrice)
  return {
    marginAmount: derived.profit,
    marginPercent: derived.marginPercent,
    markupPercent: derived.markupPercent,
  }
}
