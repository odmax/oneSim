import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

export default async function PerformanceDashboardPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.VIEW_ANALYTICS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  // API latency from ApiRequestLog (last 24h)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recentRequests = await prisma.apiRequestLog.findMany({
    where: { createdAt: { gte: oneDayAgo } },
    select: { durationMs: true, statusCode: true, method: true, path: true },
  })

  const avgApiLatency = recentRequests.length > 0
    ? Math.round(recentRequests.reduce((s, r) => s + (r.durationMs || 0), 0) / recentRequests.length)
    : 0

  const p95Latencies = [...recentRequests].map(r => r.durationMs || 0).sort((a, b) => a - b)
  const p95Index = Math.ceil(p95Latencies.length * 0.95) - 1
  const p95Latency = p95Latencies.length > 0 ? (p95Latencies[p95Index] || 0) : 0

  const apiSuccess = recentRequests.filter(r => r.statusCode >= 200 && r.statusCode < 400).length
  const apiSuccessRate = recentRequests.length > 0 ? Math.round((apiSuccess / recentRequests.length) * 100) : 100

  // Purchase success rate (last 100 orders)
  const recentOrders = await prisma.eSIMPurchase.findMany({
    where: { createdAt: { gte: oneDayAgo } },
    select: { status: true },
  })
  const totalOrders = recentOrders.length
  const failedOrders = recentOrders.filter(o => o.status === 'FAILED').length
  const purchaseSuccessRate = totalOrders > 0 ? Math.round(((totalOrders - failedOrders) / totalOrders) * 100) : 100

  // Orders per hour
  const ordersPerHour = totalOrders > 0 ? (totalOrders / 24).toFixed(1) : '0'

  // Wallet transactions per hour
  const walletTxCount = await prisma.walletTransaction.count({
    where: { createdAt: { gte: oneDayAgo } },
  })
  const txPerHour = walletTxCount > 0 ? (walletTxCount / 24).toFixed(1) : '0'

  // Average provider response time (from health tracking)
  const providers = await prisma.provider.findMany({
    select: { name: true, activationSuccessRate: true, averageActivationTimeMs: true, errorCount: true, lastError: true, status: true },
  })
  const avgProviderTime = providers.filter(p => p.averageActivationTimeMs).length > 0
    ? Math.round(providers.filter(p => p.averageActivationTimeMs).reduce((s, p) => s + (p.averageActivationTimeMs || 0), 0) / providers.filter(p => p.averageActivationTimeMs).length)
    : 0

  // Webhook success rate
  const webhooks = await prisma.webhookDelivery.findMany({
    where: { createdAt: { gte: oneDayAgo } },
    select: { status: true },
  })
  const webhookSuccess = webhooks.filter(w => w.status === 'SENT').length
  const webhookSuccessRate = webhooks.length > 0 ? Math.round((webhookSuccess / webhooks.length) * 100) : 100

  // DB query performance (sample)
  let dbSampleMs = 0
  try {
    const dbStart = Date.now()
    await prisma.$queryRaw`SELECT 1`
    dbSampleMs = Date.now() - dbStart
  } catch { dbSampleMs = -1 }

  // Recent API errors
  const recentApiErrors = await prisma.apiRequestLog.findMany({
    where: { createdAt: { gte: oneDayAgo }, statusCode: { gte: 500 } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Performance Dashboard</h2>
          <p className="text-gray-600">System performance metrics and operational KPIs for the last 24 hours</p>
        </div>
      </div>

      {/* KPI Grid */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">API Avg Latency</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{avgApiLatency}ms</p>
          <p className="text-xs text-gray-400">P95: {p95Latency}ms · {recentRequests.length} requests</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">API Success Rate</p>
          <p className={`mt-1 text-2xl font-bold ${apiSuccessRate >= 99 ? 'text-emerald-600' : apiSuccessRate >= 95 ? 'text-amber-600' : 'text-red-600'}`}>
            {apiSuccessRate}%
          </p>
          <p className="text-xs text-gray-400">{recentRequests.length - apiSuccess} errors in 24h</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">Purchase Success</p>
          <p className={`mt-1 text-2xl font-bold ${purchaseSuccessRate >= 95 ? 'text-emerald-600' : purchaseSuccessRate >= 80 ? 'text-amber-600' : 'text-red-600'}`}>
            {purchaseSuccessRate}%
          </p>
          <p className="text-xs text-gray-400">{totalOrders} orders · {ordersPerHour}/hr</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">DB Latency</p>
          <p className={`mt-1 text-2xl font-bold ${dbSampleMs < 5 ? 'text-emerald-600' : dbSampleMs < 20 ? 'text-amber-600' : 'text-red-600'}`}>
            {dbSampleMs >= 0 ? `${dbSampleMs}ms` : 'Error'}
          </p>
          <p className="text-xs text-gray-400">SELECT 1 probe</p>
        </div>
      </div>

      {/* Secondary KPIs */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">Provider Avg Response</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{avgProviderTime > 0 ? `${avgProviderTime}ms` : 'N/A'}</p>
          <p className="text-xs text-gray-400">{providers.length} providers</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">Webhook Success Rate</p>
          <p className={`mt-1 text-2xl font-bold ${webhookSuccessRate >= 95 ? 'text-emerald-600' : 'text-amber-600'}`}>
            {webhookSuccessRate}%
          </p>
          <p className="text-xs text-gray-400">{webhooks.length} deliveries</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">Orders/Hour</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{ordersPerHour}</p>
          <p className="text-xs text-gray-400">{totalOrders} total in 24h</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">Wallet Tx/Hour</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{txPerHour}</p>
          <p className="text-xs text-gray-400">{walletTxCount} total in 24h</p>
        </div>
      </div>

      {/* Provider Performance */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Provider Performance</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-gray-500 uppercase">
                <th className="text-left py-2 px-3">Provider</th>
                <th className="text-left py-2 px-3">Status</th>
                <th className="text-right py-2 px-3">Success Rate</th>
                <th className="text-right py-2 px-3">Avg Response</th>
                <th className="text-right py-2 px-3">Errors</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {providers.map(p => (
                <tr key={p.name} className="hover:bg-gray-50">
                  <td className="py-2 px-3 font-medium text-gray-900">{p.name}</td>
                  <td className="py-2 px-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      p.status === 'ACTIVE' ? 'bg-green-100 text-green-700' :
                      p.status === 'DEGRADED' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'
                    }`}>{p.status}</span>
                  </td>
                  <td className="py-2 px-3 text-right">{p.activationSuccessRate != null ? `${p.activationSuccessRate}%` : '—'}</td>
                  <td className="py-2 px-3 text-right">{p.averageActivationTimeMs != null ? `${p.averageActivationTimeMs}ms` : '—'}</td>
                  <td className="py-2 px-3 text-right text-red-500">{p.errorCount || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent API Errors */}
      {recentApiErrors.length > 0 && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent API Errors (5xx)</h3>
          <div className="space-y-1">
            {recentApiErrors.map((err, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-red-600">{err.method}</span>
                  <span className="text-red-700">{err.path}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-red-600">{err.statusCode}</span>
                  <span className="text-gray-400">{err.durationMs}ms</span>
                  <span className="text-gray-400">{new Date(err.createdAt).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
