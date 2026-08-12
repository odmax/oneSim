import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { deriveOperationalState } from '@/lib/services/operations/operational-classifier'
import { computeProviderHealth } from '@/lib/services/operations/provider-health-score'

function SeverityBadge({ severity }: { severity: string }) {
  const colors: Record<string, string> = {
    INFO: 'bg-gray-100 text-gray-700',
    WARNING: 'bg-amber-100 text-amber-700',
    ERROR: 'bg-red-100 text-red-700',
    CRITICAL: 'bg-red-200 text-red-900 font-semibold',
  }
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${colors[severity] || colors.INFO}`}>{severity}</span>
}

function CountCard({ label, count, href, severity }: { label: string; count: number; href?: string; severity?: string }) {
  const colors: Record<string, string> = {
    CRITICAL: 'border-red-300 bg-red-50', ERROR: 'border-red-200 bg-red-50',
    WARNING: 'border-amber-200 bg-amber-50', INFO: 'border-gray-200 bg-white',
  }
  const content = (
    <div className={`rounded-xl border p-4 ${colors[severity || 'INFO']} ${href ? 'hover:shadow-md transition-shadow cursor-pointer' : ''}`}>
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{count}</p>
    </div>
  )
  if (href) return <Link href={href}>{content}</Link>
  return content
}

export default async function OperationsDashboardPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const now = new Date()
  const last24h = new Date(now.getTime() - 86400000)

  const [
    processingCount, reconcilingCount, partialCount, failed24h,
    deadLetterCallbacks, unprocessedWebhooks, unhealthyProviders,
    openCircuits, staleInventory, failedJobs24h,
    criticalOrders,
  ] = await Promise.all([
    prisma.eSIMPurchase.count({ where: { status: { in: ['PENDING_PROVIDER', 'PROVIDER_ACCEPTED', 'RESERVED', 'FULFILLING'] } } }),
    prisma.eSIMPurchase.count({ where: { status: 'PROVIDER_RECONCILIATION' } }),
    prisma.eSIMPurchase.count({ where: { status: 'PARTIALLY_FULFILLED' } }),
    prisma.eSIMPurchase.count({ where: { status: 'FAILED', updatedAt: { gte: last24h } } }),
    prisma.orderCallbackDelivery.count({ where: { status: 'DEAD_LETTERED' } }),
    prisma.providerWebhookEvent.count({ where: { status: 'RECEIVED', receivedAt: { lt: new Date(now.getTime() - 3600000) } } }),
    prisma.provider.count({ where: { status: { notIn: ['ACTIVE', 'DEGRADED', 'TESTING'] } } }),
    0, // open circuits require JSON query — count from config
    prisma.providerInventoryReservation.count({ where: { status: { in: ['RESERVED', 'PARTIALLY_FULFILLED'] }, expiresAt: { lt: now } } }),
    prisma.backgroundJob.count({ where: { status: 'FAILED', finishedAt: { gte: last24h } } }),
    prisma.eSIMPurchase.findMany({
      where: { status: { notIn: ['FULFILLED', 'REFUNDED', 'CANCELLED', 'EXPIRED'] }, updatedAt: { gte: new Date(now.getTime() - 3600000) } },
      select: { id: true, status: true, fulfilledQuantity: true, quantity: true },
      orderBy: { updatedAt: 'desc' }, take: 50,
    }),
  ])

  // Provider health scores
  const providers = await prisma.provider.findMany({ where: { status: { not: 'ARCHIVED' } }, take: 20 })
  const hp = await Promise.all(providers.map(async p => ({ ...p, health: await computeProviderHealth(p.id) })))
  hp.sort((a, b) => a.health.score - b.health.score)
  const healthyProv = hp.filter(p => p.health.health === 'HEALTHY').length
  const degradedProv = hp.filter(p => p.health.health === 'DEGRADED' || p.health.health === 'RECOVERING').length
  const unavailableProv = hp.filter(p => p.health.health === 'UNAVAILABLE').length
  const criticalAlerts = hp.reduce((sum, p) => sum + p.health.activeAlerts, 0)

  // System health score
  const systemScore = () => {
    if (unavailableProv > 0 || criticalAlerts > 5) return { level: 'CRITICAL', label: 'CRITICAL' }
    if (degradedProv > 0 || reconcilingCount > 5 || failedJobs24h > 3) return { level: 'DEGRADED', label: 'DEGRADED' }
    if (processingCount > 20 || deadLetterCallbacks > 0 || unprocessedWebhooks > 0) return { level: 'DEGRADED', label: 'DEGRADED' }
    return { level: 'HEALTHY', label: 'HEALTHY' }
  }
  const sysHealth = systemScore()

  // Job stats
  const jobStats = await prisma.backgroundJob.groupBy({
    by: ['type', 'status'],
    _count: true,
    where: { status: { in: ['PENDING', 'FAILED'] as any } },
  }).catch(() => [])

  const interventionCount = criticalOrders.filter(o => {
    const state = deriveOperationalState({
      orderStatus: o.status, orderAgeMinutes: 60,
      fulfilledQuantity: o.fulfilledQuantity ?? 0, requestedQuantity: o.quantity ?? 1,
      esimCount: 0, walletState: 'CAPTURED', walletAlerts: [],
      maxRetries: 5, retryCount: 5, isReconciling: o.status === 'PROVIDER_RECONCILIATION',
      isDeadLetteredCallback: false, hasUnprocessedWebhook: false, hasProviderFulfillmentEvidence: false,
    })
    return state.severity === 'CRITICAL' || (state.severity === 'ERROR' && state.actionRequired)
  }).length

  const manualIntervention = deadLetterCallbacks + unprocessedWebhooks + interventionCount + staleInventory

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Operations</h2>
        <p className="mt-1 text-sm text-gray-500">System overview and operational health</p>
        <span className={`inline-flex rounded-full px-2.5 py-0.5 mt-2 text-xs font-bold ${sysHealth.level === 'HEALTHY' ? 'bg-emerald-100 text-emerald-800' : sysHealth.level === 'DEGRADED' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'}`}>
          System: {sysHealth.label}
        </span>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <CountCard label="Orders Processing" count={processingCount} href="/admin/operations/orders?status=PENDING_PROVIDER" severity="INFO" />
        <CountCard label="Orders Reconciling" count={reconcilingCount} href="/admin/operations/orders?reconciliation=1" severity="ERROR" />
        <CountCard label="Partially Fulfilled" count={partialCount} href="/admin/operations/orders?partial=1" severity="WARNING" />
        <CountCard label="Failed (24h)" count={failed24h} href="/admin/operations/orders?status=FAILED" severity="ERROR" />
        <CountCard label="Manual Intervention" count={manualIntervention} href="/admin/operations/orders?actionRequired=1" severity={manualIntervention > 0 ? 'CRITICAL' : 'INFO'} />
        <CountCard label="Dead-Letter Callbacks" count={deadLetterCallbacks} severity={deadLetterCallbacks > 0 ? 'ERROR' : 'INFO'} />
        <CountCard label="Unprocessed Webhooks" count={unprocessedWebhooks} severity={unprocessedWebhooks > 0 ? 'ERROR' : 'INFO'} />
        <CountCard label="Unhealthy Providers" count={unhealthyProviders} severity={unhealthyProviders > 0 ? 'ERROR' : 'INFO'} />
        <CountCard label="Active Alerts" count={criticalAlerts} severity={criticalAlerts > 0 ? 'CRITICAL' : 'INFO'} />
        <CountCard label="Provider Diagnostics" count={null as any} href="/admin/providers/diagnostics" severity="INFO" />
        <CountCard label="Stale Inventory" count={staleInventory} severity={staleInventory > 0 ? 'WARNING' : 'INFO'} />
        <CountCard label="Failed Jobs (24h)" count={failedJobs24h} href="/admin/jobs" severity={failedJobs24h > 0 ? 'ERROR' : 'INFO'} />
        <CountCard label="Callback Retries Due" count={deadLetterCallbacks} href="/admin/operations/callbacks?status=DEAD_LETTERED" severity={deadLetterCallbacks > 0 ? 'ERROR' : 'INFO'} />
        <CountCard label="Unprocessed Webhooks" count={unprocessedWebhooks} href="/admin/operations/webhooks?status=RECEIVED" severity={unprocessedWebhooks > 0 ? 'ERROR' : 'INFO'} />
      </div>

      {/* Manual intervention table */}
      {criticalOrders.length > 0 ? (
        <div className="rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between px-5 py-3 border-b">
            <h3 className="text-base font-semibold text-gray-900">Manual Intervention Required</h3>
            <Link href="/admin/operations/orders?actionRequired=1" className="text-xs text-cyan-600 hover:underline">View all</Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Severity</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Order</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Reason</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">View</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {criticalOrders.slice(0, 10).map(o => {
                  const state = deriveOperationalState({
                    orderStatus: o.status, orderAgeMinutes: 60,
                    fulfilledQuantity: o.fulfilledQuantity ?? 0, requestedQuantity: o.quantity ?? 1,
                    esimCount: 0, walletState: 'NONE', walletAlerts: [],
                    maxRetries: 5, retryCount: 5, isReconciling: o.status === 'PROVIDER_RECONCILIATION',
                    isDeadLetteredCallback: false, hasUnprocessedWebhook: false, hasProviderFulfillmentEvidence: false,
                  })
                  if (state.severity === 'INFO') return null
                  return (
                    <tr key={o.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2"><SeverityBadge severity={state.severity} /></td>
                      <td className="px-4 py-2 text-xs font-mono">{o.id.slice(-8)}</td>
                      <td className="px-4 py-2 text-xs">{o.status}</td>
                      <td className="px-4 py-2 text-xs text-gray-500">{state.reason}</td>
                      <td className="px-4 py-2 text-xs"><Link href={`/admin/orders/${o.id}`} className="text-cyan-600 hover:underline">View</Link></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-8 text-center text-sm text-gray-400">
          No orders currently require manual intervention.
        </div>
      )}

      {/* Job health */}
      <div className="rounded-xl border bg-white shadow-sm">
        <div className="px-5 py-3 border-b">
          <h3 className="text-base font-semibold text-gray-900">Background Jobs</h3>
        </div>
        <div className="px-5 py-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {['ESIM_STATUS_SYNC', 'ESIM_USAGE_SYNC', 'INSTALLATION_RECONCILIATION', 'PROVIDER_SELF_HEAL'].map(type => {
              const pending = jobStats.filter(j => j.type === type && j.status === 'PENDING').reduce((s, j) => s + j._count, 0)
              const failed = jobStats.filter(j => j.type === type && j.status === 'FAILED').reduce((s, j) => s + j._count, 0)
              return (
                <div key={type} className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-gray-700">{type.replace(/_/g, ' ')}</p>
                  <div className="mt-1 flex gap-3 text-xs">
                    <span className="text-gray-400">Pending: {pending}</span>
                    {failed > 0 && <span className="text-red-500">Failed: {failed}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Provider Health */}
      <div className="rounded-xl border bg-white shadow-sm">
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">Provider Health</h3>
          <div className="flex gap-3 text-xs">
            <span className="text-emerald-600">{healthyProv} Healthy</span>
            <span className="text-amber-600">{degradedProv} Degraded</span>
            <span className="text-red-600">{unavailableProv} Unavailable</span>
            <span className="text-orange-600">{criticalAlerts} Alerts</span>
          </div>
        </div>
        <div className="px-5 py-3 max-h-80 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-gray-400"><tr><th className="pb-2 pr-2">Provider</th><th className="pb-2 pr-2 w-12">Score</th><th className="pb-2 pr-2">Health</th><th className="pb-2 pr-2">Circuit</th><th className="pb-2 pr-2">Alerts</th></tr></thead>
            <tbody className="divide-y">
              {hp.slice(0, 10).map(p => {
                const cfg = (p.config as any) || {}
                const circuit = cfg.circuitBreaker?.state || 'CLOSED'
                const color = circuit === 'OPEN' ? 'text-red-600' : circuit === 'HALF_OPEN' ? 'text-amber-600' : 'text-emerald-600'
                return (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="py-1.5 pr-2"><Link href={`/admin/providers/diagnostics/${p.id}`} className="text-cyan-600 hover:underline font-medium">{p.name}</Link></td>
                    <td className={`py-1.5 pr-2 font-bold ${p.health.score >= 85 ? 'text-emerald-600' : p.health.score >= 60 ? 'text-amber-600' : 'text-red-600'}`}>{p.health.score}</td>
                    <td className="py-1.5 pr-2">{p.health.health}</td>
                    <td className={`py-1.5 pr-2 ${color}`}>{circuit}</td>
                    <td className="py-1.5 text-orange-500">{p.health.activeAlerts || 0}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-gray-300 text-right">Operations Centre v1.0</p>
    </div>
  )
}
