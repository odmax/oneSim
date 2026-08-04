import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getProviderOperationalHealth } from '@/lib/services/operations/provider-operational-health'

function HealthBadge({ health }: { health: string }) {
  const c: Record<string, string> = { HEALTHY: 'bg-emerald-100 text-emerald-700', DEGRADED: 'bg-amber-100 text-amber-700', UNHEALTHY: 'bg-red-100 text-red-700', OFFLINE: 'bg-gray-200 text-gray-600', UNKNOWN: 'bg-gray-100 text-gray-500' }
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${c[health] || c.UNKNOWN}`}>{health}</span>
}

export default async function ProviderOpsOverviewPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const providers = await prisma.provider.findMany({
    where: { status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, code: true, status: true },
    orderBy: { priority: 'asc' },
  })

  const healthData = await Promise.all(providers.map(async p => {
    const h = await getProviderOperationalHealth(p.id)
    return { id: p.id, name: p.name, code: p.code, health: h }
  }))

  // Sort: critical/unhealthy first, then degraded, then healthy
  const sorted = healthData.sort((a, b) => {
    const order: Record<string, number> = { CRITICAL: 0, ERROR: 0, WARNING: 1, INFO: 2 }
    return (order[(a.health?.severity as string) || 'INFO'] ?? 3) - (order[(b.health?.severity as string) || 'INFO'] ?? 3)
  })

  return (
    <div className="space-y-4 p-6">
      <div>
        <Link href="/admin/operations" className="text-sm text-cyan-600 hover:underline">&larr; Operations</Link>
        <h2 className="mt-1 text-2xl font-bold text-gray-900">Provider Health</h2>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">
          No providers configured.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map(p => (
            <Link key={p.id} href={`/admin/operations/providers/${p.id}`} className="rounded-xl border bg-white p-4 shadow-sm hover:shadow-md transition-shadow block">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{p.name}</p>
                  <p className="text-xs text-gray-500">{p.code}</p>
                </div>
                <HealthBadge health={p.health?.overallHealth || 'UNKNOWN'} />
              </div>
              <div className="mt-3 space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-500">Circuit</span>
                  <span className={p.health?.circuit.state === 'OPEN' ? 'text-red-600 font-medium' : 'text-gray-700'}>
                    {p.health?.circuit.state || 'CLOSED'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Routing</span>
                  <span className={p.health?.routingEligible ? 'text-emerald-600' : 'text-red-500'}>
                    {p.health?.routingEligible ? 'Eligible' : 'Blocked'}
                  </span>
                </div>
                {p.health?.purchases.successRate != null && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Success</span>
                    <span>{p.health.purchases.successRate}%</span>
                  </div>
                )}
                {p.health?.purchases.lastSuccess && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Last purchase</span>
                    <span>{new Date(p.health.purchases.lastSuccess).toLocaleString()}</span>
                  </div>
                )}
              </div>
              {p.health?.alerts && p.health.alerts.length > 0 && (
                <div className="mt-2 rounded bg-red-50 px-2 py-1 text-[10px] text-red-600">
                  {p.health.alerts[0]}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
