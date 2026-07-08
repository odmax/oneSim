import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getRecentNotifications, getAlertCounts } from '@/lib/services/notifications/notification-service'

const SEVERITY_COLORS: Record<string, string> = {
  error: 'bg-red-50 border-red-200 text-red-700',
  warning: 'bg-amber-50 border-amber-200 text-amber-700',
  success: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  info: 'bg-blue-50 border-blue-200 text-blue-700',
}

const SEVERITY_DOTS: Record<string, string> = {
  error: 'bg-red-400',
  warning: 'bg-amber-400',
  success: 'bg-emerald-400',
  info: 'bg-blue-400',
}

export default async function AdminAlertsPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.VIEW_ANALYTICS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const notifications = await getRecentNotifications(100)
  const counts = await getAlertCounts()

  // Get additional alert data
  const failedOrders = await prisma.eSIMPurchase.count({
    where: { status: 'FAILED', retryCount: { lt: 3 }, failureReason: { not: null } },
  })

  const failedWebhooks = await prisma.webhookDelivery.count({
    where: { status: 'FAILED', attempts: { lt: 5 } },
  })

  const providers = await prisma.provider.findMany({
    where: { status: { in: ['DEGRADED', 'MAINTENANCE', 'INACTIVE'] } },
    select: { id: true, name: true, status: true, lastError: true },
  })

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Alerts & Notifications</h2>
          <p className="text-gray-600">Monitor system events, provider health, and business activities</p>
        </div>
      </div>

      {/* Alert summary cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">Active Issues</p>
          <p className="mt-1 text-2xl font-bold text-red-600">{counts.errors}</p>
          <p className="text-xs text-gray-400">errors in 24h</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">Warnings</p>
          <p className="mt-1 text-2xl font-bold text-amber-600">{counts.warnings}</p>
          <p className="text-xs text-gray-400">warnings in 24h</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">Failed Orders</p>
          <p className={`mt-1 text-2xl font-bold ${failedOrders > 0 ? 'text-red-600' : 'text-gray-900'}`}>{failedOrders}</p>
          <p className="text-xs text-gray-400">need retry attention</p>
        </div>
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-gray-500 uppercase">Failed Webhooks</p>
          <p className={`mt-1 text-2xl font-bold ${failedWebhooks > 0 ? 'text-amber-600' : 'text-gray-900'}`}>{failedWebhooks}</p>
          <p className="text-xs text-gray-400">pending retry</p>
        </div>
      </div>

      {/* Provider alerts */}
      {providers.length > 0 && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Provider Status Alerts</h3>
          <div className="space-y-2">
            {providers.map(p => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border border-red-100 bg-red-50 p-3">
                <div>
                  <p className="text-sm font-medium text-red-800">{p.name}</p>
                  <p className="text-xs text-red-600">Status: {p.status}{p.lastError ? ` — ${p.lastError}` : ''}</p>
                </div>
                <Link href={`/admin/providers/${p.id}`} className="text-xs font-medium text-red-700 hover:text-red-800">View →</Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notification timeline */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">
          Event Timeline
          <span className="ml-2 text-xs font-normal text-gray-400">({notifications.length} events)</span>
        </h3>
        {notifications.length === 0 ? (
          <p className="text-sm text-gray-400">No notifications yet.</p>
        ) : (
          <div className="space-y-1 max-h-[600px] overflow-y-auto">
            {notifications.map(n => (
              <div key={n.id} className={`flex items-start gap-3 rounded-lg border p-3 ${SEVERITY_COLORS[n.severity] || 'bg-gray-50 border-gray-200 text-gray-700'}`}>
                <div className={`w-2 h-2 mt-1.5 rounded-full shrink-0 ${SEVERITY_DOTS[n.severity] || 'bg-gray-400'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium capitalize">{n.description}</span>
                    <span className="text-[10px] opacity-60">{new Date(n.createdAt).toLocaleString()}</span>
                  </div>
                  {n.entityId && <p className="text-[10px] opacity-60 mt-0.5">{n.entity}: {n.entityId.slice(-12)}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick links */}
      <div className="flex gap-3">
        <Link href="/admin/orders?retryable=1" className="rounded-lg border border-amber-200 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50">Failed Orders</Link>
        <Link href="/admin/webhook-monitoring" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Webhook Monitor</Link>
        <Link href="/admin/provider-health" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Provider Health</Link>
      </div>
    </div>
  )
}
