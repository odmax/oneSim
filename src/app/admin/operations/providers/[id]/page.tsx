import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getProviderOperationalHealth } from '@/lib/services/operations/provider-operational-health'

export default async function ProviderOpsDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const health = await getProviderOperationalHealth(params.id)
  if (!health) notFound()

  const { provider, circuit, authentication, purchases, catalog, wallet, inventory, webhooks, alerts, severity, actionRequired, overallHealth, routingEligible, routingBlockedReason } = health

  return (
    <div className="space-y-5 p-6">
      <div>
        <Link href="/admin/operations/providers" className="text-sm text-cyan-600 hover:underline">&larr; All Providers</Link>
        <div className="mt-2 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">{provider.name}</h2>
            <p className="text-sm text-gray-500">{provider.code} &middot; {provider.environment} &middot; {provider.status}</p>
          </div>
          <span className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${
            overallHealth === 'HEALTHY' ? 'bg-emerald-100 text-emerald-700' : overallHealth === 'DEGRADED' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
          }`}>{overallHealth}</span>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider">Circuit</p>
          <p className={`mt-1 text-lg font-bold ${circuit.state === 'OPEN' ? 'text-red-600' : 'text-emerald-600'}`}>{circuit.state}</p>
          <p className="text-xs text-gray-400">{circuit.failureCount} recent failures</p>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider">Routing</p>
          <p className={`mt-1 text-lg font-bold ${routingEligible ? 'text-emerald-600' : 'text-red-600'}`}>{routingEligible ? 'Eligible' : 'Blocked'}</p>
          {routingBlockedReason && <p className="text-xs text-gray-400">{routingBlockedReason}</p>}
        </div>
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider">Auth</p>
          <p className="mt-1 text-lg font-bold">{authentication.state}</p>
          <p className="text-xs text-gray-400">{authentication.configured ? 'Configured' : 'Not Configured'}</p>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider">Catalog</p>
          <p className="mt-1 text-lg font-bold">{catalog.totalPackages}</p>
          <p className="text-xs text-gray-400">{catalog.state}</p>
        </div>
      </div>

      {purchases.total > 0 && (
        <div className="rounded-xl border bg-white p-5">
          <h3 className="text-base font-semibold text-gray-900">Purchase Performance (1h)</h3>
          <div className="mt-2 grid grid-cols-6 gap-2 text-center text-xs">
            <div className="rounded-lg bg-gray-50 p-2"><span className="text-gray-500">Total</span><p className="font-bold">{purchases.total}</p></div>
            <div className="rounded-lg bg-emerald-50 p-2"><span className="text-emerald-600">Succeeded</span><p className="font-bold">{purchases.succeeded}</p></div>
            <div className="rounded-lg bg-red-50 p-2"><span className="text-red-600">Failed</span><p className="font-bold">{purchases.failed}</p></div>
            <div className="rounded-lg bg-purple-50 p-2"><span className="text-purple-600">Uncertain</span><p className="font-bold">{purchases.uncertain}</p></div>
            <div className="rounded-lg bg-amber-50 p-2"><span className="text-amber-600">Pending</span><p className="font-bold">{purchases.pending}</p></div>
            <div className="rounded-lg bg-cyan-50 p-2"><span className="text-cyan-600">Success Rate</span><p className="font-bold">{purchases.successRate != null ? `${purchases.successRate}%` : '?'}</p></div>
          </div>
          {purchases.lastSuccess && <p className="mt-2 text-xs text-gray-400">Last success: {new Date(purchases.lastSuccess).toLocaleString()}</p>}
        </div>
      )}

      {wallet && (
        <div className="rounded-xl border bg-white p-5">
          <h3 className="text-base font-semibold text-gray-900">Wallet</h3>
          <div className="mt-2">
            {wallet.balance != null ? (
              <p className="text-sm">{wallet.balance.toFixed(2)} {wallet.currency}</p>
            ) : <p className="text-sm text-gray-400">{wallet.state}</p>}
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-white p-5">
        <h3 className="text-base font-semibold text-gray-900">Webhooks (24h)</h3>
        <p className="text-sm">{webhooks.received24h} received</p>
      </div>

      {alerts.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5">
          <h3 className="text-base font-semibold text-red-700">Alerts</h3>
          <ul className="mt-2 list-disc list-inside text-sm text-red-600 space-y-1">
            {alerts.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </div>
      )}

      <div className="text-right">
        <Link href={`/admin/providers/${provider.id}`} className="text-xs text-cyan-600 hover:underline">Open standard provider detail &rarr;</Link>
      </div>
    </div>
  )
}
