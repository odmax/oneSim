'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { publishAllReady, getReadySummary } from '@/lib/actions/publish-packages'

export function PublishAllReadyButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [summary, setSummary] = useState<any>(null)
  const [result, setResult] = useState<any>(null)

  async function handlePreview() {
    setLoading(true)
    setResult(null)
    try {
      const res = await getReadySummary()
      if (!res || res.totalReady === 0) {
        setResult({ error: 'No ready packages found with valid pricing. Set cost price, selling price, currency, and configuration.', totalReady: 0 })
        setLoading(false)
        return
      }
      setSummary(res)
      setShowConfirm(true)
    } catch (e: any) {
      setResult({ error: e.message || 'Failed to get summary' })
    }
    setLoading(false)
  }

  async function confirmPublish() {
    setShowConfirm(false)
    setSummary(null)
    setLoading(true)
    try {
      const res = await publishAllReady()
      setResult(res)
      router.refresh()
    } catch (e: any) {
      setResult({ error: e.message || 'Publish failed' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={handlePreview}
        disabled={loading}
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 shadow-sm"
      >
        {loading ? 'Loading...' : 'Publish All Ready'}
      </button>

      {showConfirm && summary && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="rounded-xl bg-white p-6 shadow-xl max-w-md w-full mx-4">
            <h3 className="text-lg font-bold text-gray-900 mb-3">Publish All Ready Packages</h3>
            <div className="space-y-2 mb-4 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Total matching (READY/DRAFT + configured):</span><span className="font-medium text-gray-900">{summary.totalMatching}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Publishable:</span><span className="font-medium text-emerald-600">{summary.publishable}</span></div>
              {summary.skipped > 0 && (
                <div className="flex justify-between"><span className="text-gray-500">Skipped:</span><span className="font-medium text-amber-600">{summary.skipped}</span></div>
              )}
              {summary.skippedReasons?.length > 0 && (
                <div className="text-xs text-gray-500 mt-1">
                  Reasons: {summary.skippedReasons.join(', ')}
                </div>
              )}
            </div>
            <p className="text-xs text-gray-400 mb-4">Skipped packages will not be published. Fix their pricing and try again.</p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmPublish}
                disabled={loading}
                className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {loading ? 'Publishing...' : `Publish ${summary.publishable} Packages`}
              </button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div className={`text-xs ${result.error ? 'text-red-600' : 'text-emerald-700'}`}>
          {result.error
            ? result.error
            : result.totalReady != null
              ? `Published: ${result.created ?? 0} new · ${result.updated ?? 0} updated · ${result.skipped ?? 0} skipped`
              : `Done: ${result.created ?? 0} new, ${result.updated ?? 0} updated, ${result.skipped ?? 0} skipped`}
        </div>
      )}
    </div>
  )
}
