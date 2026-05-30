'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface TopUpPackage {
  id: string
  name: string
  displayName: string | null
  dataGB: number
  validityDays: number
  priceUSD: number
  currency: string
  productType: string
}

export default function TopUpForm({ esimId, topUpPackages }: { esimId: string; topUpPackages: TopUpPackage[] }) {
  const router = useRouter()
  const [selectedPkg, setSelectedPkg] = useState<string>('')
  const [loading, setLoading] = useState(false)

  const selected = topUpPackages.find((p) => p.id === selectedPkg)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedPkg) return

    setLoading(true)
    try {
      const res = await fetch('/api/v1/esims/' + esimId + '/top-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: selectedPkg, quantity: 1 }),
      })
      const data = await res.json()
      if (data.success) {
        router.push('/business/esims/' + esimId + '/top-up?success=true')
      } else {
        const err = data.error?.code || ''
        let msg = 'provider_failed'
        if (err === 'INSUFFICIENT_WALLET_BALANCE') msg = 'insufficient_balance'
        else if (err === 'TOPUP_NOT_AVAILABLE') msg = 'not_available'
        else if (err === 'INVALID_TOPUP_PACKAGE') msg = 'invalid_package'
        router.push('/business/esims/' + esimId + '/top-up?error=' + msg)
      }
    } catch {
      router.push('/business/esims/' + esimId + '/top-up?error=provider_failed')
    } finally {
      setLoading(false)
    }
  }

  if (topUpPackages.length === 0) {
    return (
      <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-12 text-center">
        <p className="text-gray-500">No top-up packages available for this eSIM.</p>
        <p className="mt-1 text-xs text-gray-400">Ask your admin to configure compatible top-up bundles.</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
      <h3 className="mb-4 text-lg font-semibold text-gray-900">Select Top-Up Bundle</h3>

      <div className="mb-6 space-y-3">
        {topUpPackages.map((pkg) => (
          <label
            key={pkg.id}
            className={`flex cursor-pointer items-center gap-4 rounded-lg border p-4 transition-colors ${
              selectedPkg === pkg.id
                ? 'border-emerald-300 bg-emerald-50 ring-1 ring-emerald-200'
                : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <input
              type="radio"
              name="packageId"
              value={pkg.id}
              checked={selectedPkg === pkg.id}
              onChange={() => setSelectedPkg(pkg.id)}
              className="h-4 w-4 text-emerald-600"
            />
            <div className="flex-1">
              <p className="font-medium text-gray-900">{pkg.displayName || pkg.name}</p>
              <p className="text-sm text-gray-500">{pkg.dataGB} GB — {pkg.validityDays} days</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-bold text-gray-900">${parseFloat(pkg.priceUSD.toString()).toFixed(2)}</p>
              <p className="text-xs text-gray-400">{pkg.currency}</p>
            </div>
          </label>
        ))}
      </div>

      {selected && (
        <div className="mb-6 rounded-lg bg-gray-50 p-4">
          <p className="text-sm text-gray-600">
            <span className="font-medium">You will be charged:</span> ${parseFloat(selected.priceUSD.toString()).toFixed(2)} {selected.currency}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {selected.dataGB} GB data added · {selected.validityDays} days validity extension
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={!selectedPkg || loading}
        className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 shadow-sm"
      >
        {loading ? 'Processing...' : selectedPkg ? 'Confirm Top-Up' : 'Select a Bundle'}
      </button>

      <p className="mt-2 text-xs text-gray-400">
        Funds will be deducted from your wallet. If the provider fails, no amount will be charged.
      </p>
    </form>
  )
}