import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

export default async function AdminApiAnalyticsPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)

  const [
    totalRequests, requestsToday, requestsMonth, failedToday,
    avgDuration, topBusinesses, topEndpoints,
    webhookDeliveries, providerWebhookEvents, dailyCounts,
  ] = await Promise.all([
    prisma.apiRequestLog.count(),
    prisma.apiRequestLog.count({ where: { createdAt: { gte: today } } }),
    prisma.apiRequestLog.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.apiRequestLog.count({ where: { createdAt: { gte: today }, statusCode: { gte: 400 } } }),
    prisma.apiRequestLog.aggregate({ where: { createdAt: { gte: today } }, _avg: { durationMs: true } }),
    prisma.apiRequestLog.groupBy({ by: ['businessId'], _count: true, orderBy: { _count: { businessId: 'desc' } }, take: 10 }),
    prisma.apiRequestLog.groupBy({ by: ['path'], where: { createdAt: { gte: today } }, _count: true, orderBy: { _count: { path: 'desc' } }, take: 10 }),
    prisma.webhookDelivery.count({ where: { createdAt: { gte: today } } }),
    prisma.providerWebhookEvent.count({ where: { receivedAt: { gte: today } } }),
    prisma.apiRequestLog.groupBy({ by: ['createdAt'], where: { createdAt: { gte: monthStart } }, _count: true }),
  ])

  const avgMs = avgDuration._avg.durationMs ? Math.round(avgDuration._avg.durationMs) : 0
  const errorRate = requestsToday > 0 ? Math.round((failedToday / requestsToday) * 100) : 0

  // Resolve business names
  const bizNames = new Map<string, string>()
  if (topBusinesses.length > 0) {
    const businesses = await prisma.business.findMany({ where: { id: { in: topBusinesses.map(b => b.businessId) } }, select: { id: true, name: true } })
    businesses.forEach(b => bizNames.set(b.id, b.name))
  }

  const Card = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )

  return (
    <div className="p-6 space-y-6">
      <div><h2 className="text-2xl font-bold text-gray-900">API Analytics</h2><p className="text-sm text-gray-600">Platform-wide API usage and health</p></div>

      <div className="grid gap-4 grid-cols-2 sm:grid-cols-4 lg:grid-cols-6">
        <Card label="Total Requests" value={totalRequests.toLocaleString()} />
        <Card label="Today" value={requestsToday} />
        <Card label="This Month" value={requestsMonth} />
        <Card label="Failed Today" value={failedToday} sub={`${errorRate}% error rate`} />
        <Card label="Avg Response" value={`${avgMs}ms`} />
        <Card label="Webhook Deliveries" value={webhookDeliveries} sub="today" />
        <Card label="Provider Events" value={providerWebhookEvents} sub="today" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Top Businesses Today</h3>
          {topBusinesses.length === 0 ? <p className="text-sm text-gray-400">No requests today.</p> : (
            <div className="space-y-2">
              {topBusinesses.map(b => (
                <Link key={b.businessId} href={`/admin/businesses/${b.businessId}`} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2 text-sm hover:bg-gray-100">
                  <span className="text-cyan-600 font-medium truncate max-w-[250px]">{bizNames.get(b.businessId) || b.businessId}</span>
                  <span className="font-medium text-gray-900 ml-2">{b._count} req</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Top Endpoints Today</h3>
          {topEndpoints.length === 0 ? <p className="text-sm text-gray-400">No requests today.</p> : (
            <div className="space-y-2">
              {topEndpoints.map(ep => (
                <div key={ep.path} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2 text-sm">
                  <span className="font-mono text-gray-700 truncate max-w-[350px]">{ep.path}</span>
                  <span className="font-medium text-gray-900 ml-2">{ep._count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Rate Limit Alerts</h3>
        <p className="text-sm text-gray-500 mb-3">Businesses that used ≥80% of their rate limit today</p>
        <RateLimitAlerts />
      </div>
    </div>
  )
}

async function RateLimitAlerts() {
  const businesses = await prisma.business.findMany({
    where: { rateLimitPerMinute: { not: null } },
    select: { id: true, name: true, rateLimitPerMinute: true, contactEmail: true },
  })

  const oneMinuteAgo = new Date(Date.now() - 60 * 1000)
  const alerts: { name: string; id: string; usage: number; limit: number; pct: number }[] = []

  for (const biz of businesses) {
    const limit = biz.rateLimitPerMinute || 60
    const count = await prisma.apiRequestLog.count({
      where: { businessId: biz.id, createdAt: { gte: oneMinuteAgo } },
    })
    const pct = Math.round((count / limit) * 100)
    if (pct >= 80) alerts.push({ name: biz.name, id: biz.id, usage: count, limit, pct })
  }

  if (alerts.length === 0) return <p className="text-sm text-gray-400">No businesses currently near their rate limit.</p>

  return (
    <div className="space-y-2">
      {alerts.sort((a, b) => b.pct - a.pct).map(a => (
        <div key={a.id} className="flex items-center justify-between rounded px-4 py-2 text-sm bg-amber-50">
          <div>
            <span className="font-medium text-amber-800">{a.name}</span>
            <span className="ml-2 text-amber-600">{a.usage}/{a.limit} req/min ({a.pct}%)</span>
          </div>
          <span className="text-amber-700 font-medium">{a.pct >= 95 ? '⚠️ Critical' : '⚠️ Warning'}</span>
        </div>
      ))}
    </div>
  )
}