'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { requestPurchaseQuote, executePurchase } from '@/lib/actions/purchase'

type FlowState = 'IDLE' | 'GETTING_QUOTE' | 'QUOTE_READY' | 'SUBMITTING' | 'ERROR'

interface PackageBuyCardProps {
  pkg: {
    id: string
    displayName: string | null
    name: string
    customerDescription: string | null
    description: string | null
    dataGB: number
    validityDays: number
    unitPrice: number
    currency: string
    requiresTravelDate?: boolean
  }
  walletBalance: number
}

function generateIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function PackageBuyCard({ pkg, walletBalance }: PackageBuyCardProps) {
  const router = useRouter()
  const [flowState, setFlowState] = useState<FlowState>('IDLE')
  const [quantity, setQuantity] = useState(1)
  const [travelDate, setTravelDate] = useState('')
  const [quoteRef, setQuoteRef] = useState<string | null>(null)
  const [quotedUnitPrice, setQuotedUnitPrice] = useState<number | null>(null)
  const [quotedTotal, setQuotedTotal] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(generateIdempotencyKey())

  const displayPrice = pkg.unitPrice
  const total = quotedTotal ?? displayPrice * quantity
  const insufficient = walletBalance < total

  const handleBuyClick = async () => {
    setErrorMsg('')

    // Client-side guard: travel-date-required packages need a valid date
    if (pkg.requiresTravelDate && !travelDate) {
      setErrorMsg('This package requires a travel date.')
      return
    }

    if (flowState === 'IDLE') {
      // Step 1: Request quote
      setFlowState('GETTING_QUOTE')
      const result = await requestPurchaseQuote(pkg.id, quantity)

      if (!result.success || !result.quote) {
        setErrorMsg(result.error || 'Cannot get price')
        setFlowState('ERROR')
        return
      }

      setQuoteRef(result.quote.reference)
      setQuotedUnitPrice(result.quote.unitPrice)
      setQuotedTotal(result.quote.totalAmount)
      setFlowState('QUOTE_READY')
      return
    }

    if (flowState === 'QUOTE_READY') {
      // Step 2: Submit purchase
      if (!quoteRef) {
        setErrorMsg('Quote missing — please try again')
        setFlowState('ERROR')
        return
      }

      setFlowState('SUBMITTING')
      const newKey = generateIdempotencyKey()
      setIdempotencyKey(newKey)

      const result = await executePurchase({
        packageId: pkg.id,
        quantity,
        quoteReference: quoteRef,
        idempotencyKey: newKey,
        travelDate: pkg.requiresTravelDate ? travelDate : undefined,
      })

      if (!result.success) {
        setErrorMsg(result.message || 'Purchase failed')
        setFlowState('ERROR')
        return
      }

      router.push(`/business/orders/${result.orderId}`)
      return
    }

    // ERROR state: retry
    if (flowState === 'ERROR') {
      setFlowState('IDLE')
      setQuoteRef(null)
      setQuotedTotal(null)
      setErrorMsg('')
    }
  }

  const buttonLabel = () => {
    switch (flowState) {
      case 'GETTING_QUOTE': return 'Getting price...'
      case 'QUOTE_READY': return `Confirm Purchase — $${total.toFixed(2)}`
      case 'SUBMITTING': return 'Processing...'
      case 'ERROR': return 'Try Again'
      default: return 'Buy Now'
    }
  }

  const isDisabled = insufficient || flowState === 'GETTING_QUOTE' || flowState === 'SUBMITTING'
  const showSpinner = flowState === 'GETTING_QUOTE' || flowState === 'SUBMITTING'

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-gray-900">{pkg.displayName || pkg.name}</h3>
        {pkg.customerDescription || pkg.description ? (
          <p className="mt-1 text-xs text-gray-400">{pkg.customerDescription || pkg.description}</p>
        ) : null}
      </div>

      <div className="mb-4 space-y-2">
        <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
          <span className="text-sm text-gray-500">Data</span>
          <span className="text-sm font-semibold text-gray-900">{pkg.dataGB} GB</span>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
          <span className="text-sm text-gray-500">Validity</span>
          <span className="text-sm font-semibold text-gray-900">{pkg.validityDays} days</span>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
          <span className="text-sm text-gray-500">Price</span>
          <span className="text-base font-bold text-emerald-600">{pkg.currency === 'USD' ? '$' : ''}{displayPrice.toFixed(2)}</span>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label htmlFor={`qty-${pkg.id}`} className="block text-xs font-medium text-gray-500 mb-1">
            Quantity
          </label>
          <input
            id={`qty-${pkg.id}`}
            type="number"
            min="1"
            max="100"
            value={quantity}
            onChange={(e) => setQuantity(Math.min(100, Math.max(1, parseInt(e.target.value) || 1)))}
            className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
            required
            disabled={flowState !== 'IDLE' && flowState !== 'QUOTE_READY' && flowState !== 'ERROR'}
          />
        </div>
        {pkg.requiresTravelDate && (
          <div>
            <label htmlFor={`travel-${pkg.id}`} className="block text-xs font-medium text-gray-500 mb-1">
              Travel Date <span className="text-amber-600">(required)</span>
            </label>
            <input
              id={`travel-${pkg.id}`}
              type="date"
              min={new Date().toISOString().split('T')[0]}
              value={travelDate}
              onChange={(e) => setTravelDate(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              required
              disabled={flowState !== 'IDLE' && flowState !== 'QUOTE_READY' && flowState !== 'ERROR'}
            />
          </div>
        )}
        <div className="flex items-center justify-between pt-1">
          <span className="text-sm font-semibold text-gray-900">Total: ${total.toFixed(2)}</span>
          <button
            type="button"
            disabled={isDisabled}
            onClick={handleBuyClick}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {showSpinner && (
              <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            )}
            {buttonLabel()}
          </button>
        </div>
        {errorMsg && <p className="mt-1 text-[11px] text-red-500">{errorMsg}</p>}
        {flowState === 'QUOTE_READY' && <p className="mt-1 text-[11px] text-emerald-600">Quoted price confirmed — ${total.toFixed(2)}</p>}
      </div>
    </div>
  )
}
