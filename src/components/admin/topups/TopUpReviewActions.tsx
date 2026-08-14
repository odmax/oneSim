'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DismissibleNotification, type Notification } from '@/components/ui/DismissibleNotification'

interface TopUpReviewActionsProps {
  topUpId: string
}

/**
 * Admin safe action for PENDING_REVIEW top-ups. Calls the reconciliation API
 * route, which runs the exact same recovery path as the background job. It never
 * re-dispatches the provider top-up mutation and never exposes raw payloads.
 */
export function TopUpReviewActions({ topUpId }: TopUpReviewActionsProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [notification, setNotification] = useState<Notification | null>(null)

  const handleRetry = async () => {
    if (loading) return
    setLoading(true)
    setNotification(null)
    try {
      const res = await fetch(`/api/admin/topups/review/${encodeURIComponent(topUpId)}/reconcile`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      router.refresh()
      if (!res.ok || !data.success) {
        setNotification({ id: 'reconcile-error', type: 'error', message: data.error || 'Reconciliation retry failed' })
        return
      }
      const outcome = data.result?.outcome || 'unknown'
      const message = outcome === 'FOUND_SUCCESS'
        ? 'Resolved: top-up confirmed successful — funds captured.'
        : outcome === 'FOUND_FAILURE'
          ? 'Resolved: top-up confirmed failed — funds released.'
          : 'Still unknown — funds remain reserved. It was re-scheduled for another attempt.'
      setNotification({ id: 'reconcile-success', type: 'success', message })
    } catch (e: any) {
      setNotification({ id: 'reconcile-error', type: 'error', message: e.message || 'Reconciliation retry failed' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <button
        onClick={handleRetry}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-700 disabled:bg-amber-300"
      >
        {loading ? 'Reconciling…' : 'Retry Reconciliation'}
      </button>
      {notification && (
        <div className="mt-3">
          <DismissibleNotification notification={notification} onDismiss={() => setNotification(null)} />
        </div>
      )}
    </div>
  )
}
