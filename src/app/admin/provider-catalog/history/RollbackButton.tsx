'use client'

import { useState } from 'react'
import { rollbackChangeSet } from '@/lib/actions/catalog-history'

export function RollbackButton({ changeSetId, label }: { changeSetId: string; label: string }) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ success?: boolean; rolledBack?: number; skipped?: number; error?: string } | null>(null)

  async function handleRollback() {
    if (!confirm(label)) return
    setLoading(true)
    setResult(null)
    try {
      const res = await rollbackChangeSet(changeSetId)
      setResult(res)
    } catch (e: any) {
      setResult({ success: false, error: e.message || 'Rollback failed' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <span>
      <button type="button" onClick={handleRollback} disabled={loading}
        className="text-xs text-amber-600 hover:text-amber-700 disabled:opacity-50">
        {loading ? 'Rolling back...' : 'Rollback'}
      </button>
      {result && (
        <span className="ml-2 text-xs">
          {result.success !== false ? (
            <span className="text-emerald-600">Reverted {result.rolledBack} package{result.rolledBack !== 1 ? 's' : ''}{result.skipped ? `, ${result.skipped} skipped` : ''}</span>
          ) : (
            <span className="text-red-600">{result.error}</span>
          )}
        </span>
      )}
    </span>
  )
}
