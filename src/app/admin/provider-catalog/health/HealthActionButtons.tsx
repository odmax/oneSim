'use client'

import { useState } from 'react'
import { autoPickAndPublishWinners, publishPreferredOnly } from '@/lib/actions/auto-publish'

export function HealthActionButtons({ hasDuplicates }: { hasDuplicates: boolean }) {
  const [autoPickResult, setAutoPickResult] = useState<{ success?: boolean; published?: number; skipped?: number; skippedReasons?: string[]; error?: string } | null>(null)
  const [prefResult, setPrefResult] = useState<{ success?: boolean; published?: number; error?: string } | null>(null)
  const [autoPickLoading, setAutoPickLoading] = useState(false)
  const [prefLoading, setPrefLoading] = useState(false)

  async function handleAutoPickPublish() {
    setAutoPickLoading(true)
    setAutoPickResult(null)
    try {
      const res = await autoPickAndPublishWinners()
      setAutoPickResult(res || { success: true })
    } catch (e: any) {
      setAutoPickResult({ success: false, error: e.message || 'Auto-pick + publish failed' })
    } finally {
      setAutoPickLoading(false)
    }
  }

  async function handlePublishPreferred() {
    setPrefLoading(true)
    setPrefResult(null)
    try {
      const res = await publishPreferredOnly()
      setPrefResult(res || { success: true })
    } catch (e: any) {
      setPrefResult({ success: false, error: e.message || 'Publish preferred failed' })
    } finally {
      setPrefLoading(false)
    }
  }

  if (!hasDuplicates) return null

  return (
    <div className="flex gap-2 items-center">
      <button type="button" onClick={handleAutoPickPublish} disabled={autoPickLoading}
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
        {autoPickLoading ? 'Working...' : 'Auto-Pick + Publish'}
      </button>
      <button type="button" onClick={handlePublishPreferred} disabled={prefLoading}
        className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50">
        {prefLoading ? 'Working...' : 'Publish Preferred Only'}
      </button>
      {autoPickResult && (
        <span className={`text-xs ${autoPickResult.success !== false ? 'text-emerald-700' : 'text-red-600'}`}>
          {autoPickResult.success !== false
            ? `Published ${autoPickResult.published ?? 0}${autoPickResult.skipped ? `, ${autoPickResult.skipped} skipped` : ''}`
            : autoPickResult.error}
        </span>
      )}
      {prefResult && (
        <span className={`text-xs ${prefResult.success !== false ? 'text-emerald-700' : 'text-red-600'}`}>
          {prefResult.success !== false
            ? `Published ${prefResult.published ?? 0}`
            : prefResult.error}
        </span>
      )}
    </div>
  )
}
