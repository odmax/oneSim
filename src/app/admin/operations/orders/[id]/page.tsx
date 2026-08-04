import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getOrderOperationsDetail } from '@/lib/services/operations/order-operations-detail'

function SeverityBadge({ severity }: { severity: string }) {
  const c: Record<string, string> = { INFO: 'bg-gray-100 text-gray-700', WARNING: 'bg-amber-100 text-amber-700', ERROR: 'bg-red-100 text-red-700', CRITICAL: 'bg-red-200 text-red-900 font-semibold' }
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${c[severity] || c.INFO}`}>{severity}</span>
}

function CategoryBadge({ category }: { category: string }) {
  const c: Record<string, string> = {
    ORDER: 'bg-blue-100 text-blue-700', WALLET: 'bg-green-100 text-green-700', PROVIDER: 'bg-purple-100 text-purple-700',
    FULFILLMENT: 'bg-emerald-100 text-emerald-700', RECOVERY: 'bg-orange-100 text-orange-700',
    CALLBACK: 'bg-cyan-100 text-cyan-700', ESIM: 'bg-teal-100 text-teal-700',
    ADMIN: 'bg-gray-100 text-gray-700', INVENTORY: 'bg-violet-100 text-violet-700',
  }
  return <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${c[category] || 'bg-gray-100'}`}>{category}</span>
}

