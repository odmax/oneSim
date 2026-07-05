'use client'

import { useState } from 'react'
import { bulkConfigurePackages } from '@/lib/actions/bulk-configure'
import { publishToCatalog, bulkSetPublishStatus, getPublishSummary } from '@/lib/actions/publish-packages'
import { applyRulesToPackages } from '@/lib/actions/package-rules'
import { resetPricing } from '@/lib/actions/reset-pricing'
import Link from 'next/link'

const PUBLISH_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  READY: 'bg-blue-100 text-blue-700',
  PUBLISHED: 'bg-emerald-100 text-emerald-700',
  HIDDEN: 'bg-amber-100 text-amber-700',
  ARCHIVED: 'bg-red-100 text-red-600',
}

const CONFIG_COLORS: Record<string, string> = {
  UNCONFIGURED: 'bg-gray-100 text-gray-600',
  PARTIAL: 'bg-amber-100 text-amber-700',
  CONFIGURED: 'bg-blue-100 text-blue-700',
  AUTO_CONFIGURED: 'bg-emerald-100 text-emerald-700',
}

interface Package {
  id: string
  providerId: string
  providerPlanId: string
  providerPlanCode: string | null
  name: string
  dataGB: number
  validityDays: number
  costPrice: { toString(): string }
  currency: string
  country: string | null
  region: string | null
  sellingPrice: { toString(): string } | null
  markupPercent: { toString(): string } | null
  configurationStatus: string | null
  publishStatus: string | null
  provider: { id: string; name: string; code: string } | null
}

