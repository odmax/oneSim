'use client'

import { useState, useEffect } from 'react'
import { getProviderBalanceAction } from '@/lib/actions/provider-balance'
import type { ProviderBalanceResult } from '@/lib/services/providers/provider-balance'

export function ProviderBalanceCell({ providerId, providerCode, showCapability }: { providerId: string; providerCode: string; showCapability?: boolean }) {
  const [state, setState] = useState<ProviderBalanceResult | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function fetchBalance() {
      setLoading(true)
      try {
        const result = await getProviderBalanceAction(providerId)
        if (!cancelled) setState(result)
      } catch {
        if (!cancelled) setState(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchBalance()
    return () => { cancelled = true }
  }, [providerId])

  function refresh() {
    setLoading(true)
    getProviderBalanceAction(providerId, true).then(setState).catch(() => setState(null)).finally(() => setLoading(false))
  }

  if (loading && !state) return <span className="text-xs text-gray-400 italic">Fetching…</span>
  if (!state) return <span className="text-xs text-gray-400">—</span>

  if (!state.supported && !showCapability) return null
  if (!state.supported) return <span className="text-xs text-gray-400">Not supported</span>

  if (!state.success) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-500" title={state.error || 'Unavailable'}>
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        Unavailable
      </span>
    )
  }

  const formatted = state.balance != null
    ? new Intl.NumberFormat('en-US', { style: state.currency ? 'currency' : 'decimal', currency: state.currency || 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(state.balance)
    : null

  const unit = state.balance != null && !state.currency ? ' (no currency)' : ''

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-medium text-gray-900">
        {formatted ?? <span className="text-red-500">—</span>}
        {unit && <span className="text-[10px] text-gray-400 ml-0.5">{unit}</span>}
      </span>
      {state.source === 'CACHE' && (
        <span className="text-[10px] text-gray-400">Cached {Math.round((Date.now() - state.fetchedAt.getTime()) / 1000)}s ago</span>
      )}
      <button onClick={refresh} disabled={loading} className="text-[10px] text-cyan-600 hover:underline text-left disabled:opacity-50">
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  )
}

export function ProviderBalanceCard({ providerId }: { providerId: string }) {
  const [state, setState] = useState<ProviderBalanceResult | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    getProviderBalanceAction(providerId).then(setState).catch(() => setState(null))
  }, [providerId])

  function refresh() {
    setLoading(true)
    getProviderBalanceAction(providerId, true).then(setState).catch(() => setState(null)).finally(() => setLoading(false))
  }

  if (!state) {
    return (
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900 mb-3">Running Balance</h3>
        <p className="text-sm text-gray-400 italic">Fetching balance…</p>
      </div>
    )
  }

  if (!state.supported) {
    return (
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900 mb-3">Running Balance</h3>
        <span className="inline-flex rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-600">Not supported</span>
      </div>
    )
  }

  const formatted = state.balance != null
    ? new Intl.NumberFormat('en-US', { style: state.currency ? 'currency' : 'decimal', currency: state.currency || 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(state.balance)
    : null

  return (
    <div className="rounded-lg border bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold text-gray-900">Running Balance</h3>
        <button onClick={refresh} disabled={loading} className="text-xs text-cyan-600 hover:underline disabled:opacity-50">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold text-gray-900">
            {formatted ?? <span className="text-red-500">—</span>}
          </span>
          {!state.currency && state.balance != null && (
            <span className="text-sm text-gray-400">Currency not supplied</span>
          )}
        </div>

        {state.accountName && (
          <p className="text-sm text-gray-600">Account: {state.accountName}</p>
        )}

        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${state.source === 'LIVE' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${state.source === 'LIVE' ? 'bg-green-400' : 'bg-gray-400'}`} />
            {state.source === 'LIVE' ? 'Live' : 'Cached'}
          </span>
          <span>Updated {state.fetchedAt.toLocaleTimeString()}</span>
        </div>

        {state.error && (
          <p className="text-xs text-red-500 mt-1">{state.error}</p>
        )}
      </div>
    </div>
  )
}
