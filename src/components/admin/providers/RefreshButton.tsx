'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DismissibleNotification, type Notification } from '@/components/ui/DismissibleNotification'

interface RefreshButtonProps {
  providerId: string
  variant?: 'primary' | 'secondary' | 'small'
  label?: string
  showConnectionTest?: boolean
}

async function testProviderConnection(providerId: string): Promise<{ success: boolean; message?: string; error?: string }> {
  const { testProviderConnection: testConn } = await import('@/lib/actions/provider-auth')
  return testConn(providerId)
}

export function RefreshButton({ providerId, variant = 'primary', label = 'Refresh', showConnectionTest = false }: RefreshButtonProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [notification, setNotification] = useState<Notification | null>(null)

  const handleRefresh = async () => {
    if (loading) return
    setLoading(true)
    setNotification(null)

    try {
      let result: any = { success: true }

      if (showConnectionTest) {
        result = await testProviderConnection(providerId)
      }

      router.refresh()

      if (result.success) {
        setNotification({
          id: 'refresh-success',
          type: 'success',
          message: result.message || 'Provider data refreshed',
        })
      } else {
        setNotification({
          id: 'refresh-error',
          type: 'error',
          message: result.error || 'Refresh failed',
        })
      }
    } catch (e: any) {
      setNotification({
        id: 'refresh-error',
        type: 'error',
        message: e.message || 'Refresh failed',
      })
    } finally {
      setLoading(false)
    }
  }

  const baseClass = variant === 'small'
    ? 'px-3 py-1.5 text-xs font-medium'
    : variant === 'secondary'
    ? 'px-4 py-2 text-sm font-medium'
    : 'px-4 py-2 text-sm font-medium'

  const colorClass = variant === 'primary'
    ? 'bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300'
    : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 disabled:opacity-50'

  return (
    <div>
      <button
        onClick={handleRefresh}
        disabled={loading}
        className={`${baseClass} ${colorClass} rounded-md transition-colors inline-flex items-center gap-2`}
      >
        {loading ? (
          <>
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Refreshing...
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {label}
          </>
        )}
      </button>
      {notification && (
        <div className="mt-3">
          <DismissibleNotification
            notification={notification}
            onDismiss={(id) => setNotification(null)}
          />
        </div>
      )}
    </div>
  )
}
