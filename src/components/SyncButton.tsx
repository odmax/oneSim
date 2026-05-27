'use client'

import { useState } from 'react'

export default function SyncButton({ esimId, providerActivationId }: { esimId: string; providerActivationId: string }) {
  const [syncing, setSyncing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  async function handleSync() {
    setSyncing(true)
    setStatus(null)

    try {
      const { syncSubscriptionStatus } = await import('@/lib/actions/esim')
      const result = await syncSubscriptionStatus(esimId)

      if (result.error) {
        setStatus(`Error: ${result.error}`)
      } else if (result.status) {
        setStatus(`Status: ${result.status}`)
      } else {
        setStatus('Status synced')
      }
    } catch {
      setStatus('Error: Sync failed')
    }

    setSyncing(false)
  }

  return (
    <div>
      <button
        onClick={handleSync}
        disabled={syncing}
        className="text-cyan-600 hover:text-cyan-900 text-xs disabled:opacity-50"
      >
        {syncing ? 'Syncing...' : 'Sync'}
      </button>
      {status && (
        <div className={`text-xs mt-1 ${status.startsWith('Status: ACTIVE') ? 'text-green-600' : status.startsWith('Error') ? 'text-red-600' : 'text-gray-500'}`}>
          {status}
        </div>
      )}
    </div>
  )
}
