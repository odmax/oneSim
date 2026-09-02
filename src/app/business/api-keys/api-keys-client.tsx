'use client'

import { useState } from 'react'
import { createApiKey, revokeApiKey } from '@/lib/actions/api-keys'
import { apiKeyStatusLabel } from '@/lib/status-labels'

interface ApiKeyItem {
  id: string
  name: string
  keyPrefix: string
  status: string
  lastUsedAt: string | null
  createdAt: string
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
      status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
    }`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === 'ACTIVE' ? 'bg-emerald-400' : 'bg-red-400'}`} />
      {apiKeyStatusLabel(status)}
    </span>
  )
}

export default function ApiKeysClient({ keys: initialKeys, isAdmin }: { keys: ApiKeyItem[]; isAdmin: boolean }) {
  const [keys, setKeys] = useState(initialKeys)
  const [newKeyName, setNewKeyName] = useState('')
  const [createdKey, setCreatedKey] = useState<{ raw: string; prefix: string; name: string } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

  async function handleCreate(formData: FormData) {
    setLoading(true)
    setError('')
    setCreatedKey(null)

    const name = formData.get('name') as string
    if (!name?.trim()) {
      setError('Key name is required')
      setLoading(false)
      return
    }

    const result = await createApiKey(name.trim())
    if (result.error) {
      setError(result.error)
    } else if (result.raw) {
      setCreatedKey({ raw: result.raw, prefix: result.prefix!, name: result.name! })
      setNewKeyName('')
      setKeys(prev => [{
        id: 'temp',
        name: result.name!,
        keyPrefix: result.prefix!,
        status: 'ACTIVE',
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
      }, ...prev])
      setShowCreate(false)
    }
    setLoading(false)
  }

  async function handleRevoke(keyId: string) {
    if (!confirm('Revoke this API key? Any services using this key will immediately lose access.')) return

    const result = await revokeApiKey(keyId)
    if (result.error) {
      setError(result.error)
    } else {
      setKeys(prev => prev.map(k => k.id === keyId ? { ...k, status: 'REVOKED' } : k))
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      {/* Raw key disclosure banner */}
      {createdKey && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-200">
              <span className="text-lg text-amber-700">⚠</span>
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-amber-900">API Key Created — Copy It Now</h3>
              <p className="mt-0.5 text-xs text-amber-700">For security, this key will not be shown again. If you lose it, you must create a new one.</p>
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 rounded-lg bg-amber-100 px-3 py-2 text-sm font-mono break-all text-amber-900">
                  {createdKey.raw}
                </code>
                <button
                  onClick={() => navigator.clipboard.writeText(createdKey.raw)}
                  className="shrink-0 rounded-lg bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-700 shadow-sm"
                >
                  Copy
                </button>
              </div>
              <button
                onClick={() => setCreatedKey(null)}
                className="mt-2 text-xs font-medium text-amber-700 hover:text-amber-900"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">API Keys</h2>
          <p className="mt-1 text-sm text-gray-500">Manage external API access for your business</p>
        </div>
        {isAdmin && !showCreate && (
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm"
          >
            Create API Key
          </button>
        )}
      </div>

      {/* Create form */}
      {isAdmin && showCreate && (
        <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">New API Key</h3>
            <button onClick={() => setShowCreate(false)} className="text-sm text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
          <form action={handleCreate} className="flex gap-3">
            <input
              type="text"
              name="name"
              value={newKeyName}
              onChange={e => setNewKeyName(e.target.value)}
              placeholder="e.g. Production Integration"
              className="flex-1 rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              required
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create'}
            </button>
          </form>
        </div>
      )}

      {/* Keys table */}
      {keys.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No API keys yet.</p>
          {isAdmin ? (
            <button onClick={() => setShowCreate(true)} className="mt-3 text-sm font-medium text-emerald-600 hover:text-emerald-700">Create your first API key →</button>
          ) : (
            <p className="mt-1 text-xs text-gray-400">Ask your Business Admin to create one.</p>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Name</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Key</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Last Used</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Created</th>
                  {isAdmin && <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {keys.map((key) => (
                  <tr key={key.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-5 py-4 font-medium text-gray-900">{key.name}</td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-1.5">
                        <code className="text-xs font-mono text-gray-500">{key.keyPrefix}...</code>
                        <button
                          onClick={() => navigator.clipboard.writeText(key.keyPrefix)}
                          className="rounded bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-400 hover:text-gray-600"
                          title="Copy prefix"
                        >
                          Copy
                        </button>
                      </div>
                    </td>
                    <td className="px-5 py-4"><StatusBadge status={key.status} /></td>
                    <td className="px-5 py-4 text-gray-500">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : <span className="text-gray-400">Never</span>}</td>
                    <td className="px-5 py-4 text-gray-500">{new Date(key.createdAt).toLocaleDateString()}</td>
                    {isAdmin && (
                      <td className="px-5 py-4">
                        {key.status === 'ACTIVE' ? (
                          <button
                            onClick={() => handleRevoke(key.id)}
                            className="rounded-md bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100"
                          >
                            Revoke
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400">Revoked</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
