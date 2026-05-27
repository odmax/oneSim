import { prisma } from '@/lib/prisma'

export interface PackagePricingContext {
  providerId?: string | null
  country?: string | null
  region?: string | null
  packageType?: string | null
}

export interface PriceCalculation {
  costPriceUSD: number
  markupPercent: number
  flatMarkup: number
  finalPriceUSD: number
  appliedRule: {
    id: string
    name: string
    priority: number
    type: 'pricing_rule'
  } | {
    id: null
    name: 'Annual Markup Fallback'
    priority: 999
    type: 'annual_markup_fallback'
  } | null
}

export async function calculatePrice(
  costPriceUSD: number,
  context: PackagePricingContext
): Promise<PriceCalculation> {
  const cost = Math.max(0, costPriceUSD)

  // Fetch active pricing rules, ordered by priority (lower number = higher priority)
  const rules = await prisma.pricingRule.findMany({
    where: { isActive: true },
    orderBy: { priority: 'asc' },
  })

  // Find best matching rule by priority order
  const matchedRule = findBestMatchingRule(rules, context)

  if (matchedRule) {
    const markupPct = matchedRule.markupPercent ? Number(matchedRule.markupPercent) : 0
    const flat = matchedRule.flatMarkup ? Number(matchedRule.flatMarkup) : 0
    const priceFromMarkup = cost > 0 && markupPct > 0 ? cost + (cost * markupPct / 100) : 0
    const priceWithFlat = flat > 0 ? cost + flat : 0
    const finalPrice = Math.max(priceFromMarkup, priceWithFlat)

    return {
      costPriceUSD: cost,
      markupPercent: markupPct,
      flatMarkup: flat,
      finalPriceUSD: Math.round(finalPrice * 100) / 100,
      appliedRule: {
        id: matchedRule.id,
        name: matchedRule.name,
        priority: matchedRule.priority,
        type: 'pricing_rule',
      },
    }
  }

  // Fallback: annual markup
  const activeMarkup = await prisma.annualMarkupSetting.findFirst({
    where: { isActive: true },
    orderBy: { year: 'desc' },
  })

  const markupPct = activeMarkup ? Number(activeMarkup.markupPercent) : 0
  const finalPrice = cost > 0 && markupPct > 0
    ? cost + (cost * markupPct / 100)
    : 0

  return {
    costPriceUSD: cost,
    markupPercent: markupPct,
    flatMarkup: 0,
    finalPriceUSD: Math.round(finalPrice * 100) / 100,
    appliedRule: activeMarkup
      ? { id: null, name: 'Annual Markup Fallback', priority: 999, type: 'annual_markup_fallback' as const }
      : null,
  }
}

function findBestMatchingRule(
  rules: Array<any>,
  context: PackagePricingContext
) {
  // Priority matching: first try country-exact, then region, then provider, then packageType, then any active rule
  const matchScore = (rule: typeof rules[0]): number => {
    let score = 0
    if (rule.country && rule.country === context.country) score += 1000
    if (rule.region && rule.region === context.region) score += 100
    if (rule.providerId && rule.providerId === context.providerId) score += 10
    if (rule.packageType && rule.packageType === context.packageType) score += 1
    if (rule.country && context.country && rule.country !== context.country) return -1
    if (rule.region && context.region && rule.region !== context.region) return -1
    if (rule.providerId && context.providerId && rule.providerId !== context.providerId) return -1
    if (rule.packageType && context.packageType && rule.packageType !== context.packageType) return -1
    if (!rule.country && !rule.region && !rule.providerId && !rule.packageType) score += 0.5
    return score
  }

  let best: typeof rules[0] | null = null
  let bestScore = -1

  for (const rule of rules) {
    const sc = matchScore(rule)
    if (sc > bestScore) {
      bestScore = sc
      best = rule
    }
  }

  return best
}

export function generatePricingSummary(calculations: PriceCalculation[]): {
  totalCost: number
  totalRevenue: number
  grossProfit: number
  profitMarginPercent: number
} {
  const totalCost = calculations.reduce((s, c) => s + c.costPriceUSD, 0)
  const totalRevenue = calculations.reduce((s, c) => s + c.finalPriceUSD, 0)
  const grossProfit = totalRevenue - totalCost
  const profitMarginPercent = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0

  return {
    totalCost: Math.round(totalCost * 100) / 100,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    grossProfit: Math.round(grossProfit * 100) / 100,
    profitMarginPercent: Math.round(profitMarginPercent * 100) / 100,
  }
}
