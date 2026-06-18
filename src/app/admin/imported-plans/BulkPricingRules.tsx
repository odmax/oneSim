'use client'

import { useState } from 'react'

export default function BulkPricingRules() {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<any>(null)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<any>(null)

  async function handlePreview(formData: FormData) {
    setPreview(null); setResult(null)
    try {
      const mod = await import('@/lib/actions/imported-plans')
      const res = await mod.previewPricingRules(formData)
      setPreview(res)
    } catch (e: any) {
      setPreview({ error: e.message || 'Preview failed' })
    }
  }

  async function handleApply() {
    setApplying(true); setResult(null)
    try {
      const mod = await import('@/lib/actions/imported-plans')
      const fd = new FormData(document.getElementById('pricing-rule-form') as HTMLFormElement)
      const res = await mod.applyPricingRules(fd)
      setResult(res)
      setPreview(null)
    } catch (e: any) {
      setResult({ error: e.message || 'Apply failed' })
    }
    setApplying(false)
  }

  return (
    <div className="mb-6 rounded-xl border border-gray-100 bg-white shadow-sm">
      <button type="button" onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-6 py-4 text-left">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Bulk Pricing Rules</h3>
          <p className="text-xs text-gray-500 mt-0.5">Apply markup to cost price to auto-calculate selling prices for matching plans</p>
        </div>
        <span className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-6 py-4">
          <form id="pricing-rule-form" action={handlePreview} className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Provider Code</label>
                <input name="providerCode" type="text" placeholder="e.g. AIRHUB"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Country</label>
                <input name="country" type="text" placeholder="e.g. Malawi"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Min Cost</label>
                <input name="minCost" type="number" step="0.01" min="0" placeholder="0.00"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Max Cost</label>
                <input name="maxCost" type="number" step="0.01" min="0" placeholder="0.00"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Markup % *</label>
                <input name="markupPercent" type="number" step="0.1" min="0.1" required placeholder="30"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input name="applyToMissingSellingPriceOnly" type="checkbox" defaultChecked
                    className="h-4 w-4 rounded border-gray-300 text-emerald-600" />
                  <span className="text-xs text-gray-600">Missing sell price only</span>
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button type="submit"
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 shadow-sm">
                Preview
              </button>
            </div>
          </form>

          {preview && preview.error && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{preview.error}</div>
          )}

          {preview && !preview.error && (
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-4 gap-3 text-sm">
                <div className="rounded-lg bg-gray-50 p-3"><span className="text-gray-500">Matched</span><br /><strong>{preview.matched}</strong></div>
                <div className="rounded-lg bg-gray-50 p-3"><span className="text-gray-500">Will Update</span><br /><strong className="text-emerald-600">{preview.willUpdate}</strong></div>
                <div className="rounded-lg bg-gray-50 p-3"><span className="text-gray-500">Skipped (no cost)</span><br /><strong className="text-amber-600">{preview.skippedMissingCost}</strong></div>
                <div className="rounded-lg bg-gray-50 p-3"><span className="text-gray-500">Skipped (has sell price)</span><br /><strong className="text-amber-600">{preview.skippedExistingSell}</strong></div>
              </div>

              {preview.preview.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 text-left">
                      <tr><th className="px-3 py-2 font-medium text-gray-500">Plan</th><th className="px-3 py-2 font-medium text-gray-500">Current</th><th className="px-3 py-2 font-medium text-gray-500">New</th></tr>
                    </thead>
                    <tbody>
                      {preview.preview.slice(0, 10).map((p: any) => (
                        <tr key={p.providerPackageId} className="border-t border-gray-100">
                          <td className="px-3 py-2 text-gray-900 truncate max-w-[200px]">{p.name}</td>
                          <td className="px-3 py-2 text-gray-500">{p.currentSell != null ? `$${p.currentSell}` : '—'}</td>
                          <td className="px-3 py-2 font-medium text-emerald-600">${p.newSell}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button onClick={() => setPreview(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">Cancel</button>
                <button onClick={handleApply} disabled={applying || preview.willUpdate === 0}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                  {applying ? 'Applying...' : `Apply to ${preview.willUpdate} Plans`}
                </button>
              </div>
            </div>
          )}

          {result && (
            <div className="mt-4">
              <div className={`rounded-lg p-3 text-sm ${result.error ? 'border border-red-200 bg-red-50 text-red-800' : 'border border-green-200 bg-green-50 text-green-800'}`}>
                {result.error ? result.error : `${result.applied} plans updated. ${result.errors?.length || 0} errors.`}
              </div>
              <div className="mt-3 flex justify-end">
                <button onClick={() => { setOpen(false); setPreview(null); setResult(null); if (!result.error) window.location.reload() }}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
