'use client'

import { useState, useEffect } from 'react'
import { getProviderRoamingProfiles } from '@/lib/services/providers/provider-roaming'
import type { ProviderRoamingProfile } from '@/lib/services/providers/provider-roaming'

export function ProviderRoamingProfilesCard({ providerId }: { providerId: string }) {
  const [profiles, setProfiles] = useState<ProviderRoamingProfile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [source, setSource] = useState<'LIVE' | 'CACHE' | 'UNSUPPORTED'>('UNSUPPORTED')
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)

  async function fetchProfiles(force = false) {
    setLoading(true)
    setError('')
    try {
      const result = await (await import('@/lib/services/providers/provider-roaming')).getProviderRoamingProfiles(providerId, { forceRefresh: force })
      if (result.success) {
        setProfiles(result.profiles)
        setSource(result.source)
        setFetchedAt(result.fetchedAt || null)
      } else {
        setError(result.error || 'Failed to fetch')
      }
    } catch (e: any) {
      setError(e.message || 'Error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchProfiles() }, [providerId])

  if (!profiles.length && !loading && !error && source === 'UNSUPPORTED') {
    return (
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900 mb-2">Roaming Profiles</h3>
        <p className="text-sm text-gray-400">Not supported for this provider.</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold text-gray-900">Roaming Profiles</h3>
        <div className="flex items-center gap-2">
          {fetchedAt && (
            <span className="text-xs text-gray-400">
              {source === 'CACHE' ? 'Cached' : 'Live'} {fetchedAt.toLocaleTimeString()}
            </span>
          )}
          <button onClick={() => fetchProfiles(true)} disabled={loading}
            className="text-xs text-cyan-600 hover:underline disabled:opacity-50">
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}

      {loading && !profiles.length ? (
        <p className="text-sm text-gray-400 italic">Fetching profiles…</p>
      ) : profiles.length === 0 ? (
        <p className="text-sm text-gray-500">No roaming profiles available.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Code</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Name</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Default</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {profiles.map(p => (
                <tr key={p.id || p.code} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs text-gray-700">{p.code}</td>
                  <td className="px-3 py-2 text-gray-700">{p.name}</td>
                  <td className="px-3 py-2">
                    {p.isDefault && <span className="inline-flex rounded-full bg-green-100 px-2 text-xs text-green-700">Default</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
