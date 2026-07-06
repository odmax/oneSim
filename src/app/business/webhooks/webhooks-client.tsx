'use client'

import { useState } from 'react'
import {
  createWebhook,
  updateWebhook,
  toggleWebhook,
  deleteWebhook,
  sendTestWebhook,
} from '@/lib/actions/webhooks'

const ALL_EVENTS = [
  { id: 'order.created', label: 'Order Created', desc: 'When a new eSIM order is placed' },
  { id: 'esim.activation.pending', label: 'Activation Pending', desc: 'When eSIM activation is submitted to carrier network' },
  { id: 'esim.activation.completed', label: 'Activation Completed', desc: 'When eSIM is successfully activated' },
  { id: 'esim.activation.failed', label: 'Activation Failed', desc: 'When eSIM activation fails' },
  { id: 'esim.usage.updated', label: 'Usage Updated', desc: 'When data usage records are synced' },
  { id: 'order.failed', label: 'Order Failed', desc: 'When an order fails permanently' },
  { id: 'webhook.test', label: 'Webhook Test', desc: 'Test event sent via "Send Test" button' },
]

function maskSecret(secret: string): string {
  if (secret.length <= 10) return secret.slice(0, 4) + '...'
  return secret.slice(0, 8) + '...' + secret.slice(-4)
}

