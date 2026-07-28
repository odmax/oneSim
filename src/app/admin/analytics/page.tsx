import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { FilterBar } from '@/components/admin/analytics/FilterBar'
import { roundMoney, roundPercentage } from '@/lib/pricing/pricing-engine'
import {
  parseFilters,
  computeDateRange,
  getRegionForCountry,
  getCountriesForRegions,
  parseStatusFilterValue,
} from '@/lib/analytics/filters'

function parseNum(val: string | null | undefined): number {
  return parseFloat(val || '0')
}

function StatCard({ title, value, color }: { title: string; value: string; color: 'green' | 'red' | 'yellow' | 'blue' }) {
  const colors = {
    green: 'border-emerald-100 bg-gradient-to-br from-emerald-50 to-white',
    red: 'border-red-100 bg-gradient-to-br from-red-50 to-white',
    yellow: 'border-amber-100 bg-gradient-to-br from-amber-50 to-white',
    blue: 'border-blue-100 bg-gradient-to-br from-blue-50 to-white',
  }
  const textColors = { green: 'text-emerald-700', red: 'text-red-700', yellow: 'text-amber-700', blue: 'text-blue-700' }
  return (
    <div className={`rounded-xl border p-5 shadow-sm ${colors[color]}`}>
      <p className={`text-xs font-medium uppercase tracking-wider ${textColors[color]} opacity-80`}>{title}</p>
      <p className={`mt-1 text-2xl font-bold ${textColors[color]}`}>{value}</p>
    </div>
  )
}

function TableCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-gray-50 px-5 py-4">
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="py-12 text-center text-sm text-gray-400">{children}</div>
}

