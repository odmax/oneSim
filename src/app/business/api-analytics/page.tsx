import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'

export default async function BusinessApiAnalyticsPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')
  const businessId = session.user.businessId!

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)

  const [
    requestsToday, requestsMonth, successToday, failedToday,
    avgDuration, ordersCount, esimCount, webhookDeliveries,
    topEndpoints, recentActivity, dailyCounts, statusCounts,
  ] = await Promise.all([
    prisma.apiRequestLog.count({ where: { businessId, createdAt: { gte: today } } }),
    prisma.apiRequestLog.count({ where: { businessId, createdAt: { gte: monthStart } } }),
    prisma.apiRequestLog.count({ where: { businessId, createdAt: { gte: today }, statusCode: { lt: 400 } } }),
    prisma.apiRequestLog.count({ where: { businessId, createdAt: { gte: today }, statusCode: { gte: 400 } } }),
    prisma.apiRequestLog.aggregate({ where: { businessId, createdAt: { gte: today } }, _avg: { durationMs: true } }),
    prisma.eSIMPurchase.count({ where: { businessId, createdAt: { gte: today } } }),
    prisma.eSIM.count({ where: { purchase: { businessId }, createdAt: { gte: today } } }),
    prisma.webhookDelivery.count({ where: { businessId, createdAt: { gte: today } } }),
    prisma.apiRequestLog.groupBy({ by: ['path'], where: { businessId, createdAt: { gte: today } }, _count: true, orderBy: { _count: { path: 'desc' } }, take: 10 }),
    prisma.apiRequestLog.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.apiRequestLog.groupBy({ by: ['createdAt'], where: { businessId, createdAt: { gte: monthStart } }, _count: true }),
    prisma.apiRequestLog.groupBy({ by: ['statusCode'], where: { businessId, createdAt: { gte: today } }, _count: true }),
  ])

  const avgMs = avgDuration._avg.durationMs ? Math.round(avgDuration._avg.durationMs) : 0

  const Card = ({ label, value }: { label: string; value: string | number }) => (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
    </div>
  )

  return (
    <div className="space-y-6">
      <div><h2 className="text-2xl font-bold text-gray-900">API Analytics</h2><p className="mt-1 text-sm text-gray-500">Monitor your API consumption</p></div>

      <div className="grid gap-4 grid-cols-2 sm:grid-cols-4 lg:grid-cols-6">
        <Card label="Requests Today" value={requestsToday} />
        <Card label="This Month" value={requestsMonth} />
        <Card label="Successful" value={successToday} />
        <Card label="Failed" value={failedToday} />
        <Card label="Avg Response" value={`${avgMs}ms`} />
        <Card label="Orders Today" value={ordersCount} />
        <Card label="eSIMs Provisioned" value={esimCount} />
        <Card label="Webhook Deliveries" value={webhookDeliveries} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Top Endpoints Today</h3>
          {topEndpoints.length === 0 ? <p className="text-sm text-gray-400">No requests today.</p> : (
            <div className="space-y-2">
              {topEndpoints.map(ep => (
                <div key={ep.path} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2 text-sm">
                  <span className="font-mono text-gray-700 truncate max-w-[300px]">{ep.path}</span>
                  <span className="font-medium text-gray-900 ml-2">{ep._count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Status Codes Today</h3>
          {statusCounts.length === 0 ? <p className="text-sm text-gray-400">No requests today.</p> : (
            <div className="space-y-2">
              {statusCounts.map(s => (
                <div key={s.statusCode} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2 text-sm">
                  <span className="text-gray-700">{s.statusCode}</span>
                  <span className="font-medium text-gray-900">{s._count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-gray-100 bg-white shadow-sm">
        <div className="px-5 py-4 border-b border-gray-50">
          <h3 className="text-sm font-semibold text-gray-900">Recent API Activity</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50/50">
              <tr>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase text-gray-500">Time</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase text-gray-500">Method</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase text-gray-500">Endpoint</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase text-gray-500">Duration</th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase text-gray-500">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {recentActivity.map(r => (
                <tr key={r.id} className="hover:bg-gray-50/50 text-sm">
                  <td className="whitespace-nowrap px-5 py-3 text-gray-500">{new Date(r.createdAt).toLocaleTimeString()}</td>
                  <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-gray-700">{r.method}</td>
                  <td className="max-w-[250px] truncate px-5 py-3 font-mono text-xs text-gray-600" title={r.path}>{r.path}</td>
                  <td className="whitespace-nowrap px-5 py-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${r.statusCode < 400 ? 'bg-emerald-50 text-emerald-600' : r.statusCode < 500 ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-600'}`}>{r.statusCode}</span></td>
                  <td className="whitespace-nowrap px-5 py-3 text-gray-500">{r.durationMs}ms</td>
                  <td className="whitespace-nowrap px-5 py-3 text-xs font-mono text-gray-400">{r.ipAddress || '—'}</td>
                </tr>
              ))}
              {recentActivity.length === 0 && <tr><td colSpan={6} className="px-5 py-12 text-center text-sm text-gray-400">No API activity yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}