export function BulkConfigTable({ initialPackages, total, page, totalPages }: {
  initialPackages: Package[]
  total: number
  page: number
  totalPages: number
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [publishLoading, setPublishLoading] = useState(false)
  const [rulesLoading, setRulesLoading] = useState(false)
  const [publishSummary, setPublishSummary] = useState<any>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const [result, setResult] = useState<{ success?: boolean; updated?: number; created?: number; skipped?: number; error?: string } | null>(null)

  // Form state
  const [costPrice, setCostPrice] = useState('')
  const [sellingPrice, setSellingPrice] = useState('')
  const [markupPercent, setMarkupPercent] = useState('')
  const [pricingMode, setPricingMode] = useState('')
  const [sellingCurrency, setSellingCurrency] = useState('')
  const [publishStatus, setPublishStatus] = useState('')
  const [configurationStatus, setConfigurationStatus] = useState('')
  const [tags, setTags] = useState('')
  const [notes, setNotes] = useState('')

  const toggleAll = () => {
    if (selected.size === initialPackages.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(initialPackages.map(p => p.id)))
    }
  }

  const toggleOne = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const handleApplyRules = async () => {
    setRulesLoading(true)
    setResult(null)
    const res = await applyRulesToPackages(undefined)
    setResult({ success: res.success, created: res.matched, updated: 0, skipped: 0, error: res.error })
    if (res.success) {
      setTimeout(() => window.location.reload(), 1500)
    }
    setRulesLoading(false)
  }

  const handlePublish = async () => {
    if (selected.size === 0) return

    // First show summary
    const summary = await getPublishSummary(Array.from(selected))
    if (!summary || summary.total === 0) {
      setResult({ success: false, error: 'No publishable packages selected. Ensure selling price is set and status is configured.' })
      return
    }
    setPublishSummary(summary)
    setShowConfirm(true)
  }

  const confirmPublish = async () => {
    setPublishLoading(true)
    setShowConfirm(false)
    setPublishSummary(null)
    const res = await publishToCatalog(Array.from(selected))
    setResult({ success: res.success, created: res.created, updated: res.updated, skipped: res.skipped, error: res.error })
    if (res.success) {
      setSelected(new Set())
      setTimeout(() => window.location.reload(), 2000)
    }
    setPublishLoading(false)
  }

  const handleResetPricing = async () => {
    if (selected.size === 0) return
    if (!confirm(`Reset pricing for ${selected.size} packages? This will clear selling prices, markups, and configuration status.`)) return
    const res = await resetPricing(Array.from(selected))
    setResult(res as any)
    if (res.success) { setSelected(new Set()); setTimeout(() => window.location.reload(), 1500) }
  }

  const handleBulkHide = async () => {
    if (selected.size === 0) return
    const res = await bulkSetPublishStatus(Array.from(selected), 'HIDDEN')
    setResult(res)
    if (res.success) { setSelected(new Set()); setTimeout(() => window.location.reload(), 1500) }
  }

  const handleBulkArchive = async () => {
    if (selected.size === 0) return
    if (!confirm(`Archive ${selected.size} packages? They will be hidden from all views.`)) return
    const res = await bulkSetPublishStatus(Array.from(selected), 'ARCHIVED')
    setResult(res)
    if (res.success) { setSelected(new Set()); setTimeout(() => window.location.reload(), 1500) }
  }

  const handleSubmit = async () => {
    if (selected.size === 0) return
    setLoading(true)
    setResult(null)

    const params: any = { packageIds: Array.from(selected) }
    if (costPrice) params.costPrice = parseFloat(costPrice)
    if (sellingPrice) params.sellingPrice = parseFloat(sellingPrice)
    if (markupPercent) params.markupPercent = parseFloat(markupPercent)
    if (pricingMode) params.pricingMode = pricingMode
    if (sellingCurrency) params.sellingCurrency = sellingCurrency
    if (publishStatus) params.publishStatus = publishStatus
    if (configurationStatus) params.configurationStatus = configurationStatus
    if (tags) params.tags = tags.split(',').map(s => s.trim()).filter(Boolean)
    if (notes) params.notes = notes

    const res = await bulkConfigurePackages(params)
    setResult(res)

    if (res.success) {
      setSelected(new Set())
      setShowForm(false)
      setTimeout(() => window.location.reload(), 1500)
    }
    setLoading(false)
  }

  return (
    <div>
      {/* Result alert */}
      {result && (
        <div className={`mb-4 rounded-lg p-4 text-sm ${result.success ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {result.created != null
            ? `Published ${result.created} new, ${result.updated || 0} updated${result.skipped ? `, ${result.skipped} skipped` : ''}. Refreshing...`
            : result.success ? `Updated ${result.updated} packages. Refreshing...` : result.error}
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="mb-4 rounded-lg bg-cyan-50 border border-cyan-200 p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-cyan-800">{selected.size} selected</span>
            <div className="flex gap-1 flex-wrap">
              <button onClick={() => setShowForm(!showForm)}
                className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700">
                Configure
              </button>
              <button onClick={handlePublish} disabled={publishLoading}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                {publishLoading ? 'Publishing...' : 'Publish'}
              </button>
              <button onClick={handleApplyRules} disabled={rulesLoading}
                className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50">
                {rulesLoading ? 'Applying...' : 'Apply Rules'}
              </button>
              <button onClick={handleBulkHide}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700">
                Hide
              </button>
              <button onClick={handleBulkArchive}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">
                Archive
              </button>
              <button onClick={handleResetPricing}
                className="rounded-lg bg-gray-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700">
                Reset
              </button>
            </div>
            <button onClick={() => setSelected(new Set())}
              className="ml-auto rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Publish Confirmation Modal */}
      {showConfirm && publishSummary && (
        <div className="mb-4 rounded-xl border-2 border-emerald-300 bg-emerald-50 p-5 shadow-lg">
          <h3 className="text-base font-bold text-emerald-800 mb-3">Confirm Publish</h3>
          <div className="grid gap-3 sm:grid-cols-2 mb-4">
            <div className="rounded-lg bg-white p-3">
              <p className="text-xs text-gray-500">Packages ready</p>
              <p className="text-xl font-bold text-gray-900">{publishSummary.total}</p>
            </div>
            <div className="rounded-lg bg-white p-3">
              <p className="text-xs text-gray-500">Providers affected</p>
              <p className="text-xl font-bold text-gray-900">{publishSummary.providers}</p>
              <p className="text-[10px] text-gray-400 truncate">{publishSummary.providerNames}</p>
            </div>
            <div className="rounded-lg bg-white p-3">
              <p className="text-xs text-gray-500">Countries</p>
              <p className="text-xl font-bold text-gray-900">{publishSummary.countries}</p>
              <p className="text-[10px] text-gray-400 truncate">{publishSummary.countryNames}</p>
            </div>
            <div className="rounded-lg bg-white p-3">
              <p className="text-xs text-gray-500">Price Range</p>
              <p className="text-xl font-bold text-gray-900">${publishSummary.minPrice.toFixed(2)} — ${publishSummary.maxPrice.toFixed(2)}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={confirmPublish} disabled={publishLoading}
              className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              {publishLoading ? 'Publishing...' : `Publish ${publishSummary.total} packages`}
            </button>
            <button onClick={() => { setShowConfirm(false); setPublishSummary(null) }}
              className="rounded-lg border border-gray-200 px-5 py-2 text-sm text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Configure Form Panel */}
      {showForm && (
        <div className="mb-4 rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Configure {selected.size} Packages</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Cost Price</label>
              <input type="number" step="0.01" value={costPrice} onChange={e => setCostPrice(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" placeholder="e.g. 1.50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Selling Price</label>
              <input type="number" step="0.01" value={sellingPrice} onChange={e => setSellingPrice(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" placeholder="e.g. 3.00" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Markup %</label>
              <input type="number" step="0.01" value={markupPercent} onChange={e => setMarkupPercent(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" placeholder="e.g. 30" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Pricing Mode</label>
              <select value={pricingMode} onChange={e => setPricingMode(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
                <option value="">No change</option>
                <option value="MARKUP_PERCENT">Markup %</option>
                <option value="FIXED_PRICE">Fixed Price</option>
                <option value="FIXED_MARGIN">Fixed Margin</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Currency</label>
              <select value={sellingCurrency} onChange={e => setSellingCurrency(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
                <option value="">No change</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Publish Status</label>
              <select value={publishStatus} onChange={e => setPublishStatus(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
                <option value="">No change</option>
                <option value="DRAFT">Draft</option>
                <option value="READY">Ready</option>
                <option value="HIDDEN">Hidden</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Config Status</label>
              <select value={configurationStatus} onChange={e => setConfigurationStatus(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
                <option value="">No change</option>
                <option value="CONFIGURED">Configured</option>
                <option value="PARTIAL">Partial</option>
                <option value="AUTO_CONFIGURED">Auto Configured</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Tags (comma separated)</label>
              <input type="text" value={tags} onChange={e => setTags(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" placeholder="e.g. popular, sale" />
            </div>
          </div>
          <div className="mt-4">
            <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" rows={2} placeholder="Optional notes..." />
          </div>
          <div className="mt-4 flex gap-3">
            <button onClick={handleSubmit} disabled={loading}
              className="rounded-lg bg-cyan-600 px-5 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
              {loading ? 'Applying...' : `Apply to ${selected.size} packages`}
            </button>
            <button onClick={() => setShowForm(false)}
              className="rounded-lg border border-gray-200 px-5 py-2 text-sm text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="flex items-center gap-2 px-4 py-2 border-b">
        <button onClick={handleApplyRules} disabled={rulesLoading}
          className="rounded-lg bg-purple-600 px-3 py-1 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50">
          {rulesLoading ? 'Applying...' : 'Apply Rules to Unconfigured'}
        </button>
        <span className="text-xs text-gray-400">Auto-configure all unconfigured packages using active rules</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-3 w-10">
                <input type="checkbox" onChange={toggleAll} checked={selected.size === initialPackages.length && initialPackages.length > 0}
                  className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Provider</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Plan ID / Code</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Name</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Country</th>
              <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Data</th>
              <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Validity</th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase text-gray-500">Cost</th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase text-gray-500">Selling</th>
              <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Markup</th>
              <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Config</th>
              <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Publish</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {initialPackages.length === 0 ? (
              <tr><td colSpan={12} className="px-4 py-12 text-center text-sm text-gray-400">No packages found.</td></tr>
            ) : initialPackages.map(pkg => (
              <tr key={pkg.id} className={`hover:bg-gray-50 ${selected.has(pkg.id) ? 'bg-cyan-50' : ''}`}>
                <td className="px-3 py-3">
                  <input type="checkbox" checked={selected.has(pkg.id)} onChange={() => toggleOne(pkg.id)}
                    className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
                </td>
                <td className="px-3 py-3 text-sm text-gray-900">{pkg.provider?.name || '—'}</td>
                <td className="px-3 py-3">
                  <span className="font-mono text-xs text-gray-900">{pkg.providerPlanId}</span>
                  {pkg.providerPlanCode && <span className="block font-mono text-[10px] text-gray-400">{pkg.providerPlanCode}</span>}
                </td>
                <td className="px-3 py-3 text-sm text-gray-900 max-w-[200px] truncate">{pkg.name}</td>
                <td className="px-3 py-3 text-xs text-gray-500">{pkg.country || '—'}{pkg.region ? ` · ${pkg.region}` : ''}</td>
                <td className="px-3 py-3 text-xs text-center text-gray-600">{pkg.dataGB} GB</td>
                <td className="px-3 py-3 text-xs text-center text-gray-600">{pkg.validityDays}d</td>
                <td className="px-3 py-3 text-xs text-right font-medium text-gray-900">${parseFloat(pkg.costPrice.toString()).toFixed(2)}</td>
                <td className="px-3 py-3 text-xs text-right font-medium text-gray-900">
                  {pkg.sellingPrice ? `$${parseFloat(pkg.sellingPrice.toString()).toFixed(2)}` : <span className="text-gray-400">—</span>}
                </td>
                <td className="px-3 py-3 text-xs text-center">
                  {pkg.markupPercent ? (
                    <span className="font-medium text-emerald-600">{parseFloat(pkg.markupPercent.toString())}%</span>
                  ) : <span className="text-gray-400">—</span>}
                </td>
                <td className="px-3 py-3 text-center">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${CONFIG_COLORS[pkg.configurationStatus || 'UNCONFIGURED']}`}>
                    {pkg.configurationStatus || 'UNCONFIGURED'}
                  </span>
                </td>
                <td className="px-3 py-3 text-center">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${PUBLISH_COLORS[pkg.publishStatus || 'DRAFT']}`}>
                    {pkg.publishStatus || 'DRAFT'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
          <span className="text-gray-500">{total} packages · Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={`/admin/provider-catalog?page=${page - 1}`} className="rounded-lg border px-3 py-1 text-gray-600 hover:bg-gray-50">Previous</Link>
            )}
            {page < totalPages && (
              <Link href={`/admin/provider-catalog?page=${page + 1}`} className="rounded-lg border px-3 py-1 text-gray-600 hover:bg-gray-50">Next</Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
