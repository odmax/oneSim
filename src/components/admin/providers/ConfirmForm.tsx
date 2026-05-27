'use client'

import { useRef } from 'react'

export function ConfirmForm({ action, message, children, className }: {
  action: (formData: FormData) => void
  message: string
  children: React.ReactNode
  className?: string
}) {
  const formRef = useRef<HTMLFormElement>(null)

  return (
    <form
      ref={formRef}
      action={action}
      onSubmit={(e) => {
        if (!confirm(message)) {
          e.preventDefault()
        }
      }}
      className={className}
    >
      {children}
    </form>
  )
}
