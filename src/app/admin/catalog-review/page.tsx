'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  getReviewDashboardData,
  approveReviewItem,
  rejectReviewItem,
  ignoreReviewItem,
  archiveReviewItem,
  bulkApproveItems,
  bulkRejectItems,
} from '@/lib/actions/catalog-review'

function formatPrice(v: number | null | undefined): string {
  if (v == null) return '—'
  return `$${v.toFixed(2)}`
}

function formatPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${v.toFixed(1)}%`
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-red-100 text-red-700',
  IGNORED: 'bg-gray-100 text-gray-400',
  APPLIED: 'bg-blue-100 text-blue-700',
  FAILED: 'bg-red-100 text-red-700',
}

const CLASS_COLORS: Record<string, string> = {
  NEW: 'bg-cyan-100 text-cyan-700',
  UPDATED: 'bg-blue-100 text-blue-700',
  READY_FOR_REVIEW: 'bg-violet-100 text-violet-700',
  NEEDS_ATTENTION: 'bg-red-100 text-red-700',
  UNCHANGED: 'bg-gray-100 text-gray-400',
}

export default function CatalogReviewPage() {
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({ pending: 0, approved: 0, rejected: 0, ignored: 0 })
  const [items, setItems] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [filter, setFilter] = useState({ status: 'PENDING', search: '', providerId: '', suggestedAction: '' })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set())
  const [confirmAction, setConfirmAction] = useState<{ action: string; count: number } | null>(null)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getReviewDashboardData({
        status: filter.status || undefined,
        search: filter.search || undefined,
        providerId: filter.providerId || undefined,
        suggestedAction: filter.suggestedAction || undefined,
        page,
      })
      setStats(data.stats)
      setItems(data.items)
      setTotal(data.total)
      setTotalPages(data.totalPages)
    } catch (e: any) {
      setFeedback({ type: 'error', message: e.message || 'Failed to load' })
    } finally {
      setLoading(false)
    }
  }, [filter, page])

  useEffect(() => { load() }, [load])

  async function handleSingleAction(itemId: string, action: string) {
    setProcessingIds(prev => new Set(prev).add(itemId))
    setFeedback(null)
    try {
      let result: any
      if (action === 'approve') result = await approveReviewItem(itemId)
      else if (action === 'reject') result = await rejectReviewItem(itemId)
      else if (action === 'ignore') result = await ignoreReviewItem(itemId)
      else result = await archiveReviewItem(itemId)

      if (result.success) {
        setFeedback({ type: 'success', message: result.message })
        load()
      } else {
        setFeedback({ type: 'error', message: result.message })
      }
    } catch (e: any) {
      setFeedback({ type: 'error', message: e.message || 'Action failed' })
    } finally {
      setProcessingIds(prev => { const next = new Set(prev); next.delete(itemId); return next })
    }
  }

  async function executeBulk(action: string) {
    if (!confirmAction) return
    setConfirmAction(null)
    setFeedback(null)
    try {
      let result: any
      if (action === 'approve') result = await bulkApproveItems(Array.from(selectedIds))
      else result = await bulkRejectItems(Array.from(selectedIds))
      setFeedback({ type: 'success', message: `${result.successCount} successful, ${result.failureCount} failed` })
      setSelectedIds(new Set())
      load()
    } catch (e: any) {
      setFeedback({ type: 'error', message: e.message || 'Bulk action failed' })
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(items.map((i: any) => i.id)))
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Catalog Review Center</h1>
          <p className="text-sm text-gray-500 mt-1">Review and approve pipeline recommendations</p>
        </div>
      </div>

      {feedback && (
        <div className={`rounded-lg p-4 text-sm flex items-center gap-2 ${feedback.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {feedback.type === 'success' ? '✓' : '✕'} {feedback.message}
          <button onClick={() => setFeedback(null)} className="ml-auto text-xs opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: 'Pending Review', value: stats.pending, color: 'amber' },
          { label: 'Approved', value: stats.approved, color: 'emerald' },
          { label: 'Rejected', value: stats.rejected, color: 'red' },
          { label: 'Ignored', value: stats.ignored, color: 'gray' },
        ].map(s => (
          <button
            key={s.label}
            onClick={() => { setFilter(prev => ({ ...prev, status: s.label === 'Pending Review' ? 'PENDING' : s.label === 'Approved' ? 'APPROVED' : s.label === 'Rejected' ? 'REJECTED' : 'IGNORED', search: '', providerId: '', suggestedAction: '' })); setPage(1) }}
            className={`rounded-lg border p-3 text-center transition-colors hover:opacity-80 ${filter.status === (s.label === 'Pending Review' ? 'PENDING' : s.label === 'Approved' ? 'APPROVED' : s.label === 'Rejected' ? 'REJECTED' : 'IGNORED') ? 'ring-2 ring-cyan-400' : ''}`}
          >
            <p className="text-2xl font-bold">{s.value}</p>
            <p className="text-xs text-gray-500 mt-1">{s.label}</p>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text" placeholder="Search packages..."
          value={filter.search}
          onChange={e => { setFilter(prev => ({ ...prev, search: e.target.value })); setPage(1) }}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm w-64 focus:border-cyan-500 focus:outline-none"
        />
        <select
          value={filter.status}
          onChange={e => { setFilter(prev => ({ ...prev, status: e.target.value })); setPage(1) }}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
        >
          <option value="">All Statuses</option>
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="IGNORED">Ignored</option>
          <option value="APPLIED">Applied</option>
        </select>
        <select
          value={filter.suggestedAction}
          onChange={e => { setFilter(prev => ({ ...prev, suggestedAction: e.target.value })); setPage(1) }}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
        >
          <option value="">All Actions</option>
          <option value="CONFIGURE">Configure</option>
          <option value="REVIEW_PRICING">Review Pricing</option>
          <option value="SWITCH_PROVIDER">Switch Provider</option>
          <option value="ARCHIVE">Archive</option>
        </select>
      </div>

      {/* Bulk actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg bg-cyan-50 border border-cyan-200 px-4 py-2">
          <span className="text-sm font-medium text-cyan-700">{selectedIds.size} selected</span>
          <button onClick={() => setConfirmAction({ action: 'approve', count: selectedIds.size })} className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">Approve All</button>
          <button onClick={() => setConfirmAction({ action: 'reject', count: selectedIds.size })} className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700">Reject All</button>
          <button onClick={() => setSelectedIds(new Set())} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="rounded-xl bg-white shadow-2xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-bold text-gray-900">Confirm Bulk Action</h3>
            <p className="text-sm text-gray-500 mt-2">
              {confirmAction.action === 'approve' ? 'Approve' : 'Reject'} {confirmAction.count} review item{confirmAction.count !== 1 ? 's' : ''}?
              {confirmAction.action === 'approve' && ' This will apply pricing changes to the selected packages.'}
            </p>
            <div className="flex gap-2 mt-4 justify-end">
              <button onClick={() => setConfirmAction(null)} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
              <button onClick={() => executeBulk(confirmAction.action)} className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${confirmAction.action === 'approve' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}>
                Confirm {confirmAction.action === 'approve' ? 'Approval' : 'Rejection'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50/80 text-[11px] uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" checked={selectedIds.size === items.length && items.length > 0} onChange={toggleSelectAll} className="rounded border-gray-300" />
                </th>
                <th className="px-3 py-2 text-left">Package</th>
                <th className="px-3 py-2 text-left">Classification</th>
                <th className="px-3 py-2 text-right">Current</th>
                <th className="px-3 py-2 text-right">Proposed</th>
                <th className="px-3 py-2 text-left">Provider</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={8} className="px-3 py-12 text-center text-gray-400">Loading...</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-12 text-center text-gray-400">No review items found</td></tr>
              ) : items.map((item: any) => (
                <tr key={item.id} className={`hover:bg-gray-50/50 ${item.isStale ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      onChange={() => toggleSelect(item.id)}
                      disabled={item.reviewStatus !== 'PENDING'}
                      className="rounded border-gray-300"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-sm font-medium text-gray-900 truncate max-w-[180px]">{item.packageName}</div>
                    {item.providerName && <div className="text-xs text-gray-400">{item.providerName}</div>}
                    {item.reason && <div className="text-xs text-gray-500 mt-0.5">{item.reason}</div>}
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${CLASS_COLORS[item.classification] || 'bg-gray-100 text-gray-500'}`}>
                      {item.classification?.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-xs text-gray-700">{formatPrice(item.currentSellingPrice)}</td>
                  <td className="px-3 py-3 text-right font-mono text-xs text-gray-900 font-semibold">{formatPrice(item.proposedSellingPrice)}</td>
                  <td className="px-3 py-3 text-xs text-gray-500">
                    {item.currentProviderName && <div>{item.currentProviderName}</div>}
                    {item.recommendedProviderName && item.recommendedProviderName !== item.currentProviderName && (
                      <div className="text-amber-600">→ {item.recommendedProviderName}</div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-center">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLORS[item.reviewStatus] || 'bg-gray-100 text-gray-500'}`}>
                      {item.reviewStatus}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    {item.reviewStatus === 'PENDING' ? (
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => handleSingleAction(item.id, 'approve')}
                          disabled={processingIds.has(item.id)}
                          className="rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {processingIds.has(item.id) ? '...' : 'Approve'}
                        </button>
                        <button
                          onClick={() => handleSingleAction(item.id, 'reject')}
                          disabled={processingIds.has(item.id)}
                          className="rounded-md bg-red-100 px-2 py-1 text-[10px] font-medium text-red-700 hover:bg-red-200 disabled:opacity-50"
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => handleSingleAction(item.id, 'ignore')}
                          disabled={processingIds.has(item.id)}
                          className="rounded-md bg-gray-100 px-2 py-1 text-[10px] font-medium text-gray-500 hover:bg-gray-200 disabled:opacity-50"
                        >
                          Ignore
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">{item.reviewStatus}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t bg-gray-50/50">
            <span className="text-xs text-gray-500">{total} items</span>
            <div className="flex gap-1">
              {Array.from({ length: totalPages }, (_, i) => (
                <button
                  key={i}
                  onClick={() => setPage(i + 1)}
                  className={`rounded-md px-3 py-1 text-xs font-medium ${page === i + 1 ? 'bg-cyan-600 text-white' : 'bg-white text-gray-600 border hover:bg-gray-50'}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
