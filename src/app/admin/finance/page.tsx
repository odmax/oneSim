import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getBillingStats, getRevenueByProvider, getRevenueByBusiness, getRevenueBySalesAgent } from '@/lib/services/billing/billing-service'

export default async function FinanceDashboardPage({ searchParams }: { searchParams?: { period?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.VIEW_FINANCE)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const days = searchParams?.period === '90d' ? 90 : searchParams?.period === '30d' ? 30 : 7
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const stats = await getBillingStats({ startDate })
  const byProvider = await getRevenueByProvider({ startDate })
  const byBusiness = await getRevenueByBusiness({ startDate })
  const byAgent = await getRevenueBySalesAgent({ startDate })

  const walletStats = await prisma.walletTransaction.aggregate({
    where: { createdAt: { gte: startDate } },
    _sum: { amount: true },
  })

  const pendingInvoices = await prisma.invoice.count({
    where: { status: { in: ['DRAFT', 'PENDING'] } },
  })

  const totalWalletBalance = await prisma.business.aggregate({
    _sum: { walletBalance: true },
  })

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Finance Dashboard</h2>
          <p className="text-gray-600">Revenue, costs, and profitability overview</p>
        </div>
        <div className="flex gap-2">
          <Link href="/admin/finance?period=7d" className={`rounded-lg px-3 py-1.5 text-xs font-medium ${!searchParams?.period || searchParams.period === '7d' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>7 Days</Link>
          <Link href="/admin/finance?period=30d" className={`rounded-lg px-3 py-1.5 text-xs font-medium ${searchParams?.period === '30d' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>30 Days</Link>
          <Link href="/admin/finance?period=90d" className={`rounded-lg px-3 py-1.5 text-xs font-medium ${searchParams?.period === '90d' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>90 Days</Link>
        </div>
      </div>

      {/* P&L Summary */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Revenue</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">${stats.revenue.toFixed(2)}</p>
          <p className="text-xs text-gray-400">{stats.totalRecords} transactions</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Gross Profit</p>
          <p className={`mt-1 text-2xl font-bold ${stats.grossProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            ${stats.grossProfit.toFixed(2)}
          </p>
          <p className="text-xs text-gray-400">{stats.profitMargin}% margin</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Refunds</p>
          <p className="mt-1 text-2xl font-bold text-red-600">${stats.refunds.toFixed(2)}</p>
          <p className="text-xs text-gray-400">Net: ${stats.netRevenue.toFixed(2)}</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Wallet</p>
          <p className="mt-1 text-2xl font-bold text-blue-600">${Number(totalWalletBalance._sum.walletBalance || 0).toFixed(2)}</p>
          <p className="text-xs text-gray-400">{pendingInvoices} pending invoices</p>
        </div>
      </div>

      {/* Revenue by Provider */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Revenue by Provider</h3>
          {byProvider.length === 0 ? (
            <p className="text-sm text-gray-400">No data for this period</p>
          ) : (
            <div className="space-y-2">
              {byProvider.map(p => (
                <div key={p.name} className="flex items-center justify-between rounded-lg bg-gray-50 p-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{p.name}</p>
                    <p className="text-xs text-gray-400">{p.count} orders</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-gray-900">${p.revenue.toFixed(2)}</p>
                    <p className={`text-xs ${p.marginPercent >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {p.marginPercent}% margin
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Revenue by Business */}
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Revenue by Business</h3>
          {byBusiness.length === 0 ? (
            <p className="text-sm text-gray-400">No data for this period</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {byBusiness.map(b => (
                <div key={b.name} className="flex items-center justify-between rounded-lg bg-gray-50 p-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{b.name}</p>
                    <p className="text-xs text-gray-400">{b.count} orders{b.salesAgent ? ` · Agent: ${b.salesAgent}` : ''}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-gray-900">${b.revenue.toFixed(2)}</p>
                    <p className={`text-xs ${b.marginPercent >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {b.marginPercent}% margin
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Revenue by Sales Agent */}
      {byAgent.length > 0 && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Revenue by Sales Agent</h3>
          <div className="space-y-2">
            {byAgent.map(a => (
              <div key={a.name} className="flex items-center justify-between rounded-lg bg-gray-50 p-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{a.name}</p>
                  <p className="text-xs text-gray-400">{a.count} attributed orders</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-gray-900">${a.revenue.toFixed(2)}</p>
                  <p className={`text-xs ${a.marginPercent >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    ${a.profit.toFixed(2)} profit ({a.marginPercent}%)
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Revenue by Type */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Revenue by Type</h3>
        {Object.keys(stats.byType).length === 0 ? (
          <p className="text-sm text-gray-400">No data</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
            {Object.entries(stats.byType).map(([type, amount]) => (
              <div key={type} className="rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-medium text-gray-500 uppercase">{type}</p>
                <p className={`text-lg font-bold ${type === 'REFUND' ? 'text-red-600' : 'text-gray-900'}`}>
                  ${Number(amount).toFixed(2)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick Links */}
      <div className="flex gap-3">
        <Link href="/admin/invoices" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Invoices</Link>
        <Link href="/admin/orders" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Orders</Link>
        <Link href="/admin/analytics" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Analytics</Link>
      </div>
    </div>
  )
}
