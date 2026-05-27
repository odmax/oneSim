'use client'

import { useState } from 'react'
import { createApiKey, revokeApiKey } from '@/lib/actions/api-keys'

interface ApiKeyItem {
  id: string
  name: string
  keyPrefix: string
  status: string
  lastUsedAt: string | null
  createdAt: string
}

export default function ApiKeysClient({ keys: initialKeys, isAdmin }: { keys: ApiKeyItem[]; isAdmin: boolean }) {
  const [keys, setKeys] = useState(initialKeys)
  const [newKeyName, setNewKeyName] = useState('')
  const [createdKey, setCreatedKey] = useState<{ raw: string; prefix: string; name: string } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

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
    }
    setLoading(false)
  }

  async function handleRevoke(keyId: string) {
    if (!confirm('Revoke this API key? Existing integrations will stop working.')) return

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
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-800">{error}</div>
      )}

      {createdKey && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
          <p className="text-sm font-medium text-yellow-900">API Key Created - Copy it now!</p>
          <p className="mt-1 text-xs text-yellow-700">You will not be able to see this key again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded bg-yellow-100 px-3 py-1.5 text-sm font-mono break-all">
              {createdKey.raw}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(createdKey.raw)}
              className="shrink-0 rounded bg-yellow-200 px-2 py-1 text-xs font-medium text-yellow-900 hover:bg-yellow-300"
            >
              Copy
            </button>
          </div>
          <button
            onClick={() => setCreatedKey(null)}
            className="mt-2 text-xs text-yellow-700 hover:text-yellow-900"
          >
            Dismiss
          </button>
        </div>
      )}

      {isAdmin && (
        <div className="rounded-lg border bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Create New API Key</h3>
          <form action={handleCreate} className="flex gap-3">
            <input
              type="text"
              name="name"
              value={newKeyName}
              onChange={e => setNewKeyName(e.target.value)}
              placeholder="e.g. Production Integration"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
              required
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Key'}
            </button>
          </form>
        </div>
      )}

      <div className="rounded-lg border bg-white">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Key Prefix</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Last Used</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Created</th>
              {isAdmin && <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {keys.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-sm text-gray-500">
                  No API keys yet. {isAdmin ? 'Create one above.' : 'Ask your Business Admin to create one.'}
                </td>
              </tr>
            ) : keys.map((key) => (
              <tr key={key.id} className="hover:bg-gray-50">
                <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900">{key.name}</td>
                <td className="whitespace-nowrap px-6 py-4 text-sm font-mono text-gray-600">{key.keyPrefix}...</td>
                <td className="whitespace-nowrap px-6 py-4">
                  <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                    key.status === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}>
                    {key.status}
                  </span>
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                  {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                  {new Date(key.createdAt).toLocaleDateString()}
                </td>
                {isAdmin && (
                  <td className="whitespace-nowrap px-6 py-4 text-sm">
                    {key.status === 'ACTIVE' && (
                      <button
                        onClick={() => handleRevoke(key.id)}
                        className="text-red-600 hover:text-red-900 text-xs font-medium"
                      >
                        Revoke
                      </button>
                    )}
                    {key.status === 'REVOKED' && (
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
  )
}
