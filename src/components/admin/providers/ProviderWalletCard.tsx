'use client'

import { useState } from 'react'
import { fetchAirhubWallet } from '@/lib/actions/airhub-wallet'

interface WalletTransaction {
  id: string; providerReference?: string | null; orderId?: string | null
  occurredAt: string; description?: string | null; transactionType: string
  amount: number; currency: string; runningBalance?: number | null
}

interface Props {
  providerId: string
  providerCode: string
  initialBalance: number | null
  initialCurrency: string | null
  initialStatus: string | null
  initialLastSync: string | null
  initialError: string | null
  initialThreshold: number | null
  initialSource?: string | null
  initialTransactions?: WalletTransaction[]
}

function fmt(v: number | null | undefined): string {
  if (v == null) return '—'
  return `$${v.toFixed(2)}`
}

export default function ProviderWalletCard({
  providerId, providerCode,
  initialBalance, initialCurrency, initialStatus,
  initialLastSync, initialError, initialThreshold,
  initialSource, initialTransactions,
}: Props) {
  const [balance, setBalance] = useState<number | null>(initialBalance)
  const [currency, setCurrency] = useState<string | null>(initialCurrency)
  const [status, setStatus] = useState<string | null>(initialStatus)
  const [lastSync, setLastSync] = useState<string | null>(initialLastSync)
  const [error, setError] = useState<string | null>(initialError)
  const [syncing, setSyncing] = useState(false)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [source, setSource] = useState<string | null>(initialSource || null)
  const [transactions, setTransactions] = useState<WalletTransaction[]>(initialTransactions || [])

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
        setSource('LIVE')
        setTransactions((result.data as any).transactions || [])
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
    } finally { setSyncing(false) }
  }

  const statusBadge = status === 'OK' ? 'bg-emerald-100 text-emerald-700' :
    status === 'LOW_BALANCE' ? 'bg-amber-100 text-amber-700' :
    status === 'ERROR' ? 'bg-red-100 text-red-700' :
    status === 'UNSUPPORTED' ? 'bg-gray-100 text-gray-400' :
    'bg-gray-100 text-gray-500'

  const statusLabel = status === 'LOW_BALANCE' ? 'Low Balance' :
    status === 'ERROR' ? 'Error' :
    status === 'UNSUPPORTED' ? 'Unsupported' : status || 'Unknown'

  const sourceLabel = source === 'LIVE' ? 'Live' :
    source === 'CACHED' ? 'Cached' :
    source === 'MANUAL' ? 'Manual' : null

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b bg-gray-50/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900">Provider Wallet</h3>
          {sourceLabel && (
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
              source === 'LIVE' ? 'bg-emerald-100 text-emerald-700' :
              source === 'CACHED' ? 'bg-amber-100 text-amber-700' :
              'bg-gray-100 text-gray-500'
            }`}>{sourceLabel}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status && <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusBadge}`}>{statusLabel}</span>}
          <button onClick={handleRefresh} disabled={syncing}
            className="rounded-md bg-cyan-600 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-700 disabled:opacity-50 transition-colors">
            {syncing ? 'Syncing...' : 'Refresh Wallet'}
          </button>
        </div>
      </div>

      <div className="p-5">
        {feedback && (
          <div className={`mb-4 rounded-lg p-3 text-sm ${feedback.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>{feedback.msg}</div>
        )}

        {balance == null ? (
          <div className="text-center py-6">
            <p className="text-sm text-gray-400">Balance unavailable</p>
            {error && <p className="text-xs text-red-500 mt-1 truncate">{error}</p>}
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 mb-4">
              <div className={`rounded-lg p-4 ${isLowBalance ? 'bg-gradient-to-r from-amber-50 to-white border border-amber-100' : 'bg-gradient-to-r from-emerald-50 to-white border border-emerald-100'}`}>
                <p className="text-xs text-gray-500 font-medium uppercase">Balance</p>
                <p className={`text-2xl font-bold mt-1 ${isLowBalance ? 'text-amber-600' : 'text-emerald-700'}`}>
                  ${balance.toFixed(2)} <span className="text-sm font-normal text-gray-500">{currency}</span>
                </p>
                {isLowBalance && <p className="text-xs text-amber-600 mt-1">Below threshold of ${initialThreshold!.toFixed(2)}</p>}
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">Last Synced</span><span className="text-gray-700">{lastSync ? new Date(lastSync).toLocaleString() : 'Never'}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Connection</span><span className={status === 'OK' ? 'text-emerald-600' : 'text-red-600'}>{status === 'OK' ? 'Connected' : status || 'Unknown'}</span></div>
                {initialThreshold != null && <div className="flex justify-between"><span className="text-gray-500">Alert Threshold</span><span className="text-gray-700">${initialThreshold.toFixed(2)}</span></div>}
              </div>
            </div>

            {/* Transaction History */}
            {transactions.length > 0 ? (
              <div className="overflow-x-auto">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Transaction History</p>
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Date</th>
                      <th className="px-2 py-1.5 text-left">Ref</th>
                      <th className="px-2 py-1.5 text-left">Description</th>
                      <th className="px-2 py-1.5 text-right">Debit</th>
                      <th className="px-2 py-1.5 text-right">Credit</th>
                      <th className="px-2 py-1.5 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {transactions.slice(0, 20).map((tx, i) => (
                      <tr key={tx.id || i}>
                        <td className="px-2 py-1 text-gray-500 whitespace-nowrap">{tx.occurredAt ? new Date(tx.occurredAt).toLocaleDateString() : '—'}</td>
                        <td className="px-2 py-1 text-gray-500 font-mono text-[10px] max-w-[80px] truncate">{tx.providerReference || tx.orderId || '—'}</td>
                        <td className="px-2 py-1 text-gray-600 max-w-[120px] truncate">{tx.description || '—'}</td>
                        <td className={`px-2 py-1 text-right font-mono ${tx.transactionType === 'DEBIT' || tx.transactionType === 'PURCHASE' ? 'text-red-600' : ''}`}>
                          {tx.transactionType === 'DEBIT' || tx.transactionType === 'PURCHASE' ? fmt(tx.amount) : '—'}
                        </td>
                        <td className={`px-2 py-1 text-right font-mono ${tx.transactionType === 'CREDIT' || tx.transactionType === 'REFUND' ? 'text-emerald-600' : ''}`}>
                          {tx.transactionType === 'CREDIT' || tx.transactionType === 'REFUND' || tx.transactionType === 'ADJUSTMENT' ? fmt(tx.amount) : '—'}
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-gray-700">{fmt(tx.runningBalance)}</td>
                      </tr>
                    ))}
                    {transactions.length > 20 && <tr><td colSpan={6} className="px-2 py-1 text-center text-gray-400">+ {transactions.length - 20} more</td></tr>}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-gray-400 text-center py-3">No transaction history returned by provider</p>
            )}
          </>
        )}

        {error && balance == null && <p className="mt-3 text-xs text-red-500 truncate">{error}</p>}
      </div>
    </div>
  )
}
