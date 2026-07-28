'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { getApplyRulePreview, executeApplyRule, getRuleExecutionDetail, simulateRuleApplication } from '@/lib/actions/apply-rules-workflow'
import type { ApplyRulePreview, ApplyRuleFilters } from '@/lib/actions/apply-rules-workflow'
import SimulationPreview from '@/components/admin/pricing/SimulationPreview'
import type { SimulationResult } from '@/lib/pricing/pricing-simulation-service'

interface Rule {
  id: string
  name: string
  providerId: string | null
  country: string | null
  region: string | null
  productType: string | null
  dataMinGB: number | null
  dataMaxGB: number | null
  validityMinDays: number | null
  validityMaxDays: number | null
  costPrice: { toString(): string } | null
  markupPercent: { toString(): string } | null
  fixedPrice: { toString(): string } | null
  sellingCurrency: string
  publishStatus: string | null
  priority: number
  isActive: boolean
}

interface ApplyRuleWizardProps {
  rule: Rule
  open?: boolean
  onClose?: () => void
  onApplied?: () => void
}

type Step = 'review' | 'scope' | 'filters' | 'preview' | 'executing' | 'results'
type Scope = 'unconfigured' | 'configured' | 'draft' | 'all_eligible'

const SCOPE_LABELS: Record<string, string> = {
  unconfigured: 'Unconfigured Plans Only',
  configured: 'Configured Plans Only',
  draft: 'Draft Plans Only',
  all_eligible: 'All Eligible Plans',
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  unconfigured: 'Provider plans that have not yet been configured.',
  configured: 'Plans with completed configuration.',
  draft: 'Configured plans that have not yet been published.',
  all_eligible: 'All unconfigured, configured, and draft plans that can accept this rule.',
}

const defaultFilters: ApplyRuleFilters = {
  configurationStatus: 'CONFIGURED',
  publishStatus: 'DRAFT',
  hasCostPrice: true,
  hasSellingPrice: true,
  includeArchived: false,
  includeHidden: false,
}

