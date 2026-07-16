'use client'

import { useState, useEffect } from 'react'
import { useCleanQueryParams } from '@/lib/hooks/useCleanQueryParams'
import { NotificationContainer, type Notification } from '@/components/ui/DismissibleNotification'

interface ProviderPageClientProps {
  flashError?: string | null
  flashSuccess?: string | null
  children?: React.ReactNode
}

export function ProviderPageClient({ flashError, flashSuccess, children }: ProviderPageClientProps) {
  useCleanQueryParams()
  const [notifications, setNotifications] = useState<Notification[]>([])

  useEffect(() => {
    const newNotifications: Notification[] = []

    if (flashError) {
      newNotifications.push({
        id: 'flash-error',
        type: 'error',
        title: 'Error',
        message: decodeURIComponent(flashError),
      })
    }
    if (flashSuccess) {
      newNotifications.push({
        id: 'flash-success',
        type: 'success',
        title: 'Success',
        message: decodeURIComponent(flashSuccess),
      })
    }

    if (newNotifications.length > 0) {
      setNotifications(newNotifications)
    }
  }, [flashError, flashSuccess])

  const handleDismiss = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }

  return (
    <div>
      <NotificationContainer notifications={notifications} onDismiss={handleDismiss} />
      {children}
    </div>
  )
}
