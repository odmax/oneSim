'use client'

import { useState } from 'react'
import Link from 'next/link'

export default function EsimActions({ esimId, iccid, providerActivationId }: { esimId: string; iccid: string; providerActivationId?: string | null }) {
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const [shareMsg, setShareMsg] = useState<string | null>(null)

  async function handleSync() {
    setSyncing(true)
    setSyncStatus(null)
    try {
      const { syncSubscriptionStatus } = await import('@/lib/actions/esim')
      const result = await syncSubscriptionStatus(esimId)
      setSyncStatus(result.error ? `Error: ${result.error}` : result.status ? `Status: ${result.status}` : 'Status synced')
    } catch {
      setSyncStatus('Error: Sync failed')
    }
    setSyncing(false)
  }

  async function handleShare() {
    setSharing(true)
    setShareMsg(null)
    try {
      const { createShareToken } = await import('@/lib/actions/esim')
      const result = await createShareToken(esimId)
      if (result.success && result.url) {
        await navigator.clipboard.writeText(result.url)
        setShareMsg('Install link copied')
      } else {
        setShareMsg('Error: ' + (result.error || 'Failed to create link'))
      }
    } catch {
      setShareMsg('Error: Failed to copy')
    }
    setSharing(false)
    setTimeout(() => setShareMsg(null), 3000)
  }

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5 items-center">
      <Link href={`/admin/esims/${esimId}`} className="text-cyan-600 hover:text-cyan-800 text-xs font-medium">
        View SIM
      </Link>

      <Link href={`/admin/esims/${esimId}/usage`} className="text-purple-600 hover:text-purple-800 text-xs font-medium">
        Usage
      </Link>

      <button
        onClick={handleShare}
        disabled={sharing}
        className="text-emerald-600 hover:text-emerald-800 text-xs font-medium disabled:opacity-50"
      >
        {sharing ? '...' : shareMsg === 'Install link copied' ? '✓ Copied' : 'Share'}
      </button>

      {providerActivationId && (
        <button
          onClick={handleSync}
          disabled={syncing}
          className="text-amber-600 hover:text-amber-800 text-xs font-medium disabled:opacity-50"
        >
          {syncing ? '...' : 'Sync'}
        </button>
      )}

      {syncStatus && (
        <span className={`text-xs w-full ${syncStatus.startsWith('Status: ACTIVE') ? 'text-green-600' : syncStatus.startsWith('Error') ? 'text-red-600' : 'text-gray-500'}`}>
          {syncStatus}
        </span>
      )}

      {shareMsg && shareMsg !== 'Install link copied' && (
        <span className={`text-xs w-full ${shareMsg.startsWith('Error') ? 'text-red-600' : 'text-emerald-600'}`}>
          {shareMsg}
        </span>
      )}
    </div>
  )
}