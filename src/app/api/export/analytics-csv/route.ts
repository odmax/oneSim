import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import {
  parseFilters,
  computeDateRange,
  buildPurchaseWhere,
  getCsvFilename,
  generateCsv,
  getRegionForCountry,
} from '@/lib/analytics/filters'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const searchParams = Object.fromEntries(req.nextUrl.searchParams.entries())
  const filters = parseFilters(searchParams as any)

  const dateRange = computeDateRange(filters)
  const purchaseWhere: any = { status: 'COMPLETED' }
  if (dateRange.from) purchaseWhere.createdAt = { ...purchaseWhere.createdAt, gte: dateRange.from }
  if (dateRange.to) purchaseWhere.createdAt = { ...purchaseWhere.createdAt, lte: dateRange.to }
  if (filters.businessId) purchaseWhere.businessId = filters.businessId
  if (filters.packageId) purchaseWhere.packageId = filters.packageId
  if (filters.providers.length > 0) {
    purchaseWhere.package = { providerId: { in: filters.providers } }
  }

  const [revenueAgg, purchasesTotal, esimStatuses, countryData, providerData, packageData, monthlyData] = await Promise.all([
    prisma.eSIMPurchase.aggregate({ where: purchaseWhere, _sum: { totalAmount: true } }),
    prisma.eSIMPurchase.count({ where: purchaseWhere }),

    Promise.all([
      prisma.eSIM.count({ where: { status: 'ACTIVE' } }),
      prisma.eSIM.count({ where: { status: 'PENDING_ACTIVATION' } }),
      prisma.eSIM.count({ where: { status: { in: ['FAILED', 'ACTIVATION_FAILED'] } } }),
      prisma.eSIM.count(),
    ]),

    prisma.$queryRaw<Array<{ country: string; count: bigint; revenue: string | null }>>`
      SELECT COALESCE(c."country", 'Unknown') as country,
        COUNT(DISTINCT p."id")::int as count,
        COALESCE(SUM(p."totalAmount")::text, '0') as revenue
      FROM "esim_purchases" p
      LEFT JOIN "esims" e ON e."purchaseId" = p."id"
      LEFT JOIN "customers" c ON c."id" = e."customerId"
      WHERE p."status" = 'COMPLETED'
      GROUP BY c."country"
      ORDER BY COUNT(*) DESC
      LIMIT 50
    `,

    prisma.$queryRaw<Array<{ provider_name: string | null; orders: bigint; revenue: string | null; active: bigint; failed: bigint }>>`
      SELECT COALESCE(prov."name", pkg."providerName", 'CUSTOM') as provider_name,
        COUNT(DISTINCT pu."id") as orders,
        COALESCE(SUM(pu."totalAmount")::text, '0') as revenue,
        COUNT(DISTINCT e."id") FILTER (WHERE e."status" = 'ACTIVE') as active,
        COUNT(DISTINCT e."id") FILTER (WHERE e."status" IN ('FAILED','ACTIVATION_FAILED')) as failed
      FROM "esim_purchases" pu
      JOIN "esim_packages" pkg ON pkg."id" = pu."packageId"
      LEFT JOIN "esims" e ON e."purchaseId" = pu."id"
      LEFT JOIN "providers" prov ON prov."id" = pkg."providerId"
      GROUP BY prov."name", pkg."providerName"
      ORDER BY active DESC
      LIMIT 50
    `,

    prisma.$queryRaw<Array<{ name: string; orders: bigint; revenue: string | null; retail_price: string; cost_price: string | null }>>`
      SELECT pkg."name",
        COUNT(DISTINCT pu."id") as orders,
        COALESCE(SUM(pu."totalAmount")::text, '0') as revenue,
        pkg."priceUSD"::text as retail_price,
        pkg."costPriceUSD"::text as cost_price
      FROM "esim_packages" pkg
      LEFT JOIN "esim_purchases" pu ON pu."packageId" = pkg."id" AND pu."status" = 'COMPLETED'
      GROUP BY pkg."id", pkg."name", pkg."priceUSD", pkg."costPriceUSD"
      HAVING COUNT(DISTINCT pu."id") > 0
      ORDER BY revenue DESC
      LIMIT 50
    `,

    prisma.$queryRaw<Array<{ month: string; count: bigint; revenue: string | null }>>`
      SELECT TO_CHAR("createdAt", 'YYYY-MM') as month,
        COUNT(*) as count,
        COALESCE(SUM("totalAmount")::text, '0') as revenue
      FROM "esim_purchases"
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `,
  ])

  const [activeESIMs, pendingActivation, failedActivation, totalESIMs] = esimStatuses
  const revenue = parseFloat(revenueAgg._sum.totalAmount?.toString() || '0')

  const sections: string[] = []

  sections.push(generateCsv(
    ['Metric', 'Value'],
    [
      ['Revenue', `$${revenue.toFixed(2)}`],
      ['Total Orders', String(purchasesTotal)],
      ['Active eSIMs', String(activeESIMs)],
      ['Pending Activations', String(pendingActivation)],
      ['Failed Activations', String(failedActivation)],
      ['Total eSIMs', String(totalESIMs)],
    ]
  ))

  sections.push(generateCsv(
    ['Country', 'Orders', 'Revenue'],
    countryData.map(row => [row.country, String(Number(row.count)), `$${parseFloat(row.revenue || '0').toFixed(2)}`])
  ))

  sections.push(generateCsv(
    ['Provider', 'Orders', 'Revenue', 'Active', 'Failed'],
    providerData.map(row => [
      row.provider_name || 'Unknown',
      String(Number(row.orders)),
      `$${parseFloat(row.revenue || '0').toFixed(2)}`,
      String(Number(row.active)),
      String(Number(row.failed)),
    ])
  ))

  sections.push(generateCsv(
    ['Product', 'Orders', 'Revenue', 'Retail Price', 'Cost Price'],
    packageData.map(row => [
      row.name,
      String(Number(row.orders)),
      `$${parseFloat(row.revenue || '0').toFixed(2)}`,
      `$${parseFloat(row.retail_price || '0').toFixed(2)}`,
      row.cost_price ? `$${parseFloat(row.cost_price).toFixed(2)}` : 'N/A',
    ])
  ))

  sections.push(generateCsv(
    ['Month', 'Orders', 'Revenue'],
    monthlyData.map(row => [row.month, String(Number(row.count)), `$${parseFloat(row.revenue || '0').toFixed(2)}`])
  ))

  const fullCsv = sections.join('\n\n')

  return new NextResponse(fullCsv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${getCsvFilename()}"`,
    },
  })
}
