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
