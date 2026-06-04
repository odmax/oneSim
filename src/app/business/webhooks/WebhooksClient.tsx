'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const EVENT_TYPES = ['order.completed', 'order.failed', 'esim.provisioned', 'esim.activated', 'esim.expired', 'esim.suspended', 'usage.updated', 'topup.completed', 'topup.failed', 'wallet.low_balance']

interface Webhook { id: string; name: string; url: string; status: string; events: string[]; lastSuccessAt?: string | null; lastFailureAt?: string | null; failureCount?: number; createdAt: string }
interface Delivery { id: string; eventType: string; status: string; attempts: number; responseCode?: number | null; errorMessage?: string | null; createdAt: string; sentAt?: string | null }

export default function WebhooksClient({ webhooks: initial, baseUrl }: { webhooks: Webhook[]; baseUrl: string }) {
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
    const newStatus = wh.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
    await fetch(`${baseUrl}/api/v1/webhooks/${wh.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
    setWebhooks(webhooks.map(w => w.id === wh.id ? { ...w, status: newStatus } : w))
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

  function toggleEvent(ev: string) {
    if (selectedEvents.includes('*')) setSelectedEvents([ev])
    else if (ev === '*') setSelectedEvents(['*'])
    else {
      const next = selectedEvents.includes(ev) ? selectedEvents.filter(e => e !== ev) : [...selectedEvents, ev]
      setSelectedEvents(next.length === 0 ? ['*'] : next)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Webhooks</h2>
          <p className="mt-1 text-sm text-gray-500">Send real-time events to your own systems when eSIMs are provisioned, activated, or updated</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
          {showForm ? 'Cancel' : 'Add Webhook'}
        </button>
      </div>

      {showSecret && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <p className="font-medium text-amber-800">Webhook created! Copy the secret now — it won't be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded bg-amber-100 px-3 py-1.5 font-mono text-sm text-amber-900 break-all">{showSecret}</code>
            <button onClick={() => { navigator.clipboard.writeText(showSecret); alert('Copied!') }} className="shrink-0 rounded bg-amber-200 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-300">Copy</button>
            <button onClick={() => setShowSecret(null)} className="shrink-0 text-xs text-amber-600 hover:underline">Dismiss</button>
          </div>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm space-y-4">
          <div><label className="block text-sm font-medium text-gray-700">Name</label><input value={name} onChange={e => setName(e.target.value)} required placeholder="My Webhook Endpoint" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none" /></div>
          <div><label className="block text-sm font-medium text-gray-700">URL (https only)</label><input value={url} onChange={e => setUrl(e.target.value)} required type="url" placeholder="https://hooks.example.com/onesim" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none" /></div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Events</label>
            <div className="flex flex-wrap gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={selectedEvents.includes('*')} onChange={() => toggleEvent('*')} className="h-4 w-4 rounded border-gray-300 text-emerald-600" /><span className="text-xs font-medium text-gray-700">All Events</span></label>
              {EVENT_TYPES.map(ev => (
                <label key={ev} className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={selectedEvents.includes('*') || selectedEvents.includes(ev)} disabled={selectedEvents.includes('*')} onChange={() => toggleEvent(ev)} className="h-4 w-4 rounded border-gray-300 text-emerald-600" /><span className="text-xs text-gray-600">{ev}</span></label>
              ))}
            </div>
          </div>
          <button type="submit" disabled={creating} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 shadow-sm">{creating ? 'Creating...' : 'Create Webhook'}</button>
        </form>
      )}

      {webhooks.length === 0 && !showForm ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No webhook endpoints configured.</p>
          <button onClick={() => setShowForm(true)} className="mt-4 text-sm font-medium text-emerald-600 hover:underline">Add your first webhook →</button>
        </div>
      ) : webhooks.map(wh => (
        <div key={wh.id} className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-gray-900">{wh.name}</h3>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${wh.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-50 text-gray-500'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${wh.status === 'ACTIVE' ? 'bg-emerald-400' : 'bg-gray-400'}`} />{wh.status}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-gray-500 font-mono break-all">{wh.url}</p>
              <p className="mt-1 text-xs text-gray-400">
                Events: {(wh.events as string[]).includes('*') ? 'All events' : (wh.events as string[]).join(', ')}
                {wh.failureCount != null && wh.failureCount > 0 && <span className="ml-2 text-red-500">{wh.failureCount} failures</span>}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => toggleStatus(wh)} className={`rounded px-2 py-1 text-xs font-medium ${wh.status === 'ACTIVE' ? 'bg-amber-50 text-amber-600 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}>{wh.status === 'ACTIVE' ? 'Disable' : 'Enable'}</button>
              <button onClick={() => loadDeliveries(wh.id)} className="rounded bg-gray-50 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100">{loadingDeliveries === wh.id ? '...' : deliveries[wh.id] ? 'Hide Logs' : 'Logs'}</button>
              <button onClick={() => deleteWebhook(wh)} className="rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-100">Delete</button>
            </div>
          </div>
          {deliveries[wh.id] && (
            <div className="mt-3 border-t pt-3">
              {deliveries[wh.id].length === 0 ? <p className="text-xs text-gray-400">No delivery logs yet.</p> : (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {deliveries[wh.id].map(d => (
                    <div key={d.id} className="flex items-center gap-3 rounded bg-gray-50 px-3 py-2 text-xs">
                      <span className={`rounded px-1.5 py-0.5 font-medium ${d.status === 'SENT' ? 'bg-emerald-100 text-emerald-700' : d.status === 'FAILED' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{d.status}</span>
                      <span className="text-gray-600 font-mono">{d.eventType}</span>
                      <span className="text-gray-400">{d.attempts} att</span>
                      {d.responseCode && <span className="text-gray-500">HTTP {d.responseCode}</span>}
                      <span className="text-gray-400">{new Date(d.createdAt).toLocaleString()}</span>
                      {d.status === 'FAILED' && <button onClick={() => retryDelivery(d.id)} className="text-cyan-600 hover:underline">Retry</button>}
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