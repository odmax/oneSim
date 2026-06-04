'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function AdminWebhookMonitor({ endpoints, metrics }: { endpoints: any[]; metrics: any }) {
  const router = useRouter()
  const [deliveries, setDeliveries] = useState<{[key: string]: any[]}>({})
  const [loadingDel, setLoadingDel] = useState<string | null>(null)

  async function loadDeliveries(epId: string) {
    if (deliveries[epId]) { setDeliveries({...deliveries, [epId]: []}); return }
    setLoadingDel(epId)
    const res = await fetch(`/api/v1/webhooks/${epId}/deliveries`)
    const data = await res.json()
    if (data.success) setDeliveries({...deliveries, [epId]: data.deliveries})
    setLoadingDel(null)
  }

  async function toggleStatus(epId: string, current: string) {
    const ns = current === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
    await fetch(`/api/v1/webhooks/${epId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: ns }) })
    router.refresh()
  }

  async function retryDelivery(delId: string) {
    await fetch(`/api/v1/webhooks/deliveries/${delId}/retry`, { method: 'POST' })
    router.refresh()
  }

  const Card = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Webhook Monitoring</h2>
        <p className="text-sm text-gray-600">Cross-business webhook health overview</p>
      </div>

      <div className="grid gap-4 grid-cols-2 sm:grid-cols-4 lg:grid-cols-6">
        <Card label="Endpoints" value={metrics.totalEndpoints} sub={`${metrics.activeEndpoints} active`} />
        <Card label="Today's Deliveries" value={metrics.todayDeliveries} sub={metrics.successRate != null ? `${metrics.successRate}% success` : 'No data'} />
        <Card label="Failed Today" value={metrics.todayFailed} />
        <Card label="Pending Retries" value={metrics.pendingRetries} />
        <Card label="Businesses w/ Failures" value={metrics.businessesWithFailures} />
        <Card label="Total All Time" value={metrics.totalDeliveries} />
      </div>

      {/* Top Failing */}
      {metrics.topFailing?.length > 0 && (
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <h3 className="text-base font-semibold text-gray-900 mb-3">Top Failing Endpoints</h3>
          <div className="space-y-2">
            {metrics.topFailing.map((ep: any) => (
              <div key={ep.id} className="flex items-center justify-between rounded bg-red-50 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate">{ep.businessName} — {ep.name}</p>
                  <p className="text-xs text-gray-500 font-mono truncate">{ep.url}</p>
                </div>
                <div className="text-right shrink-0 ml-3">
                  <p className="text-sm font-bold text-red-600">{ep.failureCount} failures</p>
                  <p className="text-xs text-gray-400">{ep.events?.includes('*') ? 'All events' : (ep.events || []).join(',')}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All Endpoints Table */}
      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Business</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Endpoint</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">URL</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Events</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Failures</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Last OK</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Last Fail</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Deliveries</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {endpoints.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-gray-400">No webhook endpoints found across any business.</td></tr>
            ) : endpoints.map(ep => (
              <tr key={ep.id} className="hover:bg-gray-50">
                <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">{ep.business.name}</td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">{ep.name}</td>
                <td className="max-w-[200px] truncate px-4 py-3 text-xs font-mono text-gray-500" title={ep.url}>{ep.url}</td>
                <td className="whitespace-nowrap px-4 py-3">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${ep.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-50 text-gray-500'}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${ep.status === 'ACTIVE' ? 'bg-emerald-400' : 'bg-gray-400'}`} />{ep.status}
                  </span>
                </td>
                <td className="max-w-[120px] truncate px-4 py-3 text-xs text-gray-500" title={(ep.events || []).join(', ')}>{(ep.events || []).includes('*') ? 'All' : (ep.events || []).length + ' events'}</td>
                <td className="whitespace-nowrap px-4 py-3 text-sm"><span className={ep.failureCount > 0 ? 'text-red-600 font-medium' : 'text-gray-500'}>{ep.failureCount}</span></td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-500">{ep.lastSuccessAt ? new Date(ep.lastSuccessAt).toLocaleDateString() : '—'}</td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-red-500">{ep.lastFailureAt ? new Date(ep.lastFailureAt).toLocaleDateString() : '—'}</td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">{ep.deliveryCount}</td>
                <td className="whitespace-nowrap px-4 py-3 text-xs">
                  <div className="flex gap-1.5">
                    <button onClick={() => toggleStatus(ep.id, ep.status)} className={`px-2 py-1 rounded text-xs font-medium ${ep.status === 'ACTIVE' ? 'bg-amber-50 text-amber-600 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}>{ep.status === 'ACTIVE' ? 'Disable' : 'Enable'}</button>
                    <button onClick={() => loadDeliveries(ep.id)} className="px-2 py-1 rounded bg-gray-50 text-xs text-gray-600 hover:bg-gray-100">{loadingDel === ep.id ? '...' : deliveries[ep.id] ? 'Hide' : 'Logs'}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Delivery Logs Modal */}
      {Object.entries(deliveries).filter(([_, d]) => d.length > 0).map(([epId, epDeliveries]) => (
        <div key={epId} className="rounded-lg border bg-white p-4 shadow-sm">
          <h4 className="text-sm font-semibold text-gray-700 mb-2">Deliveries for {endpoints.find(e => e.id === epId)?.name || epId}</h4>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {epDeliveries.map((d: any) => (
              <div key={d.id} className="flex items-center gap-2 rounded bg-gray-50 px-3 py-2 text-xs flex-wrap">
                <span className={`rounded px-1.5 py-0.5 font-medium ${d.status === 'SENT' ? 'bg-emerald-100 text-emerald-700' : d.status === 'FAILED' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{d.status}</span>
                <span className="text-gray-600 font-mono">{d.eventType}</span>
                <span className="text-gray-400">{d.attempts} att</span>
                {d.responseCode && <span className="text-gray-500">HTTP {d.responseCode}</span>}
                <span className="text-gray-400">{new Date(d.createdAt).toLocaleString()}</span>
                {d.status === 'FAILED' && <button onClick={() => retryDelivery(d.id)} className="text-cyan-600 hover:underline">Retry</button>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}