export default async function AdminAnalyticsPage({
  searchParams
}: {
  searchParams: { 
    dateRange?: string; dateFrom?: string; dateTo?: string;
    providers?: string | string[]; regions?: string | string[];
    countries?: string | string[]; businessId?: string;
    packageId?: string; statuses?: string | string[];
  }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.VIEW_ANALYTICS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const filters = parseFilters(searchParams as any)

  const [businesses, packages, providers, distinctCountries] = await Promise.all([
    prisma.business.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.eSIMPackage.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.provider.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.$queryRaw<Array<{ country: string }>>`
      SELECT DISTINCT c."country" FROM "customers" c WHERE c."country" IS NOT NULL ORDER BY c."country"
    `,
  ])

  const allCountries = distinctCountries.map((r: { country: string }) => r.country)
  const dateRange = computeDateRange(filters)
  const purchaseWhere: any = { status: 'COMPLETED' }
  if (dateRange.from || dateRange.to) {
    purchaseWhere.createdAt = {}
    if (dateRange.from) purchaseWhere.createdAt.gte = dateRange.from
    if (dateRange.to) purchaseWhere.createdAt.lte = dateRange.to
  }
  if (filters.businessId) purchaseWhere.businessId = filters.businessId
  if (filters.packageId) purchaseWhere.packageId = filters.packageId
  if (filters.providers.length > 0) {
    purchaseWhere.package = { providerId: { in: filters.providers } }
  }

  const regionCountries = filters.regions.length > 0 ? getCountriesForRegions(filters.regions) : []
  const allFilterCountries = [...new Set([...filters.countries, ...regionCountries])]

  const [
    totalRevenue,
    totalPurchases,
    eSIMStatusCounts,
    businessesByCountry,
    providerPerformance,
    packageAnalytics,
    purchasesByMonth,
  ] = await Promise.all([
    prisma.eSIMPurchase.aggregate({ where: { ...purchaseWhere }, _sum: { totalAmount: true } }),
    prisma.eSIMPurchase.count({ where: purchaseWhere }),
    Promise.all([
      prisma.eSIM.count({ where: { status: 'ACTIVE' } }),
      prisma.eSIM.count({ where: { status: 'PENDING_ACTIVATION' } }),
      prisma.eSIM.count({ where: { status: { in: ['FAILED', 'ACTIVATION_FAILED'] } } }),
      prisma.eSIM.count(),
    ]),
    buildCountryQuery(dateRange, filters, allFilterCountries),
    buildProviderQuery(dateRange, filters),
    buildPackageQuery(dateRange, filters),
    buildMonthlyQuery(dateRange, filters),
  ])

  const costData = await computeCostOfSales(purchaseWhere)
  const [activeESIMs, pendingActivation, failedActivation, totalESIMs] = eSIMStatusCounts
  const revenue = parseFloat(totalRevenue._sum.totalAmount?.toString() || '0')

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
        <p className="mt-1 text-sm text-gray-500">Platform financial and operational performance</p>
      </div>

      {/* Filter bar */}
      <Suspense fallback={<div className="h-32 animate-pulse bg-gray-100 rounded-xl" />}>
        <FilterBar businesses={businesses} packages={packages} providers={providers} countries={allCountries} />
      </Suspense>

      {/* P&L Summary */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Revenue" value={`$${revenue.toFixed(2)}`} color="green" />
        <StatCard title="Cost of Sales" value={`$${costData.totalCost.toFixed(2)}`} color="red" />
        <StatCard title="Gross Profit" value={`$${costData.grossProfit.toFixed(2)}`} color={costData.grossProfit >= 0 ? 'green' : 'red'} />
        <StatCard title="Profit Margin" value={`${costData.profitMarginPercent.toFixed(1)}%`} color={costData.profitMarginPercent >= 20 ? 'green' : costData.profitMarginPercent >= 10 ? 'yellow' : 'red'} />
      </div>

      {/* eSIM Status Summary */}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard title="Active eSIMs" value={activeESIMs.toString()} color="green" />
        <StatCard title="Pending Activations" value={pendingActivation.toString()} color="yellow" />
        <StatCard title="Failed Activations" value={failedActivation.toString()} color="red" />
        <StatCard title="Total Orders" value={totalPurchases.toString()} color="blue" />
      </div>

      {/* Monthly Orders */}
      <TableCard title="Monthly Orders">
        {purchasesByMonth.length === 0 ? (
          <EmptyState>No order data for the selected filters.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50/50">
              <tr>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Month</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Orders</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {purchasesByMonth.map((row: any) => (
                <tr key={row.month} className="hover:bg-gray-50/50 transition-colors">
                  <td className="px-5 py-3 text-sm text-gray-900">{row.month}</td>
                  <td className="px-5 py-3 text-sm text-gray-600">{Number(row.count)}</td>
                  <td className="px-5 py-3 text-sm text-gray-900 font-medium">${parseNum(row.revenue).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableCard>

      {/* Countries + Providers */}
      <div className="grid gap-6 lg:grid-cols-2">
        <TableCard title="Top Countries">
          {businessesByCountry.length === 0 ? (
            <EmptyState>No country data for the selected filters.</EmptyState>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50/50">
                <tr>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Country</th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Region</th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Orders</th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {businessesByCountry.map((row: any) => (
                  <tr key={row.country} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-5 py-3 text-sm font-medium text-gray-900">{row.country || 'Unknown'}</td>
                    <td className="px-5 py-3 text-sm text-gray-500">{getRegionForCountry(row.country || '')}</td>
                    <td className="px-5 py-3 text-sm text-gray-600">{Number(row.count)}</td>
                    <td className="px-5 py-3 text-sm text-gray-900">${parseNum(row.revenue).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TableCard>

        <TableCard title="Provider Performance">
          {providerPerformance.length === 0 ? (
            <EmptyState>No provider data for the selected filters.</EmptyState>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50/50">
                <tr>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Provider</th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Revenue</th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Active</th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Failed</th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Success Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {providerPerformance.map((row: any) => {
                  const total = Number(row.total_esims)
                  const successRate = total > 0 ? ((total - Number(row.failed)) / total * 100).toFixed(1) : '0.0'
                  return (
                    <tr key={row.provider_id || row.provider_name} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-5 py-3 text-sm font-medium text-gray-900">{row.provider_name}</td>
                      <td className="px-5 py-3 text-sm text-gray-900 font-medium">${parseNum(row.revenue).toFixed(2)}</td>
                      <td className="px-5 py-3 text-sm text-emerald-600 font-medium">{Number(row.active)}</td>
                      <td className="px-5 py-3 text-sm text-red-600">{Number(row.failed)}</td>
                      <td className="px-5 py-3 text-sm">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          parseFloat(successRate) >= 95 ? 'bg-emerald-50 text-emerald-600' :
                          parseFloat(successRate) >= 80 ? 'bg-amber-50 text-amber-600' :
                          'bg-red-50 text-red-600'
                        }`}>
                          {successRate}%
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </TableCard>
      </div>

      {/* Package Profitability */}
      <TableCard title="Package Profitability">
        {packageAnalytics.length === 0 ? (
          <EmptyState>No package data for the selected filters.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50/50">
              <tr>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Package</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Details</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Cost</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Price</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Markup</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Orders</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Revenue</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Total Profit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {packageAnalytics.map((row: any) => {
                const costPrice = parseNum(row.cost_price)
                const retailPrice = parseNum(row.retail_price)
                const pkgRevenue = parseNum(row.revenue)
                const orderCount = Number(row.orders)
                const markupPct = costPrice > 0 ? ((retailPrice - costPrice) / costPrice * 100) : 0
                const totalProfit = (retailPrice - costPrice) * orderCount
                return (
                  <tr key={row.package_id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-5 py-3 text-sm font-medium text-gray-900">{row.name}</td>
                    <td className="px-5 py-3 text-sm text-gray-500">{row.data_gb}GB / {row.validity_days}d</td>
                    <td className="px-5 py-3 text-sm text-gray-900">${costPrice.toFixed(2)}</td>
                    <td className="px-5 py-3 text-sm text-gray-900">${retailPrice.toFixed(2)}</td>
                    <td className="px-5 py-3 text-sm">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        markupPct >= 25 ? 'bg-emerald-50 text-emerald-600' :
                        markupPct >= 10 ? 'bg-amber-50 text-amber-600' :
                        'bg-red-50 text-red-600'
                      }`}>
                        {markupPct.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm text-gray-600">{orderCount}</td>
                    <td className="px-5 py-3 text-sm text-gray-900 font-medium">${pkgRevenue.toFixed(2)}</td>
                    <td className="px-5 py-3 text-sm font-semibold text-emerald-600">${totalProfit.toFixed(2)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </TableCard>
    </div>
  )
}

async function computeCostOfSales(purchaseWhere: any) {
  const completedPurchases = await prisma.eSIMPurchase.findMany({
    where: purchaseWhere,
    select: {
      totalAmount: true,
      package: { select: { costPriceUSD: true } },
    },
  })

  let totalCost = 0
  let totalRevenue = 0
  for (const p of completedPurchases) {
    const revenue = parseFloat(p.totalAmount.toString())
    const cost = p.package.costPriceUSD ? parseFloat(p.package.costPriceUSD.toString()) : 0
    totalRevenue += revenue
    totalCost += cost
  }

  const grossProfit = totalRevenue - totalCost
  const profitMarginPercent = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0
  return {
    totalCost: roundMoney(totalCost),
    totalRevenue: roundMoney(totalRevenue),
    grossProfit: roundMoney(grossProfit),
    profitMarginPercent: roundPercentage(profitMarginPercent),
  }
}

async function buildCountryQuery(dateRange: any, filters: any, allFilterCountries: string[]) {
  const parts: string[] = [`p."status" = 'COMPLETED'`]
  const localParams: any[] = []
  let idx = 0
  function add(v: any): number { idx++; localParams.push(v); return idx }
  if (dateRange.from) parts.push(`p."createdAt" >= $${add(dateRange.from.toISOString())}::timestamp`)
  if (dateRange.to) parts.push(`p."createdAt" <= $${add(dateRange.to.toISOString())}::timestamp`)
  if (filters.businessId) parts.push(`p."businessId" = $${add(filters.businessId)}`)
  if (filters.packageId) parts.push(`p."packageId" = $${add(filters.packageId)}`)
  if (filters.providers.length > 0) {
    const provParts = filters.providers.map((p: string) => `prov."id" = $${add(p)}`)
    parts.push(`(${provParts.join(' OR ')})`)
  }
  if (allFilterCountries.length > 0) {
    const ccParts = allFilterCountries.map((c: string) => `c."country" = $${add(c)}`)
    parts.push(`(${ccParts.join(' OR ')})`)
  }
  const statusFilter = filters.statuses.length > 0
    ? (() => { const e: string[] = []; for (const s of filters.statuses) e.push(...parseStatusFilterValue(s)); return e.map((s: string) => `e."status" = $${add(s)}`).join(' OR ') })()
    : null
  if (statusFilter) parts.push(`(${statusFilter})`)

  return prisma.$queryRawUnsafe<Array<{ country: string; count: bigint; revenue: string | null }>>(
    `SELECT COALESCE(c."country", 'Unknown') as country, COUNT(DISTINCT p."id")::int as count, COALESCE(SUM(p."totalAmount")::text, '0') as revenue
     FROM "esim_purchases" p LEFT JOIN "esims" e ON e."purchaseId" = p."id"
     LEFT JOIN "customers" c ON c."id" = e."customerId"
     LEFT JOIN "esim_packages" pkg ON pkg."id" = p."packageId"
     LEFT JOIN "providers" prov ON prov."id" = pkg."providerId"
     WHERE ${parts.join(' AND ')} GROUP BY c."country" ORDER BY COUNT(*) DESC LIMIT 10`,
    ...localParams
  )
}

async function buildProviderQuery(dateRange: any, filters: any) {
  const parts: string[] = [`pu."status" = 'COMPLETED'`]
  const localParams: any[] = []
  let idx = 0
  function add(v: any): number { idx++; localParams.push(v); return idx }
  if (dateRange.from) parts.push(`pu."createdAt" >= $${add(dateRange.from.toISOString())}::timestamp`)
  if (dateRange.to) parts.push(`pu."createdAt" <= $${add(dateRange.to.toISOString())}::timestamp`)
  if (filters.businessId) parts.push(`pu."businessId" = $${add(filters.businessId)}`)
  if (filters.packageId) parts.push(`pu."packageId" = $${add(filters.packageId)}`)
  if (filters.providers.length > 0) {
    const provParts = filters.providers.map((p: string) => `prov."id" = $${add(p)}`)
    parts.push(`(${provParts.join(' OR ')})`)
  }
  const statusFilter = filters.statuses.length > 0
    ? (() => { const e: string[] = []; for (const s of filters.statuses) e.push(...parseStatusFilterValue(s)); return e.map((s: string) => `e."status" = $${add(s)}`).join(' OR ') })()
    : null
  if (statusFilter) parts.push(`(${statusFilter})`)

  return prisma.$queryRawUnsafe<Array<{ provider_id: string | null; provider_name: string | null; orders: bigint; revenue: string | null; active: bigint; failed: bigint; total_esims: bigint }>>(
    `SELECT prov."id" as provider_id, COALESCE(prov."name", pkg."providerName", 'CUSTOM') as provider_name,
     COUNT(DISTINCT pu."id") as orders, COALESCE(SUM(pu."totalAmount")::text, '0') as revenue,
     COUNT(DISTINCT e."id") FILTER (WHERE e."status" = 'ACTIVE') as active,
     COUNT(DISTINCT e."id") FILTER (WHERE e."status" IN ('FAILED','ACTIVATION_FAILED')) as failed,
     COUNT(DISTINCT e."id") as total_esims
     FROM "esim_purchases" pu JOIN "esim_packages" pkg ON pkg."id" = pu."packageId"
     LEFT JOIN "esims" e ON e."purchaseId" = pu."id" LEFT JOIN "providers" prov ON prov."id" = pkg."providerId"
     WHERE ${parts.join(' AND ')} GROUP BY prov."id", prov."name", pkg."providerName" ORDER BY active DESC LIMIT 10`,
    ...localParams
  )
}

async function buildPackageQuery(dateRange: any, filters: any) {
  const parts: string[] = []
  const localParams: any[] = []
  let idx = 0
  function add(v: any): number { idx++; localParams.push(v); return idx }
  if (dateRange.from) parts.push(`pu."createdAt" >= $${add(dateRange.from.toISOString())}::timestamp`)
  if (dateRange.to) parts.push(`pu."createdAt" <= $${add(dateRange.to.toISOString())}::timestamp`)
  if (filters.businessId) parts.push(`pu."businessId" = $${add(filters.businessId)}`)
  if (filters.packageId) parts.push(`pu."packageId" = $${add(filters.packageId)}`)
  if (filters.providers.length > 0) {
    const provParts = filters.providers.map((p: string) => `prov."id" = $${add(p)}`)
    parts.push(`(${provParts.join(' OR ')})`)
  }
  const purchaseFilter = parts.length > 0 ? `AND ${parts.join(' AND ')}` : ''

  return prisma.$queryRawUnsafe<Array<{ package_id: string; name: string; data_gb: number; validity_days: number; cost_price: string | null; retail_price: string; orders: bigint; revenue: string | null }>>(
    `SELECT pkg."id" as package_id, pkg."name", pkg."dataGB" as data_gb, pkg."validityDays" as validity_days,
     pkg."costPriceUSD"::text as cost_price, pkg."priceUSD"::text as retail_price,
     COUNT(DISTINCT pu."id") as orders, COALESCE(SUM(pu."totalAmount")::text, '0') as revenue
     FROM "esim_packages" pkg LEFT JOIN "esim_purchases" pu ON pu."packageId" = pkg."id" AND pu."status" = 'COMPLETED'
     LEFT JOIN "providers" prov ON prov."id" = pkg."providerId"
     ${purchaseFilter ? `WHERE ${purchaseFilter.replace('AND ', '')}` : ''}
     GROUP BY pkg."id", pkg."name", pkg."dataGB", pkg."validityDays", pkg."costPriceUSD", pkg."priceUSD"
     HAVING COUNT(DISTINCT pu."id") > 0 ORDER BY revenue DESC LIMIT 10`,
    ...localParams
  )
}

async function buildMonthlyQuery(dateRange: any, filters: any) {
  const parts: string[] = []
  const localParams: any[] = []
  let idx = 0
  function add(v: any): number { idx++; localParams.push(v); return idx }
  if (dateRange.from) parts.push(`"createdAt" >= $${add(dateRange.from.toISOString())}::timestamp`)
  if (dateRange.to) parts.push(`"createdAt" <= $${add(dateRange.to.toISOString())}::timestamp`)
  if (filters.businessId) parts.push(`"businessId" = $${add(filters.businessId)}`)
  if (filters.packageId) parts.push(`"packageId" = $${add(filters.packageId)}`)
  const whereClause = parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : ''

  return prisma.$queryRawUnsafe<Array<{ month: string; count: bigint; revenue: string | null }>>(
    `SELECT TO_CHAR("createdAt", 'YYYY-MM') as month, COUNT(*) as count, COALESCE(SUM("totalAmount")::text, '0') as revenue
     FROM "esim_purchases" ${whereClause} GROUP BY month ORDER BY month DESC LIMIT 12`,
    ...localParams
  )
}
