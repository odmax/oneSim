'use client'

import { useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { getStablePlanId } from '@/lib/providers/plan-utils'
import type { ImportResult } from '@/lib/providers/plan-utils'

type PlanImportStatus = 'not_imported' | 'already_imported' | 'importing' | 'imported' | 'failed' | 'skipped'

interface ImportablePlan {
  id: string
  name: string
  data_gb: number
  validity_days: number
  price_usd: number
  description?: string
  sku?: string
  templateVersion?: string
  raw_data?: any
  [key: string]: any
}

interface PlanImportTableProps {
  plans: ImportablePlan[]
  importedPlanIds: Set<string>
  importedPackages: Array<{ id: string; providerPlanId: string | null; isActive: boolean; name: string; sku: string | null; packageCode: string | null; dataGB: number; costPriceUSD: any; priceUSD: any }>
  providerId: string
  providerName: string
}

export function PlanImportTable({ plans, importedPlanIds, importedPackages, providerId, providerName }: PlanImportTableProps) {
  const router = useRouter()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [importStatuses, setImportStatuses] = useState<Record<string, PlanImportStatus>>({})
  const [importReasons, setImportReasons] = useState<Record<string, string>>({})
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importSummary, setImportSummary] = useState<{ imported: number; skipped: number; failed: number; errors: Array<{ planName: string; sku: string; reason: string }> } | null>(null)

  const getStableId = useCallback((plan: ImportablePlan): string => {
    return getStablePlanId(plan) || plan.sku || plan.id || Math.random().toString(36).slice(2, 8)
  }, [])

  const plansWithId = useMemo(() => {
    return plans.map(p => ({ ...p, _stableId: getStableId(p) }))
  }, [plans, getStableId])

  const getInitialStatus = useCallback((stableId: string, plan?: ImportablePlan): PlanImportStatus => {
    if (!plan) {
      for (const p of plans) {
        if (getStableId(p) === stableId) { plan = p; break }
      }
    }
    if (!plan) return 'not_imported'
    const pid = plan.providerPlanId || plan.id
    return importedPlanIds.has(String(pid)) ? 'already_imported' : 'not_imported'
  }, [plans, importedPlanIds, getStableId])

  const allSelected = plansWithId.length > 0 && plansWithId.every(p => selectedIds.has(p._stableId))
  const someSelected = plansWithId.some(p => selectedIds.has(p._stableId))

  const stableToPlan = useMemo(() => {
    const map = new Map<string, ImportablePlan>()
    for (const p of plansWithId) map.set(p._stableId, p)
    return map
  }, [plansWithId])

  const selectablePlans = useMemo(() => {
    return plansWithId.filter(p => {
      const s = importStatuses[p._stableId] || getInitialStatus(p._stableId, p)
      return s !== 'already_imported'
    })
  }, [plansWithId, importStatuses, getInitialStatus])

  const toggleSelect = (stableId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(stableId)) next.delete(stableId)
      else next.add(stableId)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      const ids = new Set<string>()
      for (const p of selectablePlans) ids.add(p._stableId)
      setSelectedIds(ids)
    }
  }

  const doImportPlans = async (targetPlans: ImportablePlan[]) => {
    if (importing || targetPlans.length === 0) return
    setImporting(true)
    setImportError(null)
    setImportSummary(null)

    const localStableToPlan: Map<string, ImportablePlan> = new Map()
    const newStatuses: Record<string, PlanImportStatus> = {}
    // Attach _clientId to each plan so server can echo it back for reliable matching
    const plansWithClientId = targetPlans.map(p => {
      const sid = getStableId(p)
      localStableToPlan.set(sid, p)
      newStatuses[sid] = 'importing'
      return { ...p, _clientId: sid }
    })
    setImportStatuses(prev => ({ ...prev, ...newStatuses }))

    try {
      const res = await fetch('/api/admin/providers/import-plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, plans: plansWithClientId }),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error')
        throw new Error(`HTTP ${res.status}: ${errText}`)
      }
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      const results: ImportResult[] = data.results || []

      const planIdToStable: Record<string, string> = {}
      for (const [sid, p] of localStableToPlan) {
        const pid = p.providerPlanId || p.id || p.sku || sid
        planIdToStable[pid] = sid
      }

      const afterStatuses: Record<string, PlanImportStatus> = {}
      const afterReasons: Record<string, string> = {}
      let importedCount = 0
      let skippedCount = 0
      let failedCount = 0
      const firstErrors: Array<{ planName: string; sku: string; reason: string }> = []

      for (const r of results) {
        // Match by _clientId first (reliable), then by planId lookup
        const sid = r._clientId || planIdToStable[r.planId] || r.planId
        if (r.success) {
          if (r.reason === 'updated') {
            afterStatuses[sid] = 'skipped'
            skippedCount++
          } else {
            afterStatuses[sid] = 'imported'
            importedCount++
          }
        } else {
          afterStatuses[sid] = 'failed'
          afterReasons[sid] = r.reason || 'Unknown error'
          failedCount++
          if (firstErrors.length < 5) {
            firstErrors.push({ planName: r.planName, sku: r.planId, reason: r.reason || 'Unknown error' })
          }
        }
      }

      for (const [sid] of localStableToPlan) {
        if (!afterStatuses[sid]) {
          afterStatuses[sid] = 'failed'
          afterReasons[sid] = 'No result returned from server'
          failedCount++
          const plan = localStableToPlan.get(sid)
          if (firstErrors.length < 5 && plan) {
            firstErrors.push({ planName: plan.name, sku: plan.sku || plan.id, reason: 'No result returned from server' })
          }
        }
      }

      setImportStatuses(prev => ({ ...prev, ...afterStatuses }))
      setImportReasons(prev => ({ ...prev, ...afterReasons }))
      setImportSummary({ imported: importedCount, skipped: skippedCount, failed: failedCount, errors: firstErrors })
      setSelectedIds(new Set())

      router.refresh()
    } catch (err: any) {
      const failed: Record<string, PlanImportStatus> = {}
      const reasons: Record<string, string> = {}
      for (const [sid, p] of localStableToPlan) {
        failed[sid] = 'failed'
        reasons[sid] = err.message || 'Import failed'
      }
      setImportStatuses(prev => ({ ...prev, ...failed }))
      setImportReasons(prev => ({ ...prev, ...reasons }))
      setImportError(err.message || 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  const doImportSelected = () => {
    const target = []
    for (const p of plansWithId) {
      const s = importStatuses[p._stableId] || getInitialStatus(p._stableId, p)
      if (selectedIds.has(p._stableId) && s !== 'already_imported') {
        target.push(p)
      }
    }
    doImportPlans(target)
  }

  const doImportAll = () => {
    const target = []
    for (const p of plansWithId) {
      const s = importStatuses[p._stableId] || getInitialStatus(p._stableId, p)
      if (s === 'not_imported' || s === 'failed') {
        target.push(p)
      }
    }
    doImportPlans(target)
  }

  const resolvedStatus = (plan: ImportablePlan): PlanImportStatus => {
    const stableId = getStableId(plan)
    return importStatuses[stableId] || getInitialStatus(stableId, plan)
  }

  const statusDisplay = (plan: ImportablePlan): { label: string; cls: string; title?: string } => {
    const st = resolvedStatus(plan)
    const stableId = getStableId(plan)
    switch (st) {
      case 'already_imported': {
        const pid = plan.providerPlanId || plan.id
        const existing = importedPackages.find(p => p.providerPlanId === pid)
        if (existing?.isActive) return { label: 'Active', cls: 'bg-green-100 text-green-800' }
        return { label: 'Imported (Inactive)', cls: 'bg-yellow-100 text-yellow-800' }
      }
      case 'importing': return { label: 'Importing...', cls: 'bg-blue-100 text-blue-800' }
      case 'imported': return { label: 'Imported ✓', cls: 'bg-green-100 text-green-800' }
      case 'skipped': return { label: 'Already Imported', cls: 'bg-yellow-100 text-yellow-800' }
      case 'failed': {
        const reason = importReasons[stableId] || ''
        const shortReason = reason.length > 60 ? reason.substring(0, 60) + '…' : reason
        return { label: 'Failed ✗', cls: 'bg-red-100 text-red-800', title: reason || undefined }
      }
      default: return { label: 'Not Imported', cls: 'bg-gray-100 text-gray-600' }
    }
  }

  const newImported = plansWithId.filter(p => importStatuses[p._stableId] === 'imported').length
  const newFailed = plansWithId.filter(p => importStatuses[p._stableId] === 'failed').length
  const alreadyCount = plansWithId.filter(p => (importStatuses[p._stableId] || getInitialStatus(p._stableId, p)) === 'already_imported').length
  const pendingCount = plansWithId.filter(p => (importStatuses[p._stableId] || getInitialStatus(p._stableId, p)) === 'not_imported').length
  const reimportableCount = newFailed

  const rawKeys = plans.length > 0 && (plans[0].id === undefined || plans[0].id === null) ? Object.keys(plans[0]) : null

  return (
    <div>
      {/* Import summary */}
      {importSummary && !importing && (
        <div className="mb-3 rounded border border-blue-200 bg-blue-50 p-3 text-xs">
          <div className="mb-1 font-semibold text-blue-800">Import Results</div>
          <div className="flex flex-wrap gap-3 text-blue-700">
            <span>Imported: {importSummary.imported}</span>
            <span>Skipped (already exists): {importSummary.skipped}</span>
            <span>Failed: {importSummary.failed}</span>
          </div>
          {importSummary.errors.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 font-medium text-red-700">Errors:</div>
              {importSummary.errors.map((e, i) => (
                <div key={i} className="text-red-600">
                  {e.planName} ({e.sku}): {e.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Summary bar */}
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-gray-600">
        <span className="font-medium text-gray-800">{plansWithId.length} total</span>
        {alreadyCount > 0 && <span className="rounded bg-yellow-50 px-2 py-0.5 text-yellow-700">{alreadyCount} already imported</span>}
        {newImported > 0 && <span className="rounded bg-green-50 px-2 py-0.5 text-green-700">{newImported} imported</span>}
        {newFailed > 0 && <span className="rounded bg-red-50 px-2 py-0.5 text-red-700">{newFailed} failed</span>}
        {pendingCount > 0 && <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-700">{pendingCount} pending</span>}
        {reimportableCount > 0 && <span className="rounded bg-orange-50 px-2 py-0.5 text-orange-700">{reimportableCount} retry available</span>}
      </div>

      {/* Bulk actions */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className="rounded border-gray-300" />
          Select All ({selectablePlans.length} importable)
        </label>
        <button
          type="button"
          onClick={doImportSelected}
          disabled={!someSelected || importing}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Import Selected ({selectedIds.size})
        </button>
        <button
          type="button"
          onClick={doImportAll}
          disabled={(pendingCount + reimportableCount) === 0 || importing}
          className="rounded bg-cyan-600 px-3 py-1 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
        >
          Import All ({pendingCount + reimportableCount})
        </button>
        {importing && <span className="text-xs text-blue-600">Importing...</span>}
      </div>

      {importError && !importing && (
        <div className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          Import error: {importError}
          <button onClick={() => setImportError(null)} className="ml-2 font-semibold underline">Dismiss</button>
        </div>
      )}

      {rawKeys && (
        <div className="mb-3 text-xs text-orange-600">
          Warning: plans use non-standard key names. Raw data keys: {rawKeys.join(', ')}
        </div>
      )}

      {/* Plans table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="w-10 px-2 py-2 text-left"></th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">SKU / Code</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Name</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Data</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Validity</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Cost Price</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Version</th>
              <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {plansWithId.map(p => {
              const plan = p as ImportablePlan
              const stableId = p._stableId
              const isChecked = selectedIds.has(stableId)
              const st = statusDisplay(plan)
              const isDisabled = importing || st.label === 'Active' || st.label === 'Imported (Inactive)' || st.label === 'Already Imported'
              return (
                <tr key={stableId} className={`hover:bg-gray-50 ${importStatuses[stableId] === 'imported' ? 'bg-green-50' : ''} ${importStatuses[stableId] === 'failed' ? 'bg-red-50' : ''}`}>
                  <td className="px-2 py-3 text-sm">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleSelect(stableId)}
                      disabled={isDisabled}
                      className="rounded border-gray-300"
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <span className="font-mono text-purple-700">{plan.sku || plan.id}</span>
                    {plan.id !== (plan.sku || plan.id) && <span className="ml-1 text-xs text-gray-400">({plan.id})</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">{plan.name}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">{plan.data_gb}GB</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">{plan.validity_days} days</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">${plan.price_usd}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-gray-400">{plan.templateVersion || '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${st.cls}`} title={st.title}>{st.label}</span>
                    {st.title && importStatuses[stableId] === 'failed' && (
                      <div className="mt-1 max-w-[200px] truncate text-[10px] text-red-500" title={st.title}>
                        {st.title}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
