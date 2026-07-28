import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getOpsMetrics, getProviderHealthList } from '@/lib/services/operations/operations-service'

export default async function OperationsPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/admin')

  const [metrics, providers] = await Promise.all([getOpsMetrics(), getProviderHealthList()])

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Operations & Observability</h1>
          <p className="text-sm text-gray-500 mt-1">Real-time platform metrics and provider health</p>
        </div>
        <span className="text-xs text-gray-400">Refreshed: {new Date().toLocaleTimeString()}</span>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mb-8">
        <KpiCard label="Providers Online" value={`${metrics.providers.online}/${metrics.providers.total}`} color="emerald" />
        <KpiCard label="Health %" value={`${metrics.providers.healthPct}%`} color={metrics.providers.healthPct >= 80 ? 'emerald' : 'amber'} />
        <KpiCard label="Running Jobs" value={metrics.jobs.running} color="cyan" />
        <KpiCard label="Failed Jobs" value={metrics.jobs.failed} color={metrics.jobs.failed > 0 ? 'red' : 'gray'} />
        <KpiCard label="Orders Today" value={metrics.orders.today} color="blue" />
        <KpiCard label="Success Rate" value={`${metrics.orders.successRate}%`} color={metrics.orders.successRate >= 90 ? 'emerald' : 'amber'} />
        <KpiCard label="Avg Latency" value={metrics.latency.avgActivationMs ? `${metrics.latency.avgActivationMs}ms` : '—'} color="purple" />
        <KpiCard label="Failovers" value={metrics.failover.total} color="orange" />
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-6">
        <QuickLink href="/admin/providers" label="Providers" />
        <QuickLink href="/admin/provider-catalog" label="Catalog" />
        <QuickLink href="/admin/package-rules" label="Package Rules" />
        <QuickLink href="/admin/orders" label="Orders" />
        <QuickLink href="/admin/package-rules/apply" label="Apply Rules" />
        <QuickLink href="/admin/package-rules/history" label="Rule History" />
        <QuickLink href="/admin/package-rules/jobs" label="Background Jobs" />
        <QuickLink href="/admin/package-rules/audit" label="Audit Log" />
      </div>

      {/* Provider Health Table */}
      <div className="rounded-lg border bg-white shadow-sm mb-6">
        <div className="px-6 py-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900">Provider Health</h2>
          <p className="text-xs text-gray-500 mt-0.5">Real-time operational status of all providers</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Health</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Balance</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Success Rate</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Avg Latency</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Errors</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {providers.map(p => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link href={`/admin/providers/${p.id}`} className="text-sm font-medium text-cyan-600 hover:underline">{p.name}</Link>
                    <div className="text-xs text-gray-400">{p.code}</div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3">
                    <HealthBar score={p.healthScore} />
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 font-mono">{p.balance || '—'}</td>
                  <td className="px-4 py-3 text-sm">{p.successRate != null ? `${p.successRate}%` : '—'}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{p.avgLatency != null ? `${p.avgLatency}ms` : '—'}</td>
                  <td className="px-4 py-3">
                    {p.errorCount > 0 ? <span className="text-xs text-red-600 font-medium">{p.errorCount}</span> : <span className="text-xs text-green-600">0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function KpiCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-600 bg-emerald-50', cyan: 'text-cyan-600 bg-cyan-50',
    blue: 'text-blue-600 bg-blue-50', purple: 'text-purple-600 bg-purple-50',
    red: 'text-red-600 bg-red-50', amber: 'text-amber-600 bg-amber-50',
    orange: 'text-orange-600 bg-orange-50', gray: 'text-gray-600 bg-gray-50',
  }
  return (
    <div className={`rounded-xl p-4 ${colors[color] || colors.gray}`}>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  )
}

function QuickLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="rounded-lg border bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 hover:text-cyan-600 transition-colors text-center">
      {label}
    </Link>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ACTIVE: 'bg-green-100 text-green-700', DEGRADED: 'bg-amber-100 text-amber-700',
    TESTING: 'bg-blue-100 text-blue-700', INACTIVE: 'bg-gray-100 text-gray-600',
    MAINTENANCE: 'bg-purple-100 text-purple-700', ARCHIVED: 'bg-red-100 text-red-700',
  }
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-600'}`}>{status}</span>
}

function HealthBar({ score }: { score: number }) {
  const color = score >= 80 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs text-gray-500">{score}%</span>
    </div>
  )
}
