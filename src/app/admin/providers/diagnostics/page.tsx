import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { getProviderDiagnosticsOverview, type SeverityLevel } from '@/lib/services/operations/provider-diagnostics'

const SEVERITY_COLORS: Record<SeverityLevel, string> = {
  HEALTHY: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  DEGRADED: 'bg-amber-100 text-amber-800 border-amber-200',
  UNHEALTHY: 'bg-red-100 text-red-800 border-red-200',
  OFFLINE: 'bg-gray-100 text-gray-500 border-gray-200',
  UNKNOWN: 'bg-gray-100 text-gray-500 border-gray-200',
}

const CIRCUIT_COLORS: Record<string, string> = {
  CLOSED: 'bg-emerald-100 text-emerald-700',
  HALF_OPEN: 'bg-amber-100 text-amber-700',
  OPEN: 'bg-red-100 text-red-700',
}

export default async function ProviderDiagnosticsPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const providers = await getProviderDiagnosticsOverview()

  const healthyCount = providers.filter(p => p.severity === 'HEALTHY').length
  const degradedCount = providers.filter(p => p.severity === 'DEGRADED').length
  const unhealthyCount = providers.filter(p => p.severity === 'OFFLINE' || p.severity === 'UNHEALTHY').length
  const alertProviders = providers.filter(p => p.alertCount > 0).length

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Provider Diagnostics</h2>
        <p className="mt-1 text-sm text-gray-500">Operational state and health of all configured providers</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryBox label="Healthy" count={healthyCount} color="text-emerald-600" />
        <SummaryBox label="Degraded" count={degradedCount} color="text-amber-600" />
        <SummaryBox label="Offline" count={unhealthyCount} color="text-red-600" />
        <SummaryBox label="Active Alerts" count={alertProviders} color="text-orange-600" />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {providers.map(p => (
          <Link key={p.id} href={`/admin/providers/diagnostics/${p.id}`}
            className="rounded-xl border bg-white p-5 shadow-sm hover:shadow-md transition-shadow block">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-gray-900">{p.name}</h3>
                <p className="text-xs text-gray-400">{p.code} · {p.adapterStrategy || p.type}</p>
              </div>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${SEVERITY_COLORS[p.severity]}`}>
                {p.severity}
              </span>
            </div>

            <div className="space-y-1.5 text-xs">
              <Row label="Status" value={p.status} />
              <Row label="Purchase" value={p.hasPurchaseCapability ? 'Yes' : 'No'} />
              <Row label="Auth" value={p.authConfigured ? 'Configured' : 'Missing'} />
              {p.circuitState !== 'CLOSED' && (
                <Row label="Circuit" value={p.circuitState} />
              )}
              <Row label="Balance" value={p.balanceStatus || 'Unknown'} />
              <Row label="Packages" value={`${p.purchaseReadyCount}/${p.catalogPackageCount} ready`} />
              <Row label="Last Sync" value={p.lastSyncAt ? new Date(p.lastSyncAt).toLocaleDateString() : 'Never'} />
            </div>

            {p.alertCount > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <span className="text-[10px] font-medium text-orange-600">{p.alertCount} alert{p.alertCount > 1 ? 's' : ''}</span>
              </div>
            )}
          </Link>
        ))}
      </div>

      {providers.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-16 text-center">
          <p className="text-gray-500">No providers configured.</p>
        </div>
      )}
    </div>
  )
}

function SummaryBox({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{count}</p>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-400">{label}</span>
      <span className="font-medium text-gray-700 truncate ml-2 max-w-[140px]">{value}</span>
    </div>
  )
}
