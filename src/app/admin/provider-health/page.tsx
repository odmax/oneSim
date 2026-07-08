import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { checkProviderHealth, checkAllProvidersHealth } from '@/lib/providers/health-check'

export default async function ProviderHealthPage({ searchParams }: { searchParams?: { check?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PROVIDERS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  if (searchParams?.check === 'all') {
    await checkAllProvidersHealth()
    redirect('/admin/provider-health')
  }

  const providers = await prisma.provider.findMany({
    orderBy: { priority: 'asc' },
    include: { _count: { select: { packages: true } } },
  })

  const snapshots = await prisma.providerHealthSnapshot.findMany({
    distinct: ['providerId'],
    orderBy: { createdAt: 'desc' },
  })

  const snapshotMap = new Map(snapshots.map(s => [s.providerId, s]))

  const today = new Date(); today.setHours(0, 0, 0, 0)

  const [ordersToday, failoversToday, recentFailovers] = await Promise.all([
    prisma.eSIMPurchase.count({ where: { createdAt: { gte: today } } }),
    prisma.providerFailoverEvent.count({ where: { createdAt: { gte: today } } }),
    prisma.providerFailoverEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
  ])

  const Card = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h2 className="text-2xl font-bold text-gray-900">Provider Health</h2><p className="text-sm text-gray-600">Monitor provider availability and automatic failover</p></div>
        <a href="/admin/provider-health?check=all" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700">Run Health Check</a>
      </div>

      <div className="grid gap-4 grid-cols-2 sm:grid-cols-4 lg:grid-cols-6">
        <Card label="Healthy" value={providers.filter(p => snapshotMap.get(p.id)?.status === 'HEALTHY' || !snapshotMap.has(p.id)).length} sub={`of ${providers.length} providers`} />
        <Card label="Degraded" value={providers.filter(p => snapshotMap.get(p.id)?.status === 'DEGRADED').length} />
        <Card label="Down" value={providers.filter(p => snapshotMap.get(p.id)?.status === 'DOWN').length} />
        <Card label="Avg Response" value={snapshots.length > 0 ? `${Math.round(snapshots.reduce((a, s) => a + (s.responseTimeMs || 0), 0) / snapshots.length)}ms` : '—'} />
        <Card label="Orders Today" value={ordersToday} />
        <Card label="Failovers Today" value={failoversToday} />
      </div>

      {/* Providers Table */}
      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Provider</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Response</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Success Rate</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Last Check</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Failures</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Last Error</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Packages</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {providers.map(p => {
              const snap = snapshotMap.get(p.id)
              return (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">{p.name}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">{p.type}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      !snap || snap.status === 'HEALTHY' ? 'bg-emerald-50 text-emerald-600' :
                      snap.status === 'DEGRADED' ? 'bg-amber-50 text-amber-600' :
                      'bg-red-50 text-red-600'
                    }`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${!snap || snap.status === 'HEALTHY' ? 'bg-emerald-400' : snap.status === 'DEGRADED' ? 'bg-amber-400' : 'bg-red-400'}`} />
                      {snap?.status || 'HEALTHY'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">{snap?.responseTimeMs ? `${snap.responseTimeMs}ms` : '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">{snap?.successRate != null ? `${Math.round(snap.successRate)}%` : '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-500">{snap?.lastCheckAt ? new Date(snap.lastCheckAt).toLocaleString() : 'Never'}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <span className={snap && snap.consecutiveFailures > 0 ? 'text-red-600 font-medium' : 'text-gray-500'}>{snap?.consecutiveFailures || 0}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-500 max-w-[200px] truncate" title={p.lastError || ''}>{p.lastError || '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">{p._count.packages}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Failover Events */}
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent Failover Events</h3>
        {recentFailovers.length === 0 ? <p className="text-sm text-gray-400">No failover events recorded.</p> : (
          <div className="space-y-2">
            {recentFailovers.map(f => (
              <div key={f.id} className="flex items-center justify-between rounded bg-amber-50 px-4 py-2 text-sm">
                <div className="flex-1">
                  <span className="font-medium text-amber-800">{f.originalProviderId?.slice(-8) || 'Unknown'} → {f.fallbackProviderId?.slice(-8) || 'Failed'}</span>
                  <span className="ml-2 text-amber-600">{f.reason}</span>
                </div>
                <span className="text-xs text-amber-500 ml-3">{new Date(f.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-provider health history */}
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Provider Health History</h3>
        {providers.map(p => <ProviderHistory key={p.id} providerId={p.id} providerName={p.name} />)}
      </div>
    </div>
  )
}

async function ProviderHistory({ providerId, providerName }: { providerId: string; providerName: string }) {
  const history = await prisma.providerHealthSnapshot.findMany({
    where: { providerId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  if (history.length === 0) return null
  return (
    <div className="mb-3">
      <p className="text-xs font-medium text-gray-600 mb-1">{providerName}</p>
      <div className="flex gap-1.5">
        {history.reverse().map((h, i) => (
          <div key={h.id} className={`h-6 w-6 rounded ${h.status === 'HEALTHY' ? 'bg-emerald-400' : h.status === 'DEGRADED' ? 'bg-amber-400' : 'bg-red-400'}`} title={`${h.status} ${h.responseTimeMs}ms ${new Date(h.createdAt).toLocaleString()}`} />
        ))}
      </div>
    </div>
  )
}