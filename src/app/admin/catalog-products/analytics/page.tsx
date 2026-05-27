import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { getCatalogAnalytics } from '@/lib/services/analytics/catalog-analytics'

export default async function CatalogAnalyticsPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.VIEW_ANALYTICS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const summary = await getCatalogAnalytics()

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href="/admin/catalog-products" className="text-sm text-cyan-600 hover:underline">← Back to Catalog Products</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Catalog Product Analytics</h2>
        <p className="text-gray-600">Revenue, cost, and performance by product</p>
      </div>

      {/* Summary cards */}
      <div className="mb-8 grid gap-4 md:grid-cols-4">
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Total Revenue</p>
          <p className="mt-1 text-2xl font-bold text-green-700">${summary.totalRevenue.toFixed(2)}</p>
        </div>
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Total Cost</p>
          <p className="mt-1 text-2xl font-bold text-red-700">${summary.totalCost.toFixed(2)}</p>
        </div>
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Profit</p>
          <p className={`mt-1 text-2xl font-bold ${summary.totalProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            ${summary.totalProfit.toFixed(2)}
          </p>
        </div>
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Margin</p>
          <p className={`mt-1 text-2xl font-bold ${(summary.overallMargin ?? 0) >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            {summary.overallMargin !== null ? `${summary.overallMargin}%` : '—'}
          </p>
        </div>
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Activations</p>
          <p className="mt-1 text-2xl font-bold text-blue-700">{summary.totalActivations}</p>
        </div>
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Active Products</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{summary.activeProducts}/{summary.totalProducts}</p>
        </div>
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Avg Revenue/Activation</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">
            ${summary.totalActivations > 0 ? (summary.totalRevenue / summary.totalActivations).toFixed(2) : '0.00'}
          </p>
        </div>
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Providers</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{summary.providerBreakdown.length}</p>
        </div>
      </div>

      {/* Revenue by Product */}
      <div className="mb-6 rounded-lg border bg-white p-6 shadow-sm">
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Revenue by Product</h3>
        {summary.revenueByProduct.length === 0 ? (
          <p className="text-sm text-gray-500">No revenue data yet.</p>
        ) : (
          <div className="space-y-3">
            {summary.revenueByProduct.map((item) => (
              <div key={item.productId} className="flex items-center gap-4">
                <Link
                  href={`/admin/packages/${item.productId}/edit`}
                  className="w-48 truncate text-sm font-medium text-cyan-700 hover:underline"
                  title={item.productName}
                >
                  {item.productName}
                </Link>
                <div className="flex-1">
                  <div className="h-3 rounded-full bg-gray-100">
                    <div
                      className="h-3 rounded-full bg-cyan-500"
                      style={{ width: `${Math.max(item.percentage, 1)}%` }}
                    />
                  </div>
                </div>
                <span className="w-24 text-right text-sm font-medium text-gray-900">${item.revenue.toFixed(2)}</span>
                <span className="w-14 text-right text-xs text-gray-500">{item.percentage}%</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Top Products Table */}
      <div className="mb-6 rounded-lg border bg-white shadow-sm">
        <div className="border-b border-gray-100 px-6 py-4">
          <h3 className="text-lg font-semibold text-gray-900">Top Products by Revenue</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase text-gray-500">Product</th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase text-gray-500">Revenue</th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase text-gray-500">Cost</th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase text-gray-500">Margin</th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase text-gray-500">Activations</th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase text-gray-500">Avg Revenue</th>
                <th className="px-6 py-3 text-center text-xs font-medium uppercase text-gray-500">Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {summary.topProducts.map((p) => (
                <tr key={p.productId} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <Link href={`/admin/packages/${p.productId}/edit`} className="font-medium text-cyan-700 hover:underline">
                      {p.productName}
                    </Link>
                    {p.providerName && <p className="text-xs text-gray-500">{p.providerName}</p>}
                  </td>
                  <td className="px-6 py-4 text-right font-medium text-gray-900">${p.totalRevenue.toFixed(2)}</td>
                  <td className="px-6 py-4 text-right text-red-600">${p.totalCost.toFixed(2)}</td>
                  <td className="px-6 py-4 text-right">
                    {p.profitMargin !== null ? (
                      <span className={`font-medium ${p.profitMargin >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {p.profitMargin}%
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right text-gray-700">{p.totalActivations}</td>
                  <td className="px-6 py-4 text-right text-gray-700">${p.avgRevenuePerActivation.toFixed(2)}</td>
                  <td className="px-6 py-4 text-center">
                    {p.isActive ? (
                      <span className="inline-flex rounded-full bg-green-100 px-2 text-xs font-semibold text-green-800">Yes</span>
                    ) : (
                      <span className="inline-flex rounded-full bg-gray-100 px-2 text-xs font-semibold text-gray-500">No</span>
                    )}
                  </td>
                </tr>
              ))}
              {summary.topProducts.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-gray-500">No catalog products with revenue yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Provider Breakdown */}
      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Provider Performance</h3>
        {summary.providerBreakdown.length === 0 ? (
          <p className="text-sm text-gray-500">No provider data yet.</p>
        ) : (
          <div className="space-y-3">
            {summary.providerBreakdown.map((p) => (
              <div key={p.providerName} className="flex items-center justify-between rounded-lg bg-gray-50 p-3">
                <div>
                  <p className="font-medium text-gray-900">{p.providerName}</p>
                  <p className="text-xs text-gray-500">{p.activations} activations</p>
                </div>
                <span className="font-medium text-gray-900">${p.revenue.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
