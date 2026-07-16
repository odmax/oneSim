'use client'

import { useEffect, useState, useCallback } from 'react'

export type NotificationType = 'success' | 'error' | 'info'

export interface Notification {
  id: string
  type: NotificationType
  title?: string
  message: string
  autoDismissMs?: number
}

interface DismissibleNotificationProps {
  notification: Notification
  onDismiss: (id: string) => void
}

export function DismissibleNotification({ notification, onDismiss }: DismissibleNotificationProps) {
  const [collapsed, setCollapsed] = useState(true)
  const isLong = notification.message.length > 150

  const handleDismiss = useCallback(() => {
    onDismiss(notification.id)
  }, [notification.id, onDismiss])

  useEffect(() => {
    if (notification.type === 'error') return
    const ms = notification.autoDismissMs ?? (notification.type === 'success' ? 5000 : 8000)
    const timer = setTimeout(handleDismiss, ms)
    return () => clearTimeout(timer)
  }, [notification.type, notification.autoDismissMs, handleDismiss])

  const colors = {
    success: 'bg-green-50 border-green-400 text-green-800',
    error: 'bg-red-50 border-red-400 text-red-800',
    info: 'bg-blue-50 border-blue-400 text-blue-800',
  }

  const icons = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`border-l-4 p-4 mb-3 rounded-r shadow-sm ${colors[notification.type]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <span className="mt-0.5 shrink-0 font-bold" aria-hidden="true">
            {icons[notification.type]}
          </span>
          <div className="min-w-0">
            {notification.title && (
              <p className="font-semibold text-sm">{notification.title}</p>
            )}
            {isLong ? (
              <div>
                <p className="text-sm whitespace-pre-wrap break-words">
                  {collapsed ? notification.message.substring(0, 150) + '...' : notification.message}
                </p>
                <button
                  onClick={() => setCollapsed(!collapsed)}
                  className="text-xs underline mt-1 opacity-70 hover:opacity-100"
                >
                  {collapsed ? 'Show more' : 'Show less'}
                </button>
              </div>
            ) : (
              <p className="text-sm whitespace-pre-wrap break-words">{notification.message}</p>
            )}
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="shrink-0 ml-2 p-1 rounded hover:bg-black/5 transition-colors"
          aria-label="Dismiss notification"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}

interface NotificationContainerProps {
  notifications: Notification[]
  onDismiss: (id: string) => void
}

export function NotificationContainer({ notifications, onDismiss }: NotificationContainerProps) {
  if (notifications.length === 0) return null
  return (
    <div className="mb-6 space-y-2" aria-label="Notifications">
      {notifications.map((n) => (
        <DismissibleNotification key={n.id} notification={n} onDismiss={onDismiss} />
      ))}
    </div>
  )
}
