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

  const marginAmount = sellingPrice - effectiveCostPrice
  const marginPercent = sellingPrice > 0 ? (marginAmount / sellingPrice) * 100 : null
  const markupPercent = effectiveCostPrice > 0 ? (marginAmount / effectiveCostPrice) * 100 : null

  return {
    marginAmount: Math.round(marginAmount * 100) / 100,
    marginPercent: marginPercent != null ? Math.round(marginPercent * 100) / 100 : null,
    markupPercent: markupPercent != null ? Math.round(markupPercent * 100) / 100 : null,
  }
}
