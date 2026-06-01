'use client'

import { deletePackageAction } from '@/lib/actions/package'

interface Props {
  packageId: string
  variant?: 'card' | 'table'
  hasPurchases?: boolean
}

export function DeletePackageButton({ packageId, variant = 'card', hasPurchases = false }: Props) {
  const confirmMsg = hasPurchases
    ? 'This package has purchased eSIMs. It will be hidden from future sales, but existing eSIMs, orders, invoices, and reports will remain.'
    : 'This package has no purchases and will be permanently deleted.'

  return (
    <form action={deletePackageAction} className={variant === 'table' ? 'inline' : ''} onSubmit={e => {
      if (!confirm(confirmMsg)) {
        e.preventDefault()
      }
    }}>
      <input type="hidden" name="id" value={packageId} />
      <button
        type="submit"
        className={variant === 'card'
          ? `rounded-lg px-3 py-2 text-sm font-medium ${hasPurchases ? 'bg-amber-50 text-amber-600 hover:bg-amber-100' : 'bg-red-50 text-red-600 hover:bg-red-100'}`
          : 'text-red-600 hover:text-red-800 text-sm'
        }
      >
        {hasPurchases ? 'Hide from Catalog' : 'Delete'}
      </button>
    </form>
  )
}