export function WebhooksClient({
  endpoints,
  deliveries,
  isAdmin,
}: {
  endpoints: any[]
  deliveries: any[]
  isAdmin: boolean
}) {
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  return (
    <div className="space-y-6">
      {/* Endpoints List */}
      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Webhook Endpoints</h3>
            <p className="text-sm text-gray-600">
              {endpoints.length} endpoint{endpoints.length !== 1 ? 's' : ''} configured
            </p>
          </div>
          {isAdmin && (
            <button
              onClick={() => { setShowForm(true); setEditingId(null) }}
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
            >
              Add Endpoint
            </button>
          )}
        </div>

        {endpoints.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center">
            <p className="text-sm font-medium text-gray-900">No webhook endpoints configured</p>
            <p className="mt-1 text-sm text-gray-500">
              Add one to receive real-time order, activation, and usage updates via HTTP callbacks.
            </p>
            <p className="mt-1 text-xs text-gray-400">
              {isAdmin ? 'Click "Add Endpoint" above to get started.' : 'Contact an admin to set up webhooks.'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {endpoints.map((ep) => (
              <div key={ep.id} className="rounded-lg border p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <h4 className="font-medium text-gray-900">{ep.name}</h4>
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          ep.status === 'ACTIVE'
                            ? 'bg-green-100 text-green-800'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {ep.status}
                      </span>
                    </div>
                    <p className="mt-1 text-sm font-mono text-gray-500 break-all">{ep.url}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(typeof ep.events === 'string' ? JSON.parse(ep.events) : ep.events).map(
                        (evt: string) => (
                          <span
                            key={evt}
                            className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700"
                          >
                            {evt}
                          </span>
                        ),
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-xs text-gray-400">
                      <span>Secret: {maskSecret(ep.secret)}</span>
                      <span>·</span>
                      <span>{ep._count?.deliveries || 0} deliveries</span>
                      {ep.lastDelivery && (
                        <>
                          <span>·</span>
                          <span className={ep.lastDelivery.status === 'SENT' ? 'text-green-600' : 'text-red-600'}>
                            Last: {ep.lastDelivery.status === 'SENT' ? 'OK' : 'FAIL'} ({ep.lastDelivery.responseCode || '—'})
                          </span>
                          <span>·</span>
                          <span>{new Date(ep.lastDelivery.createdAt).toLocaleString()}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {isAdmin && (
                    <div className="ml-4 flex gap-2">
                      <form action={toggleWebhook.bind(null, ep.id)}>
                        <button
                          type="submit"
                          className={`rounded px-3 py-1 text-xs font-medium ${
                            ep.status === 'ACTIVE'
                              ? 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100'
                              : 'bg-green-50 text-green-700 hover:bg-green-100'
                          }`}
                        >
                          {ep.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                        </button>
                      </form>
                      <form action={sendTestWebhook.bind(null, ep.id)}>
                        <button
                          type="submit"
                          className="rounded bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-700 hover:bg-cyan-100"
                        >
                          Send Test
                        </button>
                      </form>
                      <button
                        onClick={() => { setEditingId(ep.id); setShowForm(true) }}
                        className="rounded bg-gray-50 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
                      >
                        Edit
                      </button>
                      <form action={deleteWebhook.bind(null, ep.id)}>
                        <button
                          type="submit"
                          className="rounded bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                          onClick={(e) => { if (!confirm('Delete this webhook endpoint?')) e.preventDefault() }}
                        >
                          Delete
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create / Edit Form */}
      {showForm && isAdmin && (
        <WebhookForm
          endpoint={editingId ? endpoints.find((e) => e.id === editingId) || null : null}
          onClose={() => { setShowForm(false); setEditingId(null) }}
        />
      )}

      {/* Recent Deliveries */}
      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Recent Deliveries</h3>

        {deliveries.length === 0 ? (
          <p className="text-sm text-gray-500">No webhook deliveries yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="px-3 py-2 text-left font-medium text-gray-600">Event</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">Endpoint</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">Code</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">Attempts</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {deliveries.map((d) => (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{d.eventType}</td>
                    <td className="max-w-[180px] truncate px-3 py-2 text-gray-600" title={d.endpoint?.url || ''}>
                      {d.endpoint?.name || 'Unknown'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          d.status === 'SENT'
                            ? 'bg-green-100 text-green-800'
                            : d.status === 'FAILED'
                              ? 'bg-red-100 text-red-800'
                              : 'bg-yellow-100 text-yellow-800'
                        }`}
                      >
                        {d.status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                      {d.responseCode || '-'}
                      {d.responseBody && (
                        <span className="ml-1 cursor-help text-xs text-gray-400" title={d.responseBody}>*</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-600">{d.attempts}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                      {new Date(d.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function WebhookForm({
  endpoint,
  onClose,
}: {
  endpoint: any | null
  onClose: () => void
}) {
  const allEvents = ALL_EVENTS
  const isEdit = !!endpoint

  return (
    <div className="rounded-lg border bg-white p-6 shadow-sm">
      <h3 className="mb-4 text-lg font-semibold text-gray-900">
        {isEdit ? 'Edit Webhook Endpoint' : 'Create Webhook Endpoint'}
      </h3>

      <form action={isEdit ? updateWebhook.bind(null, endpoint.id) : createWebhook} className="space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">Name</label>
          <input
            id="name"
            name="name"
            type="text"
            defaultValue={endpoint?.name || ''}
            required
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            placeholder="Production Server"
          />
        </div>

        <div>
          <label htmlFor="url" className="block text-sm font-medium text-gray-700">Endpoint URL</label>
          <input
            id="url"
            name="url"
            type="url"
            defaultValue={endpoint?.url || ''}
            required
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            placeholder="https://api.yoursite.com/webhooks/onesim"
          />
          <p className="mt-1 text-xs text-gray-500">Must use HTTPS. OneSIM will POST JSON payloads to this URL.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Events</label>
          <div className="space-y-2">
            {allEvents.map((event) => {
              const checked =
                endpoint &&
                (typeof endpoint.events === 'string'
                  ? JSON.parse(endpoint.events)
                  : endpoint.events
                ).includes(event.id)
              return (
                <label key={event.id} className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    name={event.id}
                    defaultChecked={!!checked}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-cyan-600"
                  />
                  <div>
                    <p className="text-sm font-medium text-gray-900">{event.label}</p>
                    <p className="text-xs text-gray-500">{event.desc}</p>
                  </div>
                </label>
              )
            })}
          </div>
        </div>

        {isEdit && (
          <label className="flex items-center gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-3 cursor-pointer">
            <input
              type="checkbox"
              name="regenerate_secret"
              className="h-4 w-4 rounded border-gray-300 text-cyan-600"
              onClick={(e) => {
                if (!(e.target as HTMLInputElement).checked) return
                if (!window.confirm('Regenerating the secret will break your existing webhook connection. You must update your server with the new secret. Continue?')) {
                  e.preventDefault()
                }
              }}
            />
            <div>
              <span className="text-sm font-medium text-yellow-800">Regenerate secret</span>
              <p className="text-xs text-yellow-700">Replaces the signing secret — existing integrations will stop until updated</p>
            </div>
          </label>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
          >
            {isEdit ? 'Update' : 'Create'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
