'use client'

import { ReactNode } from 'react'

interface ConfirmFormProps {
  action: (formData: FormData) => void
  message: string
  className?: string
  children: ReactNode
}

export default function ConfirmForm({ action, message, className, children }: ConfirmFormProps) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(message)) {
          e.preventDefault()
        }
      }}
      className={className}
    >
      {children}
    </form>
  )
}
