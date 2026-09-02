'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { NotificationContainer, type Notification } from '@/components/ui/DismissibleNotification'

const EVENT_TYPES = ['order.completed', 'order.failed', 'esim.provisioned', 'esim.activated', 'esim.expired', 'esim.suspended', 'usage.updated', 'topup.completed', 'topup.failed', 'wallet.low_balance']

interface Webhook { id: string; name: string; url: string; status: string; events: string[]; lastSuccessAt?: string | null; lastFailureAt?: string | null; failureCount?: number; createdAt: string }
interface Delivery { id: string; eventType: string; status: string; attempts: number; responseCode?: number | null; responseBody?: string | null; errorMessage?: string | null; payload?: any; createdAt: string; sentAt?: string | null }

export default function WebhooksClient({ webhooks: initial, metrics, baseUrl }: {
  webhooks: Webhook[]; metrics: { totalEndpoints: number; activeEndpoints: number; totalDeliveries: number; todayDeliveries: number; todaySuccess: number; todayFailed: number; pendingRetries: number; successRate: number | null; lastSuccessfulDelivery: any; lastFailedDelivery: any }; baseUrl: string
}) {
  const router = useRouter()
  const [webhooks, setWebhooks] = useState(initial)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['*'])
  const [creating, setCreating] = useState(false)
  const [showSecret, setShowSecret] = useState<string | null>(null)
  const [deliveries, setDeliveries] = useState<{[key: string]: Delivery[]}>({})
  const [loadingDeliveries, setLoadingDeliveries] = useState<string | null>(null)
  const [expandedPayload, setExpandedPayload] = useState<string | null>(null)
  const [testingEndpoint, setTestingEndpoint] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{endpointId: string; success: boolean; message: string} | null>(null)
  const [notifications, setNotifications] = useState<Notification[]>([])

  const notify = (type: Notification['type'], message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setNotifications((prev) => [...prev, { id, type, message }])
  }
  const dismiss = (id: string) => setNotifications((prev) => prev.filter((n) => n.id !== id))

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name || !url) return
    setCreating(true)
    try {
      const res = await fetch(`${baseUrl}/api/v1/webhooks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url, events: selectedEvents }),
      })
      const data = await res.json()
      if (data.success) {
        setWebhooks([data.webhook, ...webhooks])
        setShowSecret(data.webhook.secret)
        setShowForm(false); setName(''); setUrl(''); setSelectedEvents(['*'])
      }
    } finally { setCreating(false) }
  }

  async function toggleStatus(wh: Webhook) {
    const ns = wh.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
    await fetch(`${baseUrl}/api/v1/webhooks/${wh.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: ns }) })
    setWebhooks(webhooks.map(w => w.id === wh.id ? { ...w, status: ns } : w))
  }

  async function deleteWebhook(wh: Webhook) {
    if (!confirm('Delete this webhook?')) return
    const res = await fetch(`${baseUrl}/api/v1/webhooks/${wh.id}`, { method: 'DELETE' })
    if (res.ok) setWebhooks(webhooks.filter(w => w.id !== wh.id))
  }

  async function loadDeliveries(whId: string) {
    if (deliveries[whId]) { setDeliveries({...deliveries, [whId]: []}); return }
    setLoadingDeliveries(whId)
    const res = await fetch(`${baseUrl}/api/v1/webhooks/${whId}/deliveries`)
    const data = await res.json()
    if (data.success) setDeliveries({...deliveries, [whId]: data.deliveries})
    setLoadingDeliveries(null)
  }

  async function retryDelivery(deliveryId: string) {
    await fetch(`${baseUrl}/api/v1/webhooks/deliveries/${deliveryId}/retry`, { method: 'POST' })
    router.refresh()
  }

  async function testEndpoint(whId: string) {
    setTestingEndpoint(whId)
    setTestResult(null)
    try {
      const res = await fetch(`${baseUrl}/api/v1/webhooks/${whId}/test`, { method: 'POST' })
      const data = await res.json()
      setTestResult({ endpointId: whId, success: data.success, message: data.message || (data.success ? 'Test sent successfully' : 'Test failed') })
    } catch { setTestResult({ endpointId: whId, success: false, message: 'Test request failed' }) }
    finally { setTestingEndpoint(null) }
  }

  function toggleEvent(ev: string) {
    if (selectedEvents.includes('*')) setSelectedEvents([ev])
    else if (ev === '*') setSelectedEvents(['*'])
    else {
      const next = selectedEvents.includes(ev) ? selectedEvents.filter(e => e !== ev) : [...selectedEvents, ev]
      setSelectedEvents(next.length === 0 ? ['*'] : next)
    }
  }

  function redactPayload(payload: any): any {
    if (!payload || typeof payload !== 'object') return payload
    const redacted = Array.isArray(payload) ? [...payload] : { ...payload }
    for (const key of Object.keys(redacted)) {
      if (['activationCode', 'activation_code', 'apiKey', 'api_key', 'token', 'secret', 'password'].includes(key)) {
        redacted[key] = '••••••'
      } else if (typeof redacted[key] === 'object') {
        redacted[key] = redactPayload(redacted[key])
      }
    }
    return redacted
  }

  const Card = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Webhook Operations</h2>
          <p className="mt-1 text-sm text-gray-500">Monitor endpoint health, retry failures, and test delivery</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
          {showForm ? 'Cancel' : 'Add Endpoint'}
        </button>
      </div>

      <NotificationContainer notifications={notifications} onDismiss={dismiss} />

      {testResult && (
        <div className={`rounded-xl border p-4 text-sm ${testResult.success ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {testResult.message}
          <button onClick={() => setTestResult(null)} className="ml-3 text-xs underline">Dismiss</button>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-4 lg:grid-cols-5">
        <Card label="Endpoints" value={metrics.totalEndpoints} sub={`${metrics.activeEndpoints} active`} />
        <Card label="Deliveries Today" value={metrics.todayDeliveries} sub={metrics.successRate != null ? `${metrics.successRate}% success` : 'No data'} />
        <Card label="Failed Today" value={metrics.todayFailed} sub="requires attention" />
        <Card label="Pending Retries" value={metrics.pendingRetries} />
        <Card label="Total Delivered" value={metrics.totalDeliveries} />
      </div>

      {/* Last Deliveries */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        {metrics.lastSuccessfulDelivery && (
          <div className="rounded-xl border border-emerald-100 bg-emerald-50/30 p-4">
            <p className="text-xs font-medium text-emerald-600 uppercase tracking-wider">Last Successful Delivery</p>
            <p className="mt-1 text-sm text-gray-700">{metrics.lastSuccessfulDelivery.eventType}</p>
            <p className="text-xs text-gray-400">{new Date(metrics.lastSuccessfulDelivery.createdAt).toLocaleString()}</p>
          </div>
        )}
        {metrics.lastFailedDelivery && (
          <div className="rounded-xl border border-red-100 bg-red-50/30 p-4">
            <p className="text-xs font-medium text-red-600 uppercase tracking-wider">Last Failed Delivery</p>
            <p className="mt-1 text-sm text-gray-700">{metrics.lastFailedDelivery.eventType}</p>
            <p className="text-xs text-gray-400">{new Date(metrics.lastFailedDelivery.createdAt).toLocaleString()}</p>
            {metrics.lastFailedDelivery.errorMessage && <p className="text-xs text-red-500 mt-0.5">{metrics.lastFailedDelivery.errorMessage}</p>}
          </div>
        )}
      </div>

      {showSecret && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <p className="font-medium text-amber-800">Secret shown once: <code className="rounded bg-amber-100 px-2 py-0.5 font-mono break-all">{showSecret}</code></p>
          <button onClick={() => { navigator.clipboard.writeText(showSecret); notify('success', 'Secret copied!') }} className="mt-1 text-amber-600 hover:underline text-xs">Copy</button>
          <button onClick={() => setShowSecret(null)} className="ml-2 text-amber-600 hover:underline text-xs">Dismiss</button>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm space-y-4">
          <div><label className="block text-sm font-medium text-gray-700">Name</label><input value={name} onChange={e => setName(e.target.value)} required placeholder="My Webhook" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none" /></div>
          <div><label className="block text-sm font-medium text-gray-700">URL (https)</label><input value={url} onChange={e => setUrl(e.target.value)} required type="url" placeholder="https://hooks.example.com/onesim" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none" /></div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Events</label>
            <div className="flex flex-wrap gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={selectedEvents.includes('*')} onChange={() => toggleEvent('*')} className="h-4 w-4 rounded border-gray-300 text-emerald-600" /><span className="text-xs font-medium text-gray-700">All Events</span></label>
              {EVENT_TYPES.map(ev => (
                <label key={ev} className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={selectedEvents.includes('*') || selectedEvents.includes(ev)} disabled={selectedEvents.includes('*')} onChange={() => toggleEvent(ev)} className="h-4 w-4 rounded border-gray-300 text-emerald-600" /><span className="text-xs text-gray-600">{ev}</span></label>
              ))}
            </div>
          </div>
          <button type="submit" disabled={creating} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 shadow-sm">{creating ? 'Creating...' : 'Create Endpoint'}</button>
        </form>
      )}

      {webhooks.length === 0 && !showForm ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No webhook endpoints configured.</p>
          <button onClick={() => setShowForm(true)} className="mt-4 text-sm font-medium text-emerald-600 hover:underline">Add your first endpoint →</button>
        </div>
      ) : webhooks.map(wh => (
        <div key={wh.id} className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between mb-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-gray-900 truncate">{wh.name}</h3>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${wh.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-50 text-gray-500'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${wh.status === 'ACTIVE' ? 'bg-emerald-400' : 'bg-gray-400'}`} />{wh.status}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-gray-500 font-mono truncate">{wh.url}</p>
              <p className="mt-1 text-xs text-gray-400">
                Events: {(wh.events as string[]).includes('*') ? 'All events' : (wh.events as string[]).join(', ')}
                {wh.failureCount != null && wh.failureCount > 0 && <span className="ml-2 text-red-500">{wh.failureCount} failures</span>}
                {wh.lastSuccessAt && <span className="ml-2 text-emerald-500">Last OK: {new Date(wh.lastSuccessAt).toLocaleDateString()}</span>}
              </p>
            </div>
            <div className="flex gap-2 shrink-0 ml-3">
              <button onClick={() => testEndpoint(wh.id)} disabled={testingEndpoint === wh.id} className="rounded bg-cyan-50 px-2 py-1 text-xs font-medium text-cyan-600 hover:bg-cyan-100 disabled:opacity-50">{testingEndpoint === wh.id ? '...' : 'Test'}</button>
              <button onClick={() => toggleStatus(wh)} className={`rounded px-2 py-1 text-xs font-medium ${wh.status === 'ACTIVE' ? 'bg-amber-50 text-amber-600 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}>{wh.status === 'ACTIVE' ? 'Disable' : 'Enable'}</button>
              <button onClick={() => loadDeliveries(wh.id)} className="rounded bg-gray-50 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100">{loadingDeliveries === wh.id ? '...' : deliveries[wh.id] ? 'Hide' : 'Logs'}</button>
              <button onClick={() => deleteWebhook(wh)} className="rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-100">Delete</button>
            </div>
          </div>

          {/* Delivery Logs */}
          {deliveries[wh.id] && (
            <div className="mt-3 border-t pt-3">
              {deliveries[wh.id].length === 0 ? <p className="text-xs text-gray-400">No deliveries yet.</p> : (
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {deliveries[wh.id].map(d => (
                    <div key={d.id} className="flex items-center gap-2 rounded bg-gray-50 px-3 py-2 text-xs flex-wrap">
                      <span className={`rounded px-1.5 py-0.5 font-medium ${d.status === 'SENT' ? 'bg-emerald-100 text-emerald-700' : d.status === 'FAILED' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{d.status}</span>
                      <span className="text-gray-600 font-mono">{d.eventType}</span>
                      <span className="text-gray-400">{d.attempts} att</span>
                      {d.responseCode && <span className="text-gray-500">HTTP {d.responseCode}</span>}
                      {d.errorMessage && <span className="text-red-500 max-w-[200px] truncate" title={d.errorMessage}>{d.errorMessage}</span>}
                      <span className="text-gray-400">{new Date(d.createdAt).toLocaleString()}</span>
                      <button onClick={() => setExpandedPayload(expandedPayload === d.id ? null : d.id)} className="text-cyan-600 hover:underline">Payload</button>
                      {d.status === 'FAILED' && <button onClick={() => retryDelivery(d.id)} className="text-cyan-600 hover:underline">Retry</button>}
                      {expandedPayload === d.id && (
                        <div className="w-full mt-1 rounded bg-gray-800 p-2 overflow-auto max-h-48">
                          <pre className="text-xs text-green-300">{JSON.stringify(redactPayload(d.payload || {}), null, 2)}</pre>
                          {d.responseBody && <pre className="text-xs text-yellow-300 mt-1 border-t border-gray-600 pt-1">Response: {d.responseBody}</pre>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}