export default function ApplyRuleWizard({ rule, onClose, onApplied }: ApplyRuleWizardProps) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('review')
  const [scope, setScope] = useState<Scope>('configured')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [filters, setFilters] = useState<ApplyRuleFilters>({ ...defaultFilters })
  const [preview, setPreview] = useState<ApplyRulePreview | null>(null)
  const [simulation, setSimulation] = useState<SimulationResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [executionResult, setExecutionResult] = useState<any>(null)
  const [executionDetail, setExecutionDetail] = useState<any>(null)
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const router = useRouter()

  const reset = useCallback(() => {
    setStep('review')
    setScope('configured')
    setShowAdvanced(false)
    setFilters({ ...defaultFilters })
    setPreview(null)
    setSimulation(null)
    setLoading(false)
    setError('')
    setExecutionResult(null)
    setExecutionDetail(null)
    setProgress({ current: 0, total: 0 })
  }, [])

  useEffect(() => {
    if (!open) reset()
  }, [open, reset])

  const handlePreview = async () => {
    setLoading(true)
    setError('')
    setPreview(null)
    setSimulation(null)
    const res = await simulateRuleApplication(rule.id, scope, filters)
    setLoading(false)
    if (res.success && res.data) {
      setSimulation(res.data)
      // Build skip reasons from simulation warnings
      const skipReasonMap: Record<string, { count: number; examples: { id: string; name: string }[] }> = {}
      for (const w of res.data.warnings) {
        const reason = `${w.type.replace(/_/g, ' ')}: ${w.packageName}`
        if (!skipReasonMap[w.type]) skipReasonMap[w.type] = { count: 0, examples: [] }
        skipReasonMap[w.type].count++
        if (skipReasonMap[w.type].examples.length < 3) {
          skipReasonMap[w.type].examples.push({ id: w.packageId, name: w.packageName })
        }
      }
      // Also add non-match packages (evaluated but not in packages array)
      const matchedIds = new Set(res.data.packages.map(p => p.packageId))
      const nonMatchCount = res.data.summary.packagesEvaluated - res.data.summary.packagesUpdated - res.data.summary.packagesSkipped
      if (nonMatchCount > 0) {
        skipReasonMap['RULE_MISMATCH'] = { count: nonMatchCount, examples: [] }
      }
      setPreview({
        ruleId: rule.id,
        ruleName: rule.name,
        scope,
        filters,
        matched: res.data.summary.packagesUpdated,
        skipped: res.data.summary.packagesSkipped,
        skipReasons: Object.entries(skipReasonMap).map(([reason, info]) => ({
          reason,
          count: info.count,
          examples: info.examples,
        })),
        totalInScope: res.data.summary.packagesEvaluated,
        estimatedTimeMs: res.data.durationMs,
      })
      setStep('preview')
    } else {
      setError(res.error || 'Failed to generate simulation')
    }
  }

  const handleExecute = async () => {
    setStep('executing')
    setError('')
    setProgress({ current: 0, total: preview?.matched || 0 })

    const res = await executeApplyRule(rule.id, scope, filters)
    if (res.success) {
      setExecutionResult(res)
      setProgress({ current: res.matched || 0, total: (res.matched || 0) + (res.skipped || 0) })
      if (res.executionId) {
        const detail = await getRuleExecutionDetail(res.executionId)
        setExecutionDetail(detail)
      }
      setStep('results')
      router.refresh()
    } else {
      setError(res.error || 'Execution failed')
      setStep('preview')
    }
  }

  const handleOpen = () => {
    setOpen(true)
    setStep('review')
  }

  const handleClose = () => {
    setOpen(false)
    onClose?.()
  }

  const updateFilter = (key: keyof ApplyRuleFilters, value: any) => {
    setFilters(prev => ({ ...prev, [key]: value }))
  }

  function pricingText(r: Rule): string {
    if (r.fixedPrice && parseFloat(r.fixedPrice.toString()) > 0) {
      return `Fixed: $${parseFloat(r.fixedPrice.toString()).toFixed(2)} ${r.sellingCurrency}`
    }
    if (r.markupPercent && parseFloat(r.markupPercent.toString()) > 0) {
      return `Markup: ${parseFloat(r.markupPercent.toString())}%`
    }
    return 'No pricing set'
  }

  function fieldsChanged(r: Rule): string[] {
    const fields: string[] = []
    if (r.fixedPrice || r.markupPercent) fields.push('Selling Price')
    if (r.sellingCurrency) fields.push('Currency')
    if (r.publishStatus) fields.push('Publish Status')
    fields.push('Configuration Status → AUTO_CONFIGURED')
    if (r.costPrice && parseFloat(r.costPrice.toString()) > 0) fields.push('Cost Price')
    return fields
  }

  const estimatedCount = preview?.totalInScope ?? (rule.isActive ? 'All matching' : 0)

  return (
    <>
      <button
        onClick={handleOpen}
        className="rounded-md bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-700 transition-colors shadow-sm"
      >
        Apply
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 bg-black/40 backdrop-blur-sm" onClick={handleClose}>
          <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl border max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b sticky top-0 bg-white z-10 rounded-t-2xl">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  {(['review', 'scope', 'filters', 'preview', 'executing', 'results'] as Step[]).map((s, i) => {
                    const stepOrder = ['review', 'scope', 'filters', 'preview', 'executing', 'results']
                    const idx = stepOrder.indexOf(s)
                    const cur = stepOrder.indexOf(step)
                    return (
                      <div key={s} className={`w-2 h-2 rounded-full transition-colors ${
                        idx <= cur ? 'bg-cyan-500' : 'bg-gray-200'
                      }`} />
                    )
                  })}
                </div>
                <span className="text-xs text-gray-400 font-medium">
                  {step === 'review' && 'Step 1 of 5: Review Rule'}
                  {step === 'scope' && 'Step 2 of 5: Choose Target'}
                  {step === 'filters' && 'Step 3 of 5: Refine'}
                  {step === 'preview' && 'Step 4 of 5: Preview'}
                  {step === 'executing' && 'Applying...'}
                  {step === 'results' && 'Complete'}
                </span>
              </div>
              <button onClick={handleClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* STEP 1: Review */}
              {step === 'review' && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-lg font-bold text-gray-900">{rule.name}</h2>
                    {rule.country || rule.region || rule.productType || rule.dataMinGB != null ? (
                      <p className="text-sm text-gray-500 mt-1">
                        {[rule.country && `Country: ${rule.country}`, rule.region && `Region: ${rule.region}`, rule.productType && `Type: ${rule.productType}`,
                          rule.dataMinGB != null && rule.dataMaxGB != null && `Data: ${rule.dataMinGB}-${rule.dataMaxGB} GB`,
                          rule.validityMinDays != null && rule.validityMaxDays != null && `Validity: ${rule.validityMinDays}-${rule.validityMaxDays}d`,
                        ].filter(Boolean).join(' · ') || 'No specific criteria'}
                      </p>
                    ) : (
                      <p className="text-sm text-gray-400 mt-1">Applies to all plans (no filters set)</p>
                    )}
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="rounded-xl bg-gray-50 border border-gray-100 p-4">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Rule Type</p>
                      <p className="text-sm font-semibold text-gray-900">{rule.productType || 'Any Product'}</p>
                    </div>
                    <div className="rounded-xl bg-gray-50 border border-gray-100 p-4">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Priority</p>
                      <p className="text-sm font-semibold text-gray-900">{rule.priority}</p>
                    </div>
                    <div className="rounded-xl bg-gray-50 border border-gray-100 p-4">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Pricing</p>
                      <p className="text-sm font-semibold text-gray-900">{pricingText(rule)}</p>
                    </div>
                    <div className="rounded-xl bg-gray-50 border border-gray-100 p-4">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Publish Status</p>
                      <p className="text-sm font-semibold text-gray-900">{rule.publishStatus || 'Ready'}</p>
                    </div>
                  </div>

                  <div className="rounded-xl bg-cyan-50 border border-cyan-100 p-4">
                    <p className="text-xs font-medium text-cyan-700 uppercase tracking-wider mb-2">Fields that will change</p>
                    <div className="flex flex-wrap gap-2">
                      {fieldsChanged(rule).map(f => (
                        <span key={f} className="inline-flex items-center rounded-full bg-white px-2.5 py-1 text-xs font-medium text-cyan-700 border border-cyan-200">{f}</span>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl bg-amber-50 border border-amber-100 p-4 flex items-center gap-3">
                    <svg className="w-5 h-5 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                    </svg>
                    <p className="text-sm text-amber-800">
                      This rule will match plans based on provider, country, region, data, and validity criteria. Plans that don&apos;t match will be skipped.
                    </p>
                  </div>
                </div>
              )}

              {/* STEP 2: Scope */}
              {step === 'scope' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-semibold text-gray-900">Where should this rule be applied?</h3>
                    <p className="text-sm text-gray-500 mt-1">Choose which plans this rule should target</p>
                  </div>
                  <div className="space-y-2">
                    {(['unconfigured', 'configured', 'draft', 'all_eligible'] as Scope[]).map(s => (
                      <label key={s} className={`flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-all ${
                        scope === s ? 'border-cyan-300 bg-cyan-50 ring-1 ring-cyan-200' : 'border-gray-200 hover:bg-gray-50 hover:border-gray-300'
                      }`}>
                        <input
                          type="radio"
                          name="scope"
                          value={s}
                          checked={scope === s}
                          onChange={() => setScope(s)}
                          className="mt-0.5 text-cyan-600 focus:ring-cyan-500"
                        />
                        <div>
                          <span className="text-sm font-semibold text-gray-900">{SCOPE_LABELS[s]}</span>
                          <p className="text-xs text-gray-500 mt-0.5">{SCOPE_DESCRIPTIONS[s]}</p>
                        </div>
                      </label>
                    ))}
                  </div>

                  <button
                    onClick={() => { setStep('filters') }}
                    className="text-xs text-cyan-600 hover:text-cyan-700 font-medium flex items-center gap-1"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" /></svg>
                    Advanced filters
                  </button>
                </div>
              )}

              {/* STEP 3: Advanced Filters */}
              {step === 'filters' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-base font-semibold text-gray-900">Refine your target</h3>
                    <p className="text-sm text-gray-500 mt-1">Narrow down which plans this rule should affect</p>
                  </div>

                  <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-5">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Provider</label>
                        <select value={filters.providerId || ''} onChange={e => updateFilter('providerId', e.target.value || undefined)}
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20 bg-white">
                          <option value="">All Providers</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Country</label>
                        <input type="text" value={filters.country || ''} onChange={e => updateFilter('country', e.target.value || undefined)}
                          placeholder="Any country" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20 bg-white" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Region</label>
                        <input type="text" value={filters.region || ''} onChange={e => updateFilter('region', e.target.value || undefined)}
                          placeholder="Any region" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20 bg-white" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Configuration Status</label>
                        <select value={filters.configurationStatus || ''} onChange={e => updateFilter('configurationStatus', e.target.value || undefined)}
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20 bg-white">
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
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20 bg-white">
                          <option value="">Any</option>
                          <option value="DRAFT">Draft</option>
                          <option value="READY">Ready</option>
                          <option value="PUBLISHED">Published</option>
                          <option value="HIDDEN">Hidden</option>
                          <option value="ARCHIVED">Archived</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Plan Requirements</p>
                    <div className="flex flex-wrap gap-3">
                      <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
                        <input type="checkbox" checked={!!filters.hasCostPrice} onChange={e => updateFilter('hasCostPrice', e.target.checked || undefined)}
                          className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
                        <span className="text-sm text-gray-700">Has Cost Price</span>
                      </label>
                      <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
                        <input type="checkbox" checked={!!filters.hasSellingPrice} onChange={e => updateFilter('hasSellingPrice', e.target.checked || undefined)}
                          className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
                        <span className="text-sm text-gray-700">Has Selling Price</span>
                      </label>
                      <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
                        <input type="checkbox" checked={!!filters.hasValidity} onChange={e => updateFilter('hasValidity', e.target.checked || undefined)}
                          className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
                        <span className="text-sm text-gray-700">Has Validity</span>
                      </label>
                      <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
                        <input type="checkbox" checked={!!filters.hasDataAllowance} onChange={e => updateFilter('hasDataAllowance', e.target.checked || undefined)}
                          className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
                        <span className="text-sm text-gray-700">Has Data Allowance</span>
                      </label>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Exclusions</p>
                    <div className="flex flex-wrap gap-3">
                      <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
                        <input type="checkbox" checked={!!filters.includeArchived} onChange={e => updateFilter('includeArchived', e.target.checked || undefined)}
                          className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
                        <span className="text-sm text-gray-700">Include Archived</span>
                      </label>
                      <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors">
                        <input type="checkbox" checked={!!filters.includeHidden} onChange={e => updateFilter('includeHidden', e.target.checked || undefined)}
                          className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
                        <span className="text-sm text-gray-700">Include Hidden</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 4: Preview */}
              {step === 'preview' && (
                <div className="space-y-5">
                  {loading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="flex items-center gap-3 text-sm text-gray-500">
                        <svg className="animate-spin w-5 h-5 text-cyan-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                        Running simulation...
                      </div>
                    </div>
                  ) : simulation ? (
                    <>
                      <SimulationPreview simulation={simulation} />

                      {error && (
                        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700 flex items-center gap-2">
                          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
                          {error}
                        </div>
                      )}

                      {simulation.summary.packagesUpdated === 0 && (
                        <div className="rounded-xl bg-gray-50 border border-gray-200 p-4 text-center">
                          <p className="text-sm text-gray-500">No plans match the current criteria. Try broadening your filters or selecting a different scope.</p>
                        </div>
                      )}
                    </>
                  ) : preview ? (
                    <>
                      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
                        <div className="px-5 py-3 border-b bg-gray-50/50 flex items-center justify-between">
                          <span className="text-sm font-semibold text-gray-700">Preview Summary</span>
                          <div className="flex items-center gap-1 text-xs text-gray-400">
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            Est. {Math.max(1, Math.round(preview.estimatedTimeMs / 1000))}s
                          </div>
                        </div>
                        <div className="p-5">
                          <div className="grid gap-4 sm:grid-cols-3 mb-4">
                            <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4 text-center">
                              <p className="text-3xl font-bold text-emerald-700">{preview.matched}</p>
                              <p className="text-xs font-medium text-emerald-600 mt-1">Plans to update</p>
                            </div>
                            <div className="rounded-xl bg-amber-50 border border-amber-100 p-4 text-center">
                              <p className="text-3xl font-bold text-amber-700">{preview.skipped}</p>
                              <p className="text-xs font-medium text-amber-600 mt-1">Plans skipped</p>
                            </div>
                            <div className="rounded-xl bg-gray-50 border border-gray-100 p-4 text-center">
                              <p className="text-3xl font-bold text-gray-700">{preview.totalInScope}</p>
                              <p className="text-xs font-medium text-gray-500 mt-1">Total in scope</p>
                            </div>
                          </div>

                          {preview.skipReasons.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Skipped plans by reason</p>
                              <div className="space-y-1.5">
                                {preview.skipReasons.map((sr, i) => (
                                  <div key={i} className="flex items-center justify-between rounded-lg bg-red-50 border border-red-100 px-3 py-2">
                                    <div>
                                      <span className="text-sm text-red-700">{sr.reason}</span>
                                      {sr.examples.length > 0 && (
                                        <p className="text-xs text-red-400 mt-0.5">e.g. {sr.examples.map(e => e.name).join(', ')}</p>
                                      )}
                                    </div>
                                    <span className="text-sm font-bold text-red-800">{sr.count}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      {error && (
                        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700 flex items-center gap-2">
                          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
                          {error}
                        </div>
                      )}

                      {preview.matched === 0 && (
                        <div className="rounded-xl bg-gray-50 border border-gray-200 p-4 text-center">
                          <p className="text-sm text-gray-500">No plans match the current criteria. Try broadening your filters or selecting a different scope.</p>
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
              )}

              {/* STEP 5: Executing */}
              {step === 'executing' && (
                <div className="space-y-6 py-4">
                  <div className="text-center">
                    <svg className="animate-spin w-10 h-10 text-cyan-500 mx-auto mb-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <h3 className="text-lg font-bold text-gray-900">Applying Rule</h3>
                    <p className="text-sm text-gray-500 mt-1">Processing plans...</p>
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-sm mb-2">
                      <span className="text-gray-500">{progress.current} / {progress.total} plans</span>
                      <span className="text-cyan-600 font-medium">{progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0}%</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden">
                      <div className="bg-cyan-500 h-full rounded-full transition-all duration-500 ease-out" style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }} />
                    </div>
                  </div>
                  {error && (
                    <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700">{error}</div>
                  )}
                </div>
              )}

              {/* STEP 6: Results */}
              {step === 'results' && executionResult && (
                <div className="space-y-5">
                  {executionResult.success ? (
                    <div className="text-center py-2">
                      <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-3">
                        <svg className="w-7 h-7 text-emerald-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                      </div>
                      <h3 className="text-lg font-bold text-gray-900">Rule Applied Successfully</h3>
                      <p className="text-sm text-gray-500 mt-1">{executionResult.matched} plans updated</p>
                    </div>
                  ) : (
                    <div className="text-center py-2">
                      <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-3">
                        <svg className="w-7 h-7 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </div>
                      <h3 className="text-lg font-bold text-gray-900">Execution Failed</h3>
                      <p className="text-sm text-red-600 mt-1">{executionResult.error || 'Unknown error'}</p>
                    </div>
                  )}

                  <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
                    <div className="px-5 py-3 border-b bg-gray-50/50">
                      <span className="text-sm font-semibold text-gray-700">Execution Summary</span>
                    </div>
                    <div className="p-5">
                      <div className="grid gap-4 sm:grid-cols-4 mb-4">
                        <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-center">
                          <p className="text-2xl font-bold text-emerald-700">{executionResult.matched || 0}</p>
                          <p className="text-xs text-emerald-600">Updated</p>
                        </div>
                        <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 text-center">
                          <p className="text-2xl font-bold text-amber-700">{executionResult.skipped || 0}</p>
                          <p className="text-xs text-amber-600">Skipped</p>
                        </div>
                        <div className="rounded-lg bg-red-50 border border-red-100 p-3 text-center">
                          <p className="text-2xl font-bold text-red-700">{executionResult.failed || 0}</p>
                          <p className="text-xs text-red-600">Failed</p>
                        </div>
                        <div className="rounded-lg bg-gray-50 border border-gray-100 p-3 text-center">
                          <p className="text-2xl font-bold text-gray-700">
                            {executionDetail?.durationMs ? `${Math.round(executionDetail.durationMs / 1000)}s` : '—'}
                          </p>
                          <p className="text-xs text-gray-500">Duration</p>
                        </div>
                      </div>

                      {executionResult.skipReasons && executionResult.skipReasons.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Skipped plans</p>
                          <div className="space-y-1">
                            {executionResult.skipReasons.map((sr: any, i: number) => (
                              <div key={i} className="flex items-center justify-between rounded bg-red-50 px-3 py-2 text-sm">
                                <span className="text-red-700">{sr.reason}</span>
                                <span className="font-bold text-red-800">{sr.count}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {executionDetail && (
                    <div className="text-xs text-gray-400 space-y-1">
                      <p>Rule: {executionDetail.rule?.name}</p>
                      <p>Executed by: {executionDetail.executedBy?.name || 'Unknown'}</p>
                      <p>Started: {new Date(executionDetail.startedAt).toLocaleString()}</p>
                      {executionDetail.finishedAt && <p>Finished: {new Date(executionDetail.finishedAt).toLocaleString()}</p>}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t bg-gray-50/80 rounded-b-2xl">
              <div>
                {(step === 'review' || step === 'scope' || step === 'filters') && (
                  <button onClick={handleClose} className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">
                    Cancel
                  </button>
                )}
                {step === 'preview' && (
                  <button onClick={() => setStep('filters')} className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">
                    Back
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                {step === 'review' && (
                  <button
                    onClick={() => setStep('scope')}
                    className="rounded-lg bg-cyan-600 px-5 py-2 text-sm font-semibold text-white hover:bg-cyan-700 transition-colors"
                  >
                    Continue
                  </button>
                )}
                {step === 'scope' && (
                  <button
                    onClick={handlePreview}
                    className="rounded-lg bg-cyan-600 px-5 py-2 text-sm font-semibold text-white hover:bg-cyan-700 transition-colors"
                  >
                    Preview Results
                  </button>
                )}
                {step === 'filters' && (
                  <button
                    onClick={handlePreview}
                    disabled={loading}
                    className="rounded-lg bg-cyan-600 px-5 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50 transition-colors"
                  >
                    {loading ? 'Analyzing...' : 'Preview Results'}
                  </button>
                )}
                {step === 'preview' && ((preview && preview.matched > 0) || (simulation && simulation.summary.packagesUpdated > 0)) && (
                  <button
                    onClick={handleExecute}
                    disabled={!!(simulation && simulation.warnings.some(w => w.type === 'BELOW_COST' || w.type === 'INVALID_PRICING'))}
                    className="rounded-lg bg-cyan-600 px-5 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                  >
                    {simulation && simulation.warnings.some(w => w.type === 'BELOW_COST' || w.type === 'INVALID_PRICING')
                      ? 'Fix Warnings Before Applying'
                      : `Apply to ${simulation?.summary.packagesUpdated ?? preview?.matched ?? 0} Plan${(simulation?.summary.packagesUpdated ?? preview?.matched ?? 0) !== 1 ? 's' : ''}`
                    }
                  </button>
                )}
                {step === 'preview' && preview && preview.matched === 0 && !loading && (
                  <button
                    onClick={() => setStep('filters')}
                    className="rounded-lg border border-gray-200 bg-white px-5 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                  >
                    Adjust Filters
                  </button>
                )}
                {step === 'results' && (
                  <button
                    onClick={() => { handleClose(); onApplied?.() }}
                    className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                  >
                    Done
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
