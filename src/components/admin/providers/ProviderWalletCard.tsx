'use client'

import { useState } from 'react'
import { fetchAirhubWallet } from '@/lib/actions/airhub-wallet'

interface Props {
  providerId: string
  providerCode: string
  initialBalance: number | null
  initialCurrency: string | null
  initialStatus: string | null
  initialLastSync: string | null
  initialError: string | null
  initialThreshold: number | null
}

export default function ProviderWalletCard({
  providerId, providerCode,
  initialBalance, initialCurrency, initialStatus,
  initialLastSync, initialError, initialThreshold,
}: Props) {
  const [balance, setBalance] = useState<number | null>(initialBalance)
  const [currency, setCurrency] = useState<string | null>(initialCurrency)
  const [status, setStatus] = useState<string | null>(initialStatus)
  const [lastSync, setLastSync] = useState<string | null>(initialLastSync)
  const [error, setError] = useState<string | null>(initialError)
  const [syncing, setSyncing] = useState(false)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)

  const isLowBalance = initialThreshold != null && balance != null && balance < initialThreshold

  async function handleRefresh() {
    setSyncing(true)
    setFeedback(null)
    try {
      const result = await fetchAirhubWallet(providerId, 'MANUAL')
      if (result.success && result.data) {
        setBalance(result.data.balance)
        setCurrency(result.data.currency)
        setLastSync(result.data.lastSyncedAt || null)
        setStatus('OK')
        setError(null)
        setFeedback({ type: 'success', msg: `Balance updated: $${result.data.balance.toFixed(2)}` })
      } else {
        setStatus('ERROR')
        setError(result.error || 'Sync failed')
        setFeedback({ type: 'error', msg: result.error || 'Sync failed' })
      }
    } catch (e: any) {
      setStatus('ERROR')
      setError(e.message || 'Sync failed')
      setFeedback({ type: 'error', msg: e.message || 'Sync failed' })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b bg-gray-50/50 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Provider Wallet</h3>
        <div className="flex items-center gap-2">
          {status && (
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
              status === 'OK' ? 'bg-emerald-100 text-emerald-700' :
              status === 'LOW_BALANCE' ? 'bg-amber-100 text-amber-700' :
              status === 'TIMEOUT' ? 'bg-amber-100 text-amber-700' :
              status === 'UNAUTHORIZED' ? 'bg-red-100 text-red-700' :
              status === 'ERROR' ? 'bg-red-100 text-red-700' :
              'bg-gray-100 text-gray-500'
            }`}>
              {status === 'LOW_BALANCE' ? 'Low Balance' : status === 'ERROR' ? 'Error' : status}
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={syncing}
            className="rounded-md bg-cyan-600 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-700 disabled:opacity-50 transition-colors"
          >
            {syncing ? 'Syncing...' : 'Refresh Wallet'}
          </button>
        </div>
      </div>

      <div className="p-5">
        {feedback && (
          <div className={`mb-4 rounded-lg p-3 text-sm ${feedback.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
            {feedback.msg}
          </div>
        )}

        {balance == null ? (
          <div className="text-center py-6">
            <p className="text-sm text-gray-400">Balance unavailable</p>
            {error && <p className="text-xs text-red-500 mt-1 truncate">{error}</p>}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={`rounded-lg p-4 ${isLowBalance ? 'bg-gradient-to-r from-amber-50 to-white border border-amber-100' : 'bg-gradient-to-r from-emerald-50 to-white border border-emerald-100'}`}>
              <p className="text-xs text-gray-500 font-medium uppercase">Balance</p>
              <p className={`text-2xl font-bold mt-1 ${isLowBalance ? 'text-amber-600' : 'text-emerald-700'}`}>
                ${balance.toFixed(2)} <span className="text-sm font-normal text-gray-500">{currency}</span>
              </p>
              {isLowBalance && (
                <p className="text-xs text-amber-600 mt-1">Below threshold of ${initialThreshold!.toFixed(2)}</p>
              )}
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Last Synced</span>
                <span className="text-gray-700">{lastSync ? new Date(lastSync).toLocaleString() : 'Never'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Connection</span>
                <span className={status === 'OK' ? 'text-emerald-600' : 'text-red-600'}>
                  {status === 'OK' ? 'Connected' : status || 'Unknown'}
                </span>
              </div>
              {initialThreshold != null && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Alert Threshold</span>
                  <span className="text-gray-700">${initialThreshold.toFixed(2)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {error && balance == null && (
          <p className="mt-3 text-xs text-red-500 truncate">{error}</p>
        )}
      </div>
    </div>
  )
}
