'use client'

import { useState, useEffect } from 'react'
import { getApplyRulePreview, executeApplyRule } from '@/lib/actions/apply-rules-workflow'
import type { ApplyRulePreview, ApplyRuleFilters } from '@/lib/actions/apply-rules-workflow'

interface Rule {
  id: string
  name: string
  priority: number
  isActive: boolean
}

interface ApplyRulePanelProps {
  rules: Rule[]
  selectedIds: string[]
  searchParamsFilters?: Partial<ApplyRuleFilters>
  onClose: () => void
  onApplied: () => void
}

type Scope = 'configured' | 'draft' | 'configured_draft' | 'selected' | 'search'

const SCOPE_LABELS: Record<Scope, string> = {
  configured: 'Configured Plans Only',
  draft: 'Draft Plans Only',
  configured_draft: 'Configured + Draft Plans',
  selected: 'Selected Plans',
  search: 'Current Search Results',
}

const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  configured: 'Plans with configuration status = Configured',
  draft: 'Plans with publish status = Draft',
  configured_draft: 'Both configured and draft plans',
  selected: 'Only the plans you have selected in the table',
  search: 'All plans matching your current search filters',
}

export default function ApplyRulePanel({ rules, selectedIds, searchParamsFilters, onClose, onApplied }: ApplyRulePanelProps) {
  const activeRules = rules.filter(r => r.isActive)

  // Step 1
  const [selectedRuleId, setSelectedRuleId] = useState('')

  // Step 2
  const [scope, setScope] = useState<Scope>('configured')

  // Step 3 — Advanced Filters
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState<ApplyRuleFilters>({
    hasCostPrice: true,
    hasSellingPrice: true,
    includeArchived: false,
    includeHidden: false,
  })

  // Preview state
  const [preview, setPreview] = useState<ApplyRulePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [result, setResult] = useState<{ success: boolean; matched?: number; skipped?: number; error?: string } | null>(null)
  const [error, setError] = useState('')

  // Validation
  const canShowPreview = selectedRuleId && (scope !== 'selected' || selectedIds.length > 0)
  const selectedRule = rules.find(r => r.id === selectedRuleId)

  const handlePreview = async () => {
    if (!canShowPreview) return
    setLoading(true)
    setError('')
    setPreview(null)
    setResult(null)

    const res = await getApplyRulePreview(
      selectedRuleId,
      scope,
      scope === 'search' ? { ...filters, ...searchParamsFilters } : filters,
      scope === 'selected' ? selectedIds : undefined,
    )

    setLoading(false)
    if (res.success && res.data) {
      setPreview(res.data)
    } else {
      setError(res.error || 'Failed to generate preview')
    }
  }

  useEffect(() => {
    if (canShowPreview) {
      handlePreview()
    }
  }, [selectedRuleId, scope])

  const handleApply = async () => {
    if (!selectedRuleId || !preview || preview.matched === 0) return
    setExecuting(true)
    setError('')

    const res = await executeApplyRule(
      selectedRuleId,
      scope,
      scope === 'search' ? { ...filters, ...searchParamsFilters } : filters,
      scope === 'selected' ? selectedIds : undefined,
    )

    setExecuting(false)
    if (res.success) {
      setResult({ success: true, matched: res.matched, skipped: res.skipped })
      setTimeout(() => { onApplied(); onClose() }, 2000)
    } else {
      setResult({ success: false, error: res.error })
    }
  }

  const updateFilter = (key: keyof ApplyRuleFilters, value: any) => {
    setFilters(prev => ({ ...prev, [key]: value }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-12 bg-black/30" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-2xl border max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Apply Rule</h2>
            <p className="text-sm text-gray-500">Choose a rule and where to apply it</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">&times;</button>
        </div>

        <div className="p-6 space-y-6">
          {/* Step 1: Select Rule */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-cyan-600 text-xs font-bold text-white">1</span>
              <h3 className="text-sm font-semibold text-gray-900">Select a Rule</h3>
            </div>
            <select
              value={selectedRuleId}
              onChange={e => { setSelectedRuleId(e.target.value); setPreview(null); setResult(null) }}
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-cyan-500 focus:outline-none"
            >
              <option value="">— Select a rule —</option>
              {activeRules.map(rule => (
                <option key={rule.id} value={rule.id}>
                  {rule.name} (priority {rule.priority})
                </option>
              ))}
            </select>
            {activeRules.length === 0 && (
              <p className="mt-1 text-xs text-amber-600">No active rules available. Create rules in Package Configuration Rules first.</p>
            )}
            {selectedRule && (
              <div className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                {selectedRule.name} &middot; priority {selectedRule.priority}
              </div>
            )}
          </div>

          {/* Step 2: Choose Scope */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-cyan-600 text-xs font-bold text-white">2</span>
              <h3 className="text-sm font-semibold text-gray-900">Where to Apply</h3>
            </div>
            <div className="space-y-2">
              {(['configured', 'draft', 'configured_draft', 'selected', 'search'] as Scope[]).map(s => {
                const disabled = s === 'selected' && selectedIds.length === 0
                return (
                  <label key={s} className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    scope === s ? 'border-cyan-300 bg-cyan-50' : 'border-gray-200 hover:bg-gray-50'
                  } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <input
                      type="radio"
                      name="scope"
                      value={s}
                      checked={scope === s}
                      onChange={() => { setScope(s); setPreview(null); setResult(null) }}
                      disabled={disabled}
                      className="mt-0.5 text-cyan-600 focus:ring-cyan-500"
                    />
                    <div>
                      <span className="text-sm font-medium text-gray-900">{SCOPE_LABELS[s]}</span>
                      <p className="text-xs text-gray-500">{SCOPE_DESCRIPTIONS[s]}</p>
                      {s === 'selected' && (
                        <p className="text-xs text-cyan-600 mt-0.5">{selectedIds.length} plans currently selected</p>
                      )}
                    </div>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Step 3: Advanced Filters */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-400 text-xs font-bold text-white">3</span>
              <h3 className="text-sm font-semibold text-gray-900">Advanced Filters</h3>
              <button
                onClick={() => setShowFilters(!showFilters)}
                className="ml-auto text-xs text-cyan-600 hover:text-cyan-700"
              >
                {showFilters ? 'Hide filters' : 'Show filters'}
              </button>
            </div>
            {showFilters && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Provider</label>
                    <select value={filters.providerId || ''} onChange={e => updateFilter('providerId', e.target.value || undefined)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
                      <option value="">All Providers</option>
                      {rules.length > 0 && <option value="placeholder">(providers loaded per-rule)</option>}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Country</label>
                    <input type="text" value={filters.country || ''} onChange={e => updateFilter('country', e.target.value || undefined)}
                      placeholder="Any country" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Configuration Status</label>
                    <select value={filters.configurationStatus || ''} onChange={e => updateFilter('configurationStatus', e.target.value || undefined)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
                      <option value="">Any</option>
                      <option value="UNCONFIGURED">Unconfigured</option>
                      <option value="PARTIAL">Partial</option>
                      <option value="CONFIGURED">Configured</option>
                      <option value="AUTO_CONFIGURED">Auto Configured</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Publish Status</label>
                    <select value={filters.publishStatus || ''} onChange={e => updateFilter('publishStatus', e.target.value || undefined)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
                      <option value="">Any</option>
                      <option value="DRAFT">Draft</option>
                      <option value="READY">Ready</option>
                      <option value="PUBLISHED">Published</option>
                    </select>
                  </div>
                  <div className="flex flex-wrap gap-4 items-end">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={!!filters.hasCostPrice} onChange={e => updateFilter('hasCostPrice', e.target.checked || undefined)}
                        className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
                      <span className="text-gray-700">Has Cost Price</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={!!filters.hasSellingPrice} onChange={e => updateFilter('hasSellingPrice', e.target.checked || undefined)}
                        className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
                      <span className="text-gray-700">Has Selling Price</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={!filters.includeArchived} onChange={e => updateFilter('includeArchived', !e.target.checked || undefined)}
                        className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
                      <span className="text-gray-700">Exclude Archived</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={!filters.includeHidden} onChange={e => updateFilter('includeHidden', !e.target.checked || undefined)}
                        className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
                      <span className="text-gray-700">Exclude Hidden</span>
                    </label>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Preview */}
          {preview && (
            <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-900">Preview</h3>
              </div>
              <div className="p-4">
                <div className="grid gap-3 sm:grid-cols-3 mb-3">
                  <div className="rounded-lg bg-emerald-50 p-3 text-center">
                    <p className="text-2xl font-bold text-emerald-700">{preview.matched}</p>
                    <p className="text-xs text-emerald-600">Will be updated</p>
                  </div>
                  <div className="rounded-lg bg-amber-50 p-3 text-center">
                    <p className="text-2xl font-bold text-amber-700">{preview.skipped}</p>
                    <p className="text-xs text-amber-600">Will be skipped</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-bold text-gray-700">{preview.totalInScope}</p>
                    <p className="text-xs text-gray-500">Total in scope</p>
                  </div>
                </div>
                {preview.skipReasons.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Skip reasons:</p>
                    <ul className="space-y-1">
                      {preview.skipReasons.map((sr, i) => (
                        <li key={i} className="flex items-center justify-between rounded bg-red-50 px-2.5 py-1.5 text-xs">
                          <span className="text-red-700">{sr.reason}</span>
                          <span className="font-medium text-red-800">{sr.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="text-center py-4 text-sm text-gray-500">Generating preview...</div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
          )}

          {/* Result */}
          {result && (
            <div className={`rounded-lg p-4 text-sm ${result.success ? 'bg-emerald-50 border border-emerald-200 text-emerald-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
              {result.success
                ? `Rule applied: ${result.matched} updated, ${result.skipped} skipped. Refreshing...`
                : result.error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t bg-gray-50 rounded-b-xl">
          <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">
            Cancel
          </button>
          <div className="flex gap-2">
            {preview && (
              <button
                onClick={handleApply}
                disabled={executing || preview.matched === 0}
                className="rounded-lg bg-cyan-600 px-5 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
              >
                {executing ? 'Applying...' : `Apply to ${preview.matched} plans`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
