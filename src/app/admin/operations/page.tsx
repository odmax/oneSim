import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { deriveOperationalState, deriveWalletOperationalSummary, deriveFulfillmentOperationalSummary } from '@/lib/services/operations/operational-classifier'

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

  // Rough critical count: orders needing manual intervention from recent set
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
          <h3 className="text-base font-semibold text-gray-900">Job Health</h3>
        </div>
        <div className="px-5 py-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {['order-recovery', 'order-callback-delivery', 'inventory-reservation-sweep', 'exchange-rate-refresh'].map(name => (
              <div key={name} className="rounded-lg border p-3">
                <p className="text-xs font-medium text-gray-700">{name}</p>
                <p className="mt-1 text-xs text-gray-400">Feature: {process.env[name.toUpperCase().replace(/-/g, '_') + '_ENABLED'] ? 'Enabled' : 'Default'}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-300 text-right">Operations Centre v1.0</p>
    </div>
  )
}
