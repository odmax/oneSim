'use client'

import { deletePackageAction } from '@/lib/actions/package'

interface Props {
  packageId: string
  variant?: 'card' | 'table'
}

export function DeletePackageButton({ packageId, variant = 'card' }: Props) {
  return (
    <form action={deletePackageAction} className={variant === 'table' ? 'inline' : ''} onSubmit={e => {
      if (!confirm('Delete this package? All linked purchases and eSIMs will also be permanently deleted.')) {
        e.preventDefault()
      }
    }}>
      <input type="hidden" name="id" value={packageId} />
      <button
        type="submit"
        className={variant === 'card'
          ? 'rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-100'
          : 'text-red-600 hover:text-red-800 text-sm'
        }
      >
        Delete
      </button>
    </form>
  )
}
