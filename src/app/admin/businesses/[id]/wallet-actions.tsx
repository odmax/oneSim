'use client'

import { useState } from 'react'
import { adminCreditWallet, adminDebitWallet } from '@/lib/actions/wallet'

interface WalletActionsProps {
  businessId: string
  walletBalance: number
}

export default function WalletActions({ businessId, walletBalance }: WalletActionsProps) {
  const [mode, setMode] = useState<'credit' | 'debit' | null>(null)

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode(mode === 'credit' ? null : 'credit')}
          className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
        >
          Credit Wallet
        </button>
        <button
          type="button"
          onClick={() => setMode(mode === 'debit' ? null : 'debit')}
          className="rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700"
        >
          Debit Wallet
        </button>
      </div>

      {mode === 'credit' && (
        <form
          action={adminCreditWallet}
          onSubmit={(e) => {
            const result = window.confirm('Credit this business wallet?')
            if (!result) e.preventDefault()
          }}
          className="rounded-lg border border-green-200 bg-green-50 p-4 space-y-3"
        >
          <input type="hidden" name="businessId" value={businessId} />
          <div>
            <label className="block text-sm font-medium text-gray-700">Amount ($)</label>
            <input
              type="number"
              name="amount"
              step="0.01"
              min="0.01"
              required
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Reason / Notes</label>
            <textarea
              name="reason"
              required
              rows={2}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              placeholder="Reason for crediting wallet"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              Confirm Credit
            </button>
            <button
              type="button"
              onClick={() => setMode(null)}
              className="rounded-lg bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === 'debit' && (
        <form
          action={adminDebitWallet}
          onSubmit={(e) => {
            const amountInput = (e.currentTarget.elements.namedItem('amount') as HTMLInputElement)
            const amount = parseFloat(amountInput.value)
            if (amount > walletBalance) {
              e.preventDefault()
              alert('Insufficient wallet balance')
              return
            }
            const result = window.confirm(`Debit $${amount.toFixed(2)} from this business wallet?`)
            if (!result) e.preventDefault()
          }}
          className="rounded-lg border border-orange-200 bg-orange-50 p-4 space-y-3"
        >
          <input type="hidden" name="businessId" value={businessId} />
          <div>
            <label className="block text-sm font-medium text-gray-700">Amount ($)</label>
            <input
              type="number"
              name="amount"
              step="0.01"
              min="0.01"
              required
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Reason / Notes</label>
            <textarea
              name="reason"
              required
              rows={2}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              placeholder="Reason for debiting wallet"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700"
            >
              Confirm Debit
            </button>
            <button
              type="button"
              onClick={() => setMode(null)}
              className="rounded-lg bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Current balance: ${walletBalance.toFixed(2)}
          </p>
        </form>
      )}
    </div>
  )
}
