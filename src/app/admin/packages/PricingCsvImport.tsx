'use client'

import { useState, useRef } from 'react'

export default function PricingCsvImport() {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<any>(null)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<any>(null)
  const formRef = useRef<HTMLFormElement>(null)

  async function handlePreview(formData: FormData) {
    setPreview(null)
    setResult(null)
    try {
      const { importPricingCsvPreview } = await import('@/lib/actions/pricing-csv')
      const res = await importPricingCsvPreview(formData)
      setPreview(res)
    } catch (e: any) {
      setPreview({ error: e.message || 'Preview failed' })
    }
  }

  async function handleApply() {
    if (!formRef.current) return
    setApplying(true)
    setResult(null)
    try {
      const { applyPricingCsvImport } = await import('@/lib/actions/pricing-csv')
      const fd = new FormData(formRef.current)
      const res = await applyPricingCsvImport(fd)
      setResult(res)
      setPreview(null)
    } catch (e: any) {
      setResult({ error: e.message || 'Import failed' })
    } finally {
      setApplying(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm"
      >
        Import Pricing CSV
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!applying) setOpen(false); setPreview(null); setResult(null) }}>
          <div className="w-full max-w-2xl rounded-xl bg-white p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-4">Import Pricing CSV</h3>

            {!preview && !result && (
              <form ref={formRef} action={handlePreview}>
                <p className="text-sm text-gray-500 mb-4">
                  Upload a CSV exported from this system. Only <strong>costPriceUSD, costCurrency, sellingPrice, sellingCurrency, markupPercent, isActive, hiddenFromCatalog</strong> columns will be updated. Other columns are ignored. Rows with errors are skipped.
                </p>
                <input
                  type="file"
                  name="file"
                  accept=".csv"
                  required
                  className="block w-full rounded-lg border border-gray-300 bg-gray-50 p-3 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
                />
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" onClick={() => { setOpen(false); setPreview(null); setResult(null) }} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                    Cancel
                  </button>
                  <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                    Preview Import
                  </button>
                </div>
              </form>
            )}

            {preview && preview.error && (
              <div>
                <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{preview.error}</div>
                <div className="mt-4 flex justify-end">
                  <button onClick={() => { setPreview(null); setResult(null) }} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                    Back
                  </button>
                </div>
              </div>
            )}

            {preview && !preview.error && (
              <div>
                <div className="rounded-lg bg-gray-50 p-4 text-sm space-y-1 mb-4">
                  <p><strong>Total rows:</strong> {preview.totalRows}</p>
                  <p><strong>Valid rows:</strong> {preview.validRows}</p>
                  <p><strong>Rows with changes:</strong> {preview.preview.length}</p>
                  {preview.errors.length > 0 && (
                    <p className="text-red-600"><strong>Errors:</strong> {preview.errors.length}</p>
                  )}
                </div>

                {preview.preview.length > 0 && (
                  <div className="mb-4 max-h-48 overflow-y-auto rounded-lg border border-gray-200">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 text-left">
                        <tr>
                          <th className="px-3 py-2 font-medium text-gray-500">Package</th>
                          <th className="px-3 py-2 font-medium text-gray-500">Changes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.preview.slice(0, 20).map((row: any) => (
                          <tr key={row.packageId} className="border-t border-gray-100">
                            <td className="px-3 py-2 text-gray-900 truncate max-w-[200px]">{row.name}</td>
                            <td className="px-3 py-2 text-gray-600">{Object.keys(row.changes).join(', ')}</td>
                          </tr>
                        ))}
                        {preview.preview.length > 20 && (
                          <tr className="border-t border-gray-100">
                            <td className="px-3 py-2 text-gray-400 italic" colSpan={2}>...and {preview.preview.length - 20} more</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {preview.errors.length > 0 && (
                  <details className="mb-4">
                    <summary className="cursor-pointer text-sm text-red-600 font-medium">Show {preview.errors.length} errors</summary>
                    <div className="mt-2 max-h-32 overflow-y-auto rounded-lg border border-red-100 bg-red-50 p-3">
                      {preview.errors.map((err: any, i: number) => (
                        <p key={i} className="text-xs text-red-700">Line {err.line}: {err.message}</p>
                      ))}
                    </div>
                  </details>
                )}

                <div className="flex justify-end gap-2">
                  <button onClick={() => { setPreview(null); setResult(null) }} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                    Cancel
                  </button>
                  <button
                    onClick={handleApply}
                    disabled={applying || preview.preview.length === 0}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {applying ? 'Applying...' : `Apply ${preview.preview.length} Changes`}
                  </button>
                </div>
              </div>
            )}

            {result && (
              <div>
                <div className={`rounded-lg p-4 text-sm ${result.error ? 'border border-red-200 bg-red-50 text-red-800' : 'border border-green-200 bg-green-50 text-green-800'}`}>
                  {result.error ? result.error : `${result.applied} rows updated. ${result.errors.length} errors.`}
                </div>
                <div className="mt-4 flex justify-end">
                  <button onClick={() => { setOpen(false); setPreview(null); setResult(null); if (!result.error) window.location.reload() }} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                    {result.error ? 'Back' : 'Done'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
