'use client'

import { useState, useRef } from 'react'
import { purchaseESIMs, requestPurchaseQuote } from '@/lib/actions/purchase'

interface PackageBuyCardProps {
  pkg: {
    id: string
    displayName: string | null
    name: string
    customerDescription: string | null
    description: string | null
    dataGB: number
    validityDays: number
    priceUSD: { toString(): string }
    requiresTravelDate?: boolean
  }
  walletBalance: number
}

function generateIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function PackageBuyCard({ pkg, walletBalance }: PackageBuyCardProps) {
  const [quantity, setQuantity] = useState(1)
  const [quoteRef, setQuoteRef] = useState<string | null>(null)
  const [quotedTotal, setQuotedTotal] = useState<number | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const keyRef = useRef(generateIdempotencyKey())
  const formRef = useRef<HTMLFormElement>(null)
  const quoteRefInput = useRef<HTMLInputElement>(null)
  const price = parseFloat(pkg.priceUSD.toString())
  const total = quotedTotal ?? price * quantity
  const insufficient = walletBalance < total

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setQuoteError('')

    // First click: no quote yet → request one and store in ref + state
    if (!quoteRef) {
      setQuoteLoading(true)
      console.log('[BUY_CLICK] requesting quote', { packageId: pkg.id, quantity })
      const result = await requestPurchaseQuote(pkg.id, quantity)
      setQuoteLoading(false)
      console.log('[QUOTE_RECEIVED]', { success: result.success, quoteRef: result.quote?.reference, total: result.quote?.totalAmount })

      if (!result.success) {
        setQuoteError(result.error || 'Cannot get price')
        return
      }

      // Set hidden input value synchronously via ref (avoids React async state race)
      quoteRefInput.current!.value = result.quote.reference
      setQuoteRef(result.quote.reference)
      setQuotedTotal(result.quote.totalAmount)
      console.log('[REQUEST_SUBMIT] form submitting with quoteRef:', result.quote.reference)
      formRef.current!.requestSubmit()
      return
    }

    // Second click: quote is ready, submit purchase
    setSubmitting(true)
    keyRef.current = generateIdempotencyKey()
    console.log('[SUBMITTING_PURCHASE]', { packageId: pkg.id, quoteRef, quantity })
    formRef.current!.requestSubmit()
  }

  const buttonLabel = quoteLoading ? 'Getting price\u2026' : quoteRef ? 'Confirm Purchase' : 'Buy Now'

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
          <span className="text-base font-bold text-emerald-600">${price.toFixed(2)}</span>
        </div>
      </div>

      <form ref={formRef} action={purchaseESIMs} className="space-y-3" onSubmit={handleSubmit}>
        <input type="hidden" name="packageId" value={pkg.id} />
        <input type="hidden" name="idempotencyKey" value={keyRef.current} />
        <input type="hidden" name="quoteReference" ref={quoteRefInput} />
        <div>
          <label htmlFor={`quantity-${pkg.id}`} className="block text-xs font-medium text-gray-500 mb-1">
            Quantity
          </label>
          <input
            id={`quantity-${pkg.id}`}
            name="quantity"
            type="number"
            min="1"
            max="100"
            value={quantity}
            onChange={(e) => setQuantity(Math.min(100, Math.max(1, parseInt(e.target.value) || 1)))}
            className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
            required
            disabled={submitting}
          />
        </div>
        {pkg.requiresTravelDate && (
          <div>
            <label htmlFor={`travel-date-${pkg.id}`} className="block text-xs font-medium text-gray-500 mb-1">
              Travel Date <span className="text-amber-600">(required)</span>
            </label>
            <input
              id={`travel-date-${pkg.id}`}
              name="travelDate"
              type="date"
              min={new Date().toISOString().split('T')[0]}
              className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
              required
              disabled={submitting}
            />
            <p className="mt-1 text-[10px] text-gray-400">This plan requires a travel date to activate.</p>
          </div>
        )}
        <div className="flex items-center justify-between pt-1">
          <span className="text-sm font-semibold text-gray-900">Total: ${total.toFixed(2)}</span>
          <button
            type="submit"
            disabled={insufficient || submitting || quoteLoading}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {submitting ? (
              <>
                <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Purchasing...
              </>
            ) : insufficient ? 'Insufficient Balance' : buttonLabel}
          </button>
        </div>
        {quoteError && <p className="mt-1 text-[11px] text-red-500">{quoteError}</p>}
        {quoteRef && !quoteError && <p className="mt-1 text-[11px] text-emerald-600">Quoted price confirmed</p>}
      </form>
    </div>
  )
}
