'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { generateInvoice } from '@/lib/actions/invoices'

export default function NewInvoicePage({ searchParams }: { searchParams?: { error?: string } }) {
  const [items, setItems] = useState([{ description: '', quantity: 1, unitPrice: 0 }])
  const [businessId, setBusinessId] = useState('')
  const [invoiceType, setInvoiceType] = useState('MANUAL')
  const router = useRouter()

  const subtotal = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0)

  return (
    <div className="space-y-6 max-w-2xl">
      <a href="/admin/invoices" className="text-sm text-gray-500 hover:text-gray-700">← Back to Invoices</a>
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Generate Invoice</h2>
        <p className="mt-1 text-sm text-gray-500">Create a manual invoice for a business</p>
      </div>

      {searchParams?.error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>}

      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <form action={generateInvoice} className="space-y-5">
          <input type="hidden" name="lineItems" value={JSON.stringify(items.map(i => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice })))} />

          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Invoice Details</h3>
            <div>
              <label className="block text-sm font-medium text-gray-700">Business *</label>
              <BusinessSelect value={businessId} onChange={setBusinessId} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Type</label>
                <select name="type" value={invoiceType} onChange={e => setInvoiceType(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
                  <option value="MANUAL">Manual</option>
                  <option value="ADJUSTMENT">Adjustment</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Currency</label>
                <select name="currency"
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Due Date</label>
                <input name="dueDate" type="date"
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Line Items</h3>
            {items.map((item, i) => (
              <div key={i} className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="block text-xs text-gray-500 mb-1">Description</label>
                  <input type="text" value={item.description} onChange={e => { const n = [...items]; n[i].description = e.target.value; setItems(n) }}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
                </div>
                <div className="w-20">
                  <label className="block text-xs text-gray-500 mb-1">Qty</label>
                  <input type="number" min="1" value={item.quantity} onChange={e => { const n = [...items]; n[i].quantity = parseInt(e.target.value) || 1; setItems(n) }}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
                </div>
                <div className="w-28">
                  <label className="block text-xs text-gray-500 mb-1">Unit Price</label>
                  <input type="number" step="0.01" min="0" value={item.unitPrice} onChange={e => { const n = [...items]; n[i].unitPrice = parseFloat(e.target.value) || 0; setItems(n) }}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
                </div>
                {items.length > 1 && (
                  <button type="button" onClick={() => setItems(items.filter((_, j) => j !== i))}
                    className="rounded-md bg-red-50 px-2.5 py-2 text-xs font-medium text-red-600 hover:bg-red-100 mb-0.5">
                    ×
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => setItems([...items, { description: '', quantity: 1, unitPrice: 0 }])}
              className="text-sm font-medium text-emerald-600 hover:text-emerald-700">
              + Add line item
            </button>
          </div>

          <div className="rounded-lg bg-gray-50 p-4 text-right">
            <p className="text-sm text-gray-500">Subtotal</p>
            <p className="text-2xl font-bold text-gray-900">${subtotal.toFixed(2)}</p>
          </div>

          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Notes & Options</h3>
            <div>
              <label className="block text-sm font-medium text-gray-700">Notes</label>
              <textarea name="notes" rows={3}
                className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
            </div>
            <div className="flex items-center gap-3">
              <input id="markPaid" name="markPaid" type="checkbox" className="h-4 w-4 rounded border-gray-300 text-emerald-600" />
              <label htmlFor="markPaid" className="text-sm text-gray-700">Mark as Paid immediately</label>
            </div>
          </div>

          <div className="flex gap-3 pt-4 border-t border-gray-100">
            <button type="submit" className="rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
              Create Invoice
            </button>
            <a href="/admin/invoices" className="rounded-lg border border-gray-200 px-6 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</a>
          </div>
        </form>
      </div>
    </div>
  )
}

function BusinessSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [businesses, setBusinesses] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)

  useState(() => {
    fetch('/api/businesses').then(r => r.json()).then(d => { setBusinesses(d); setLoading(false) }).catch(() => setLoading(false))
  })

  return (
    <select name="businessId" value={value} onChange={e => onChange(e.target.value)} required
      className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
      <option value="">Select business...</option>
      {loading && <option disabled>Loading...</option>}
      {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  )
}
