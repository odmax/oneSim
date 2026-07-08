import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

export default async function MonitoringDashboardPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.VIEW_ANALYTICS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  // DB health check
  let dbOk = false
  let dbLatency = 0
  try {
    const dbStart = Date.now()
    await prisma.$queryRaw`SELECT 1`
    dbLatency = Date.now() - dbStart
    dbOk = true
  } catch { dbOk = false }

  // Provider health summary
  const providers = await prisma.provider.findMany({
    select: { id: true, name: true, status: true, certificationStatus: true, errorCount: true, lastError: true },
  })
  const operationalProviders = providers.filter(p => ['ACTIVE', 'DEGRADED', 'TESTING'].includes(p.status)).length
  const degradedProviders = providers.filter(p => p.status === 'DEGRADED').length
  const providersWithErrors = providers.filter(p => (p.errorCount || 0) > 0).length

  // Order stats
  const failedOrders = await prisma.eSIMPurchase.count({ where: { status: 'FAILED' } })
  const pendingOrders = await prisma.eSIMPurchase.count({ where: { status: { in: ['PENDING_PROVIDER', 'PAYMENT_RESERVED'] } } })
  const activeEsims = await prisma.eSIM.count({ where: { status: 'ACTIVE' } })

  // Webhook stats
  const failedWebhooks = await prisma.webhookDelivery.count({ where: { status: 'FAILED', attempts: { lt: 5 } } })
  const pendingWebhooks = await prisma.webhookDelivery.count({ where: { status: 'PENDING' } })

  // Business stats
  const totalBusinesses = await prisma.business.count()
  const approvedBusinesses = await prisma.business.count({ where: { status: 'APPROVED' } })
  const pendingBusinesses = await prisma.business.count({ where: { status: 'PENDING' } })

  // Recent cron jobs
  const recentJobs = await prisma.backgroundJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
  })

  const appStartTime = parseInt(process.env.APP_START_TIME || `${Date.now()}`)
  const uptimeSeconds = Math.floor((Date.now() - appStartTime) / 1000)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">System Monitoring</h2>
          <p className="text-gray-600">Real-time operational status and health metrics</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className={`inline-flex h-2.5 w-2.5 rounded-full ${dbOk ? 'bg-emerald-400' : 'bg-red-400'}`} />
          <span className="text-gray-500">{uptimeSeconds > 86400 ? `${Math.floor(uptimeSeconds / 86400)}d` : `${Math.floor(uptimeSeconds / 3600)}h`} uptime</span>
        </div>
      </div>

      {/* Health Summary Grid */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <span className={`inline-flex h-2.5 w-2.5 rounded-full ${dbOk ? 'bg-emerald-400' : 'bg-red-400'}`} />
            <p className="text-xs font-medium text-gray-500 uppercase">Database</p>
          </div>
          <p className="mt-1 text-2xl font-bold text-gray-900">{dbOk ? 'Connected' : 'Disconnected'}</p>
          <p className="text-xs text-gray-400">{dbLatency}ms latency</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">Providers</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{operationalProviders}/{providers.length}</p>
          <p className="text-xs text-gray-400">{degradedProviders} degraded, {providersWithErrors} with errors</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">Orders</p>
          <p className={`mt-1 text-2xl font-bold ${failedOrders > 0 ? 'text-red-600' : 'text-gray-900'}`}>{failedOrders} failed</p>
          <p className="text-xs text-gray-400">{pendingOrders} pending, {activeEsims} active eSIMs</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">Webhooks</p>
          <p className={`mt-1 text-2xl font-bold ${failedWebhooks > 0 ? 'text-amber-600' : 'text-gray-900'}`}>{pendingWebhooks} pending</p>
          <p className="text-xs text-gray-400">{failedWebhooks} failed (retryable)</p>
        </div>
      </div>

      {/* Provider Status */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Provider Status</h3>
        {providers.length === 0 ? (
          <p className="text-sm text-gray-400">No providers configured.</p>
        ) : (
          <div className="space-y-1">
            {providers.map(p => (
              <div key={p.id} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-gray-50">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex h-2 w-2 rounded-full ${
                    p.status === 'ACTIVE' ? 'bg-emerald-400' :
                    p.status === 'DEGRADED' ? 'bg-amber-400' :
                    p.status === 'TESTING' ? 'bg-blue-400' :
                    'bg-gray-400'
                  }`} />
                  <Link href={`/admin/providers/${p.id}`} className="font-medium text-gray-900 hover:text-cyan-600">{p.name}</Link>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs ${(p.errorCount || 0) > 0 ? 'text-red-500' : 'text-gray-400'}`}>{p.errorCount || 0} errors</span>
                  <span className="text-xs text-gray-400">{p.certificationStatus || '—'}</span>
                  <span className="text-xs text-gray-500">{p.status}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cron Jobs */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent Cron Runs</h3>
        {recentJobs.length === 0 ? (
          <p className="text-sm text-gray-400">No cron jobs have run yet.</p>
        ) : (
          <div className="space-y-1">
            {recentJobs.map(job => (
              <div key={job.id} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-gray-50">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex h-2 w-2 rounded-full ${
                    job.status === 'COMPLETED' ? 'bg-emerald-400' :
                    job.status === 'FAILED' ? 'bg-red-400' : 'bg-amber-400'
                  }`} />
                  <span className="font-medium text-gray-900">{job.type}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-400">
                  <span>{new Date(job.createdAt).toLocaleString()}</span>
                  <span className={job.status === 'FAILED' ? 'text-red-500' : ''}>{job.status}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick Links */}
      <div className="flex gap-3">
        <Link href="/admin/alerts" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Alerts</Link>
        <Link href="/admin/provider-health" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Provider Health</Link>
        <Link href="/admin/webhook-monitoring" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Webhooks</Link>
        <Link href="/admin/orders?retryable=1" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Failed Orders</Link>
      </div>
    </div>
  )
}
