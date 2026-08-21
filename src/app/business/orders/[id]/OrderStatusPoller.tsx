'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { shouldStopPolling, nextPollDelayMs } from '@/lib/orders/order-polling'

/**
 * Polls order status while a purchase is in flight and refreshes the
 * server-rendered page when it changes. Stops on terminal statuses; keeps a
 * slow watch while the order is in PROVIDER_RECONCILIATION.
 */
export function OrderStatusPoller({ orderId, initialStatus }: { orderId: string; initialStatus: string }) {
  const router = useRouter()
  const [status, setStatus] = useState(initialStatus)
  const statusRef = useRef(initialStatus)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const poll = async () => {
      try {
        const res = await fetch(`/api/business/orders/${orderId}/status`, { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          if (!cancelled && data.status && data.status !== statusRef.current) {
            statusRef.current = data.status
            setStatus(data.status)
            router.refresh()
          }
        }
      } catch {
        // Transient network errors: keep polling on schedule.
      }
      if (!cancelled) timer = setTimeout(poll, nextPollDelayMs(statusRef.current))
    }

    if (!shouldStopPolling(initialStatus)) {
      timer = setTimeout(poll, nextPollDelayMs(initialStatus))
    }

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [orderId, initialStatus, router])

  if (shouldStopPolling(status)) return null

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-amber-800">
        <svg className="animate-spin h-4 w-4 text-amber-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        {status === 'PROVIDER_RECONCILIATION'
          ? 'We are verifying your purchase with the provider — this page updates automatically.'
          : 'Processing your purchase — this page updates automatically.'}
      </p>
    </div>
  )
}