function IntegrityBadge({ result }: { result: string }) {
  const c: Record<string, string> = { PASS: 'bg-emerald-100 text-emerald-700', WARNING: 'bg-amber-100 text-amber-700', FAIL: 'bg-red-100 text-red-700' }
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${c[result] || 'bg-gray-100'}`}>{result}</span>
}

export default async function OperationsOrderDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const detail = await getOrderOperationsDetail(params.id)
  if (!detail) notFound()

  const { header, fulfillment, wallet, providerAttempts, esims, inventory, recovery, timeline, webhooks, callbacks, pricing, integrityChecks } = detail

  return (
    <div className="space-y-5 p-6">
      {/* Header */}
      <div>
        <Link href="/admin/operations/orders" className="text-sm text-cyan-600 hover:underline">&larr; Work Queue</Link>
        <div className="mt-2 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Order {header.orderId.slice(-8)}</h2>
            <p className="mt-1 text-sm text-gray-500">{header.businessName} &middot; {header.packageName} &middot; {new Date(header.createdAt).toLocaleString()}</p>
          </div>
          <div className="flex items-center gap-3">
            <SeverityBadge severity={header.severity} />
            <span className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${
              header.status === 'FULFILLED' ? 'bg-emerald-100 text-emerald-700' : header.status === 'FAILED' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'
            }`}>{header.status}</span>
          </div>
        </div>
        {header.actionRequired && (
          <div className="mt-2 inline-flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-1.5">
            <span className="text-xs font-medium text-red-700">Action: {header.actionType}</span>
            <span className="text-xs text-red-500">&mdash; {header.reason}</span>
          </div>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Current Blocker */}
        <div className="rounded-xl border bg-white p-5">
          <h3 className="text-base font-semibold text-gray-900">Current Blocker</h3>
          <div className="mt-2">
            <p className="text-sm font-medium text-gray-700">{header.title}</p>
            <p className="mt-1 text-xs text-gray-500">{header.reason}</p>
            <p className="mt-1 text-xs text-gray-400">Age: {header.ageMinutes} min</p>
          </div>
        </div>

        {/* Fulfillment Progress */}
        <div className="rounded-xl border bg-white p-5">
          <h3 className="text-base font-semibold text-gray-900">Fulfillment</h3>
          <div className="mt-2 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Progress</span>
              <span className="font-medium">{fulfillment.fulfilledQuantity} / {fulfillment.requestedQuantity}</span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-gray-100">
              <div className={`h-2.5 rounded-full transition-all ${fulfillment.state === 'COMPLETE' ? 'bg-emerald-500' : fulfillment.state === 'INCONSISTENT' ? 'bg-red-500' : 'bg-cyan-500'}`} style={{ width: `${fulfillment.percentage}%` }} />
            </div>
            <div className="flex gap-4 text-xs text-gray-500">
              <span>Failed: {fulfillment.failedQuantity}</span>
              <span>Remaining: {fulfillment.remainingQuantity}</span>
              <span>State: {fulfillment.state}</span>
            </div>
            {fulfillment.alerts.length > 0 && fulfillment.alerts.map((a, i) => <p key={i} className="text-xs text-red-600">{a}</p>)}
          </div>
        </div>

        {/* Wallet */}
        <div className="rounded-xl border bg-white p-5">
          <h3 className="text-base font-semibold text-gray-900">Wallet</h3>
          <div className="mt-2 grid grid-cols-4 gap-2 text-center">
            <div className="rounded-lg bg-blue-50 p-2"><p className="text-xs text-blue-600">Reserved</p><p className="text-sm font-bold">{wallet.reserved.toFixed(2)}</p></div>
            <div className="rounded-lg bg-emerald-50 p-2"><p className="text-xs text-emerald-600">Captured</p><p className="text-sm font-bold">{wallet.captured.toFixed(2)}</p></div>
            <div className="rounded-lg bg-amber-50 p-2"><p className="text-xs text-amber-600">Released</p><p className="text-sm font-bold">{wallet.released.toFixed(2)}</p></div>
            <div className="rounded-lg bg-rose-50 p-2"><p className="text-xs text-rose-600">Refunded</p><p className="text-sm font-bold">{wallet.refunded.toFixed(2)}</p></div>
          </div>
          <p className="mt-2 text-xs"><span className="text-gray-500">State: </span><span className="font-medium">{wallet.state}</span></p>
          {wallet.alerts.length > 0 && wallet.alerts.map((a, i) => <p key={i} className="text-xs text-red-600 mt-1">{a}</p>)}
        </div>

        {/* Recovery */}
        <div className="rounded-xl border bg-white p-5">
          <h3 className="text-base font-semibold text-gray-900">Recovery</h3>
          <div className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">Retry</span><span>{recovery.retryCount}/{recovery.maxRetries}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Reconciliation</span><span>{recovery.reconciliationAttempts} attempts</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Redispatch</span><span className={recovery.redispatchAllowed ? 'text-emerald-600' : 'text-gray-400'}>{recovery.redispatchAllowed ? 'Allowed' : 'Blocked'}</span></div>
            {recovery.nextRetryAt && <div className="flex justify-between"><span className="text-gray-500">Next retry</span><span>{new Date(recovery.nextRetryAt).toLocaleString()}</span></div>}
            <p className="text-xs text-gray-500 mt-1">Recommended: {recovery.recommendedAction}</p>
          </div>
        </div>
      </div>

      {/* Pricing */}
      <div className="rounded-xl border bg-white p-5">
        <h3 className="text-base font-semibold text-gray-900">Pricing</h3>
        <div className="mt-2 grid grid-cols-3 gap-4 text-sm">
          <div><span className="text-gray-500">Unit</span><p className="font-medium">{pricing.unitPrice.toFixed(2)} {pricing.currency}</p></div>
          <div><span className="text-gray-500">Total</span><p className="font-medium">{pricing.total.toFixed(2)} {pricing.currency}</p></div>
          <div><span className="text-gray-500">Source</span><p className="text-xs text-gray-500">{pricing.isLegacy ? 'Legacy direct pricing' : 'Imported quote'}</p></div>
        </div>
      </div>

      {/* eSIM Records */}
      <div className="rounded-xl border bg-white p-5">
        <h3 className="text-base font-semibold text-gray-900">eSIM Records ({esims.length})</h3>
        {esims.length === 0 ? <p className="mt-2 text-xs text-gray-400">No eSIM records.</p> : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50"><tr>
                <th className="px-2 py-1.5 text-left text-gray-500">ICCID</th><th className="px-2 py-1.5 text-left text-gray-500">Status</th>
                <th className="px-2 py-1.5 text-left text-gray-500">Activation</th><th className="px-2 py-1.5 text-left text-gray-500">Usage</th>
                <th className="px-2 py-1.5 text-left text-gray-500">Expires</th><th className="px-2 py-1.5"></th>
              </tr></thead>
              <tbody className="divide-y">
                {esims.map(e => (
                  <tr key={e.id} className="hover:bg-gray-50">
                    <td className="px-2 py-1.5 font-mono">{e.iccidMasked}</td>
                    <td className="px-2 py-1.5">{e.status}</td>
                    <td className="px-2 py-1.5">{e.hasActivation ? 'Yes' : 'No'}</td>
                    <td className="px-2 py-1.5">{e.dataUsedMB != null ? `${e.dataUsedMB}MB` : '-'}</td>
                    <td className="px-2 py-1.5">{e.expiresAt ? new Date(e.expiresAt).toLocaleDateString() : '-'}</td>
                    <td className="px-2 py-1.5"><Link href={`/admin/esims/${e.id}`} className="text-cyan-600 hover:underline">View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Provider Attempts */}
      <div className="rounded-xl border bg-white p-5">
        <h3 className="text-base font-semibold text-gray-900">Provider Attempts ({providerAttempts.length})</h3>
        {providerAttempts.length === 0 ? <p className="mt-2 text-xs text-gray-400">No provider attempts recorded.</p> : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50"><tr>
                <th className="px-2 py-1.5 text-left text-gray-500">#</th><th className="px-2 py-1.5 text-left text-gray-500">Provider</th>
                <th className="px-2 py-1.5 text-left text-gray-500">Source</th><th className="px-2 py-1.5 text-left text-gray-500">Status</th>
                <th className="px-2 py-1.5 text-left text-gray-500">Duration</th><th className="px-2 py-1.5 text-left text-gray-500">Ref</th>
                <th className="px-2 py-1.5 text-left text-gray-500">Error</th>
              </tr></thead>
              <tbody className="divide-y">
                {providerAttempts.map(a => (
                  <tr key={`${a.attemptNumber}-${a.source}`} className="hover:bg-gray-50">
                    <td className="px-2 py-1.5">{a.attemptNumber}</td>
                    <td className="px-2 py-1.5">{a.providerName}</td>
                    <td className="px-2 py-1.5"><CategoryBadge category={a.source || 'PURCHASE'} /></td>
                    <td className="px-2 py-1.5">{a.status}</td>
                    <td className="px-2 py-1.5">{a.durationMs ? `${a.durationMs}ms` : '-'}</td>
                    <td className="px-2 py-1.5 font-mono">{a.providerReferenceSuffix || '-'}</td>
                    <td className="px-2 py-1.5 text-red-500">{a.errorCode || a.errorSummary || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Inventory */}
      {inventory && (
        <div className="rounded-xl border bg-white p-5">
          <h3 className="text-base font-semibold text-gray-900">Inventory Reservation</h3>
          <div className="mt-2 grid grid-cols-4 gap-2 text-sm">
            <div><span className="text-gray-500">Status</span><p className="font-medium">{inventory.status}</p></div>
            <div><span className="text-gray-500">Requested</span><p>{inventory.requestedQuantity}</p></div>
            <div><span className="text-gray-500">Reserved</span><p>{inventory.reservedQuantity}</p></div>
            <div><span className="text-gray-500">Fulfilled</span><p>{inventory.fulfilledQuantity}</p></div>
            <div><span className="text-gray-500">Released</span><p>{inventory.releasedQuantity}</p></div>
            <div><span className="text-gray-500">Expires</span><p>{new Date(inventory.expiresAt).toLocaleString()}</p></div>
            <div><span className="text-gray-500">Provider Evidence</span><p>{inventory.hasProviderEvidence ? 'Yes' : 'No'}</p></div>
          </div>
        </div>
      )}

      {/* Callbacks + Webhooks row */}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-xl border bg-white p-5">
          <h3 className="text-base font-semibold text-gray-900">Callbacks ({callbacks.length})</h3>
          {callbacks.length === 0 ? <p className="mt-2 text-xs text-gray-400">No callback deliveries.</p> : (
            <div className="mt-2 space-y-2">
              {callbacks.map(c => (
                <div key={c.id} className={`rounded-lg border p-2 text-xs ${c.deadLettered ? 'border-red-200 bg-red-50' : 'border-gray-100'}`}>
                  <div className="flex justify-between"><span className="font-medium">{c.eventType}</span><span>{c.status}</span></div>
                  <div className="flex justify-between text-gray-500"><span>{c.hostname}</span><span>Attempts: {c.attemptCount}</span></div>
                  {c.lastStatus && <div className="text-gray-400">HTTP {c.lastStatus}</div>}
                  {c.deadLettered && <div className="text-red-600 font-medium">Dead-lettered</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border bg-white p-5">
          <h3 className="text-base font-semibold text-gray-900">Provider Webhooks ({webhooks.length})</h3>
          {webhooks.length === 0 ? <p className="mt-2 text-xs text-gray-400">No provider webhooks matched.</p> : (
            <div className="mt-2 space-y-2">
              {webhooks.map(w => (
                <div key={w.id} className="rounded-lg border border-gray-100 p-2 text-xs">
                  <div className="flex justify-between"><span>{w.providerType} &middot; {w.eventType}</span><span className={w.status === 'FAILED' ? 'text-red-600' : 'text-gray-500'}>{w.status}</span></div>
                  <div className="text-gray-400">{new Date(w.receivedAt).toLocaleString()}</div>
                  {w.errorMsg && <div className="text-red-500">{w.errorMsg}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Integrity Checks */}
      <div className="rounded-xl border bg-white p-5">
        <h3 className="text-base font-semibold text-gray-900">Data Integrity</h3>
        <div className="mt-2 space-y-1">
          {integrityChecks.map(check => (
            <div key={check.name} className="flex items-center justify-between text-xs">
              <span className="text-gray-600">{check.name}</span>
              <span>{check.message}</span>
              <IntegrityBadge result={check.result} />
            </div>
          ))}
        </div>
      </div>

      {/* Timeline */}
      <div className="rounded-xl border bg-white p-5">
        <h3 className="text-base font-semibold text-gray-900">Timeline ({timeline.length})</h3>
        <div className="mt-2 max-h-96 overflow-y-auto space-y-1">
          {timeline.map((e, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <CategoryBadge category={e.category} />
              <span className="text-gray-700">{e.message}</span>
              <span className="text-gray-400 ml-auto shrink-0">{new Date(e.createdAt).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Link to existing detail */}
      <div className="text-right">
        <Link href={`/admin/orders/${header.orderId}`} className="text-xs text-cyan-600 hover:underline">Open standard order detail page</Link>
      </div>
    </div>
  )
}
