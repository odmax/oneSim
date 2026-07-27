'use client'

import { useState } from 'react'
import { ProviderRoutingEngine } from '@/lib/services/routing/provider-routing-engine'
import type { ProviderScore } from '@/lib/services/routing/provider-routing-engine'

export function RoutingSimulator() {
  const [providerId, setProviderId] = useState('')
  const [packageId, setPackageId] = useState('')
  const [country, setCountry] = useState('')
  const [result, setResult] = useState<{ selected?: ProviderScore; candidates?: ProviderScore[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function simulate() {
    setLoading(true)
    setError('')
    try {
      const engine = new ProviderRoutingEngine()
      const route = await engine.selectBestProvider({
        country: country || undefined,
        packageId: packageId || undefined,
        preferredProviderId: providerId || undefined,
      })
      if (route.success) {
        setResult({ selected: route.selected, candidates: route.candidates })
      } else {
        setError(route.error || 'Routing failed')
      }
    } catch (e: any) {
      setError(e.message || 'Error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-lg border bg-white p-5 shadow-sm">
      <h3 className="text-base font-semibold text-gray-900 mb-4">Provider Routing Simulator</h3>
      <p className="text-xs text-gray-500 mb-4">Simulate routing to see which provider would be selected. No purchase is made.</p>

      <div className="space-y-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Preferred Provider (optional)</label>
          <input value={providerId} onChange={e => setProviderId(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" placeholder="Leave empty for auto-routing" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Package ID (optional)</label>
          <input value={packageId} onChange={e => setPackageId(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" placeholder="For price comparison" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Country (optional)</label>
          <input value={country} onChange={e => setCountry(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" placeholder="Country code" />
        </div>
      </div>

      <button onClick={simulate} disabled={loading}
        className="w-full rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
        {loading ? 'Simulating…' : 'Simulate Routing'}
      </button>

      {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

      {result?.candidates && result.candidates.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-gray-500 mb-2">Ranked Providers ({result.candidates.length})</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left">#</th>
                  <th className="px-2 py-1 text-left">Provider</th>
                  <th className="px-2 py-1 text-right">Score</th>
                  <th className="px-2 py-1 text-right">Health</th>
                  <th className="px-2 py-1 text-right">Price</th>
                  <th className="px-2 py-1 text-right">Latency</th>
                  <th className="px-2 py-1 text-right">Balance</th>
                  <th className="px-2 py-1 text-right">Success</th>
                  <th className="px-2 py-1 text-right">Pri</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {result.candidates.map((c, i) => (
                  <tr key={c.providerId} className={i === 0 ? 'bg-green-50' : ''}>
                    <td className="px-2 py-1 font-bold">{i + 1}</td>
                    <td className="px-2 py-1">{c.providerName}{i === 0 && <span className="ml-1 text-green-600">★</span>}</td>
                    <td className="px-2 py-1 text-right font-mono">{c.score.toFixed(1)}</td>
                    <td className="px-2 py-1 text-right">{c.breakdown.health}</td>
                    <td className="px-2 py-1 text-right">{c.breakdown.price}</td>
                    <td className="px-2 py-1 text-right">{c.breakdown.latency}</td>
                    <td className="px-2 py-1 text-right">{c.breakdown.balance}</td>
                    <td className="px-2 py-1 text-right">{c.breakdown.successRate}</td>
                    <td className="px-2 py-1 text-right">{c.breakdown.priority}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result?.selected && !result.candidates && (
        <div className="mt-4 text-xs text-gray-600">
          <span className="font-medium">Selected:</span> {result.selected.providerName} (score: {result.selected.score})
        </div>
      )}
    </div>
  )
}
