'use client'

import { useState } from 'react'
import { refreshEsimQrCodeAction } from '@/lib/actions/esim-sync'

interface RefreshQrButtonProps {
  esimId: string
  hasInstallData: boolean
}

export function RefreshQrButton({ esimId, hasInstallData }: RefreshQrButtonProps) {
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  async function handleRefresh() {
    if (loading) return
    setLoading(true)
    setMessage(null)

    try {
      const result = await refreshEsimQrCodeAction(esimId)

      if (result.success) {
        setMessage({ type: 'success', text: 'QR code refreshed' })
        // Force a server-side re-render to pick up the updated eSIM data.
        window.location.reload()
      } else {
        const err = result as { success: false; error?: string; outcome?: string }
        if (err.outcome === 'NOT_SUPPORTED') {
          setMessage({ type: 'info', text: 'QR refresh is not supported for this eSIM.' })
        } else if (err.outcome === 'NO_DATA') {
          setMessage({ type: 'info', text: err.error || 'QR code is not available yet. Try again shortly.' })
        } else if (err.outcome === 'PROVIDER_UNAVAILABLE') {
          setMessage({ type: 'error', text: 'Provider is not available. Try again later.' })
        } else {
          setMessage({ type: 'error', text: err.error || 'Refresh failed. Please try again.' })
        }
      }
    } catch {
      setMessage({ type: 'error', text: 'An unexpected error occurred.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={handleRefresh}
        disabled={loading}
        className="rounded-lg border border-violet-300 px-4 py-2 text-sm font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Refreshing…' : 'Refresh QR Code'}
      </button>
      {message && (
        <p className={`text-xs ${message.type === 'success' ? 'text-green-600' : message.type === 'info' ? 'text-amber-600' : 'text-red-600'}`}>
          {message.text}
        </p>
      )}
    </div>
  )
}
