'use client'

import { adminDebitWallet } from '@/lib/actions/wallet'
import Link from 'next/link'

interface DebitFormProps {
  businessId: string
  walletBalance: number
}

export default function DebitForm({ businessId, walletBalance }: DebitFormProps) {
  return (
    <form
      action={adminDebitWallet}
      onSubmit={(e) => {
        const amountInput = e.currentTarget.elements.namedItem('amount') as HTMLInputElement
        const amount = parseFloat(amountInput.value)

        if (isNaN(amount) || amount <= 0) {
          e.preventDefault()
          alert('Please enter a valid amount.')
          return
        }

        if (amount > walletBalance) {
          e.preventDefault()
          alert('Insufficient wallet balance. The business only has $' + walletBalance.toFixed(2) + '.')
          return
        }

        if (!window.confirm(`Debit $${amount.toFixed(2)} from this business wallet?`)) {
          e.preventDefault()
        }
      }}
      className="space-y-4"
    >
      <input type="hidden" name="businessId" value={businessId} />

      <div>
        <label htmlFor="amount" className="block text-sm font-medium text-gray-700">
          Amount ($)
        </label>
        <input
          id="amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          max={walletBalance}
          required
          className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
          placeholder="0.00"
        />
        <p className="mt-1 text-xs text-gray-500">
          Maximum: ${walletBalance.toFixed(2)}
        </p>
      </div>

      <div>
        <label htmlFor="reason" className="block text-sm font-medium text-gray-700">
          Reason / Notes
        </label>
        <textarea
          id="reason"
          name="reason"
          required
          rows={3}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
          placeholder="Reason for debiting wallet"
        />
      </div>

      <div className="flex gap-4 pt-2">
        <button
          type="submit"
          className="rounded-lg bg-orange-600 px-6 py-2 text-sm font-medium text-white hover:bg-orange-700"
        >
          Debit Wallet
        </button>
        <Link
          href={`/admin/businesses/${businessId}`}
          className="rounded-lg bg-gray-100 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
