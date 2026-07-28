import { prisma } from '@/lib/prisma'
import { roundMoney, roundPercentage, computeMarkupFromCostAndSell } from '@/lib/pricing/pricing-engine'

export interface CatalogProductAnalytics {
  productId: string
  productName: string
  totalRevenue: number
  totalCost: number
  profitMargin: number | null
  totalActivations: number
  totalUsageMB: number
  avgRevenuePerActivation: number
  providerName: string | null
  isActive: boolean
}

export interface CatalogAnalyticsSummary {
  totalRevenue: number
  totalCost: number
  totalProfit: number
  overallMargin: number | null
  totalActivations: number
  totalProducts: number
  activeProducts: number
  topProducts: CatalogProductAnalytics[]
  revenueByProduct: { productId: string; productName: string; revenue: number; percentage: number }[]
  providerBreakdown: { providerName: string; revenue: number; activations: number }[]
}

export async function getCatalogAnalytics(dateFrom?: Date, dateTo?: Date): Promise<CatalogAnalyticsSummary> {
  const products = await prisma.eSIMPackage.findMany({
    where: { source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    include: {
      provider: { select: { name: true, code: true } },
      purchases: {
        where: {
          status: { in: ['COMPLETED', 'PENDING_ACTIVATION', 'ACTIVE'] },
          ...(dateFrom || dateTo ? {
            createdAt: {
              ...(dateFrom ? { gte: dateFrom } : {}),
              ...(dateTo ? { lte: dateTo } : {}),
            },
          } : {}),
        },
        include: {
          esims: { select: { usageRecords: { select: { dataUsedMB: true } } } },
        },
      },
    },
    orderBy: { priceUSD: 'desc' },
  })

  const productAnalytics: CatalogProductAnalytics[] = products.map((p) => {
    const totalRevenue = p.purchases.reduce((sum, pu) => sum + parseFloat(pu.totalAmount.toString()), 0)
    const totalCost = p.costPriceUSD
      ? p.purchases.reduce((sum, pu) => sum + parseFloat(p.costPriceUSD!.toString()) * pu.quantity, 0)
      : 0
    const totalActivations = p.purchases.length
    const totalUsageMB = p.purchases.reduce(
      (sum, pu) => sum + pu.esims.reduce((s, e) => s + e.usageRecords.reduce((u, r) => u + r.dataUsedMB, 0), 0),
      0
    )
    const profitMargin = computeMarkupFromCostAndSell(totalCost, totalRevenue) ?? null
    const avgRevenuePerActivation = totalActivations > 0 ? totalRevenue / totalActivations : 0

    return {
      productId: p.id,
      productName: p.name,
      totalRevenue,
      totalCost,
      profitMargin: profitMargin != null ? roundPercentage(profitMargin) : null,
      totalActivations,
      totalUsageMB,
      avgRevenuePerActivation: roundMoney(avgRevenuePerActivation),
      providerName: p.provider?.name || p.providerName || null,
      isActive: p.isActive,
    }
  })

  const totalRevenue = productAnalytics.reduce((sum, p) => sum + p.totalRevenue, 0)
  const totalCost = productAnalytics.reduce((sum, p) => sum + p.totalCost, 0)
  const totalProfit = totalRevenue - totalCost
  const overallMargin = computeMarkupFromCostAndSell(totalCost, totalRevenue) ?? null

  const topProducts = [...productAnalytics]
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 10)

  const revenueByProduct = productAnalytics
    .filter(p => p.totalRevenue > 0)
    .map(p => ({
      productId: p.productId,
      productName: p.productName,
      revenue: p.totalRevenue,
      percentage: totalRevenue > 0 ? Math.round((p.totalRevenue / totalRevenue) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)

  const providerMap = new Map<string, { revenue: number; activations: number }>()
  for (const p of productAnalytics) {
    const name = p.providerName || 'Unknown'
    const existing = providerMap.get(name) || { revenue: 0, activations: 0 }
    existing.revenue += p.totalRevenue
    existing.activations += p.totalActivations
    providerMap.set(name, existing)
  }
  const providerBreakdown = Array.from(providerMap.entries())
    .map(([providerName, data]) => ({ providerName, ...data }))
    .sort((a, b) => b.revenue - a.revenue)

  return {
    totalRevenue: roundMoney(totalRevenue),
    totalCost: roundMoney(totalCost),
    totalProfit: roundMoney(totalProfit),
    overallMargin: overallMargin != null ? roundPercentage(overallMargin) : null,
    totalActivations: productAnalytics.reduce((sum, p) => sum + p.totalActivations, 0),
    totalProducts: products.length,
    activeProducts: products.filter(p => p.isActive).length,
    topProducts,
    revenueByProduct,
    providerBreakdown,
  }
}

export async function getProductAnalytics(productId: string): Promise<CatalogProductAnalytics | null> {
  const summary = await getCatalogAnalytics()
  return summary.topProducts.find(p => p.productId === productId) || null
}
