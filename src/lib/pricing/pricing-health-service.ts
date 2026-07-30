import { prisma } from '@/lib/prisma'

export interface PricingHealthSummary {
  total: number
  ready: number
  requiresRecalculation: number
  recalculating: number
  costUnavailable: number
  exchangeRateMissing: number
  marginBelowMinimum: number
  calculationFailed: number
  disabled: number
  missingActiveSnapshots: number
  unsupportedCurrencies: number
  staleCosts: number
  activeQuotes: number
  expiredQuotes: number
  consumedQuotes: number
}

export async function getPricingHealth(): Promise<PricingHealthSummary> {
  const [packages, quoteStats] = await Promise.all([
    prisma.providerPackage.findMany({
      select: { pricingStatus: true, costStatus: true, currency: true },
    }),
    Promise.all([
      prisma.purchaseQuote.count({ where: { status: 'ACTIVE' } }),
      prisma.purchaseQuote.count({ where: { status: 'EXPIRED' } }),
      prisma.purchaseQuote.count({ where: { status: 'CONSUMED' } }),
    ]),
  ])

  const statusCount = (s: string) => packages.filter(p => p.pricingStatus === s).length

  return {
    total: packages.length,
    ready: statusCount('READY'),
    requiresRecalculation: statusCount('REQUIRES_RECALCULATION'),
    recalculating: 0,
    costUnavailable: statusCount('COST_UNAVAILABLE'),
    exchangeRateMissing: statusCount('EXCHANGE_RATE_MISSING'),
    marginBelowMinimum: statusCount('MARGIN_BELOW_MINIMUM'),
    calculationFailed: statusCount('CALCULATION_FAILED'),
    disabled: statusCount('DISABLED'),
    missingActiveSnapshots: statusCount('READY'),
    unsupportedCurrencies: 0,
    staleCosts: packages.filter(p => p.costStatus === 'STALE').length,
    activeQuotes: quoteStats[0],
    expiredQuotes: quoteStats[1],
    consumedQuotes: quoteStats[2],
  }
}
