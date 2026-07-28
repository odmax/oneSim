'use client'

import type { PipelineResult, PipelineReviewItem, PipelineState } from '@/lib/catalog/catalog-pipeline'

const STATE_COLORS: Record<PipelineState, string> = {
  DETECTED: 'bg-gray-100 text-gray-600',
  ANALYZED: 'bg-blue-100 text-blue-700',
  SIMULATED: 'bg-cyan-100 text-cyan-700',
  OPTIMIZED: 'bg-violet-100 text-violet-700',
  READY_FOR_REVIEW: 'bg-amber-100 text-amber-700',
  SKIPPED: 'bg-gray-100 text-gray-400',
  ERROR: 'bg-red-100 text-red-700',
}

const STATE_LABELS: Record<PipelineState, string> = {
  DETECTED: 'Detected',
  ANALYZED: 'Analyzed',
  SIMULATED: 'Simulated',
  OPTIMIZED: 'Optimized',
  READY_FOR_REVIEW: 'Ready for Review',
  SKIPPED: 'Skipped',
  ERROR: 'Error',
}

function formatPrice(v: number | null): string {
  if (v == null) return '—'
  return `$${v.toFixed(2)}`
}

function formatPct(v: number | null): string {
  if (v == null) return '—'
  return `${v.toFixed(1)}%`
}

interface Props {
  result: PipelineResult
  loading?: boolean
}

export default function PipelineDashboard({ result, loading }: Props) {
  if (loading) {
    return (
      <div className="rounded-xl border bg-white shadow-sm p-6">
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3 text-sm text-gray-500">
            <svg className="animate-spin w-5 h-5 text-cyan-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            Running pipeline...
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h3 className="text-base font-semibold text-gray-900">Catalog Pipeline</h3>
        <span className="text-xs text-gray-400">{result.totalProcessed} packages · {result.durationMs}ms</span>
      </div>

      {/* State Flow */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b bg-gray-50/50">
          <span className="text-sm font-semibold text-gray-700">Processing States</span>
        </div>
        <div className="p-5">
          <div className="flex items-center gap-2 flex-wrap">
            {(['DETECTED', 'ANALYZED', 'SIMULATED', 'OPTIMIZED', 'READY_FOR_REVIEW', 'SKIPPED', 'ERROR'] as PipelineState[]).map(state => {
              const count = result.byState[state] || 0
              if (count === 0 && state !== 'READY_FOR_REVIEW') return null
              return (
                <div key={state} className={`flex items-center gap-2 rounded-full px-3 py-1.5 ${STATE_COLORS[state]}`}>
                  <span className="text-xs font-medium">{STATE_LABELS[state]}</span>
                  <span className="text-xs font-bold">{count}</span>
                </div>
              )
            })}
          </div>
          <div className="mt-4 flex items-center gap-1.5 text-[10px] text-gray-400">
            {(['DETECTED', 'ANALYZED', 'SIMULATED', 'OPTIMIZED', 'READY_FOR_REVIEW'] as PipelineState[]).map((state, i, arr) => (
              <span key={state} className="flex items-center gap-1">
                <span className={result.byState[state] > 0 ? 'text-gray-600 font-medium' : ''}>{STATE_LABELS[state]}</span>
                {i < arr.length - 1 && <span>→</span>}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Metrics Cards */}
      <div className="grid gap-3 sm:grid-cols-4">
        <MetricCard label="Total Processed" value={String(result.totalProcessed)} color="gray" />
        <MetricCard label="Ready for Review" value={String(result.byState.READY_FOR_REVIEW)} color="amber" />
        <MetricCard label="Optimized" value={String(result.byState.OPTIMIZED)} color="violet" />
        <MetricCard label="Warnings" value={String(result.totalWarnings)} color={result.totalWarnings > 0 ? 'red' : 'gray'} />
      </div>

      {/* Revenue / Profit Impact */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border bg-white p-4">
          <p className="text-xs text-gray-500">Estimated Revenue Impact</p>
          <p className={`text-xl font-bold mt-1 ${(result.estimatedRevenueImpact ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {result.estimatedRevenueImpact != null ? `${result.estimatedRevenueImpact >= 0 ? '+' : ''}${formatPrice(result.estimatedRevenueImpact)}` : '—'}
          </p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-xs text-gray-500">Estimated Profit Impact</p>
          <p className={`text-xl font-bold mt-1 ${(result.estimatedProfitImpact ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {result.estimatedProfitImpact != null ? `${result.estimatedProfitImpact >= 0 ? '+' : ''}${formatPrice(result.estimatedProfitImpact)}` : '—'}
          </p>
        </div>
      </div>

      {/* Suggested Actions */}
      {Object.keys(result.bySuggestedAction).length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Suggested Actions</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(result.bySuggestedAction).map(([action, count]) => (
              <span key={action} className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs">
                <span className="text-gray-700">{action.replace(/_/g, ' ')}</span>
                <span className="text-gray-400 font-medium">{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Review Queue */}
      {result.reviewItems.filter(i => i.state === 'READY_FOR_REVIEW').length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b bg-gray-50/50">
            <span className="text-sm font-semibold text-gray-700">
              Unified Review Queue <span className="text-gray-400 font-normal">({result.reviewItems.filter(i => i.state === 'READY_FOR_REVIEW').length})</span>
            </span>
          </div>
          <div className="divide-y max-h-[500px] overflow-y-auto">
            {result.reviewItems
              .filter(i => i.state === 'READY_FOR_REVIEW' || i.state === 'SIMULATED' || i.state === 'OPTIMIZED')
              .slice(0, 30)
              .map((item, i) => (
                <div key={i} className="p-4 hover:bg-gray-50/50">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="text-sm font-semibold text-gray-900 truncate">{item.packageName}</h4>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${STATE_COLORS[item.state]}`}>
                          {STATE_LABELS[item.state]}
                        </span>
                        <span className="text-[10px] text-gray-400">{item.suggestedAction.replace(/_/g, ' ')}</span>
                      </div>
                      <p className="text-xs text-gray-500">{item.reason}</p>
                      {item.providerName && <p className="text-xs text-gray-400">{item.providerName}</p>}

                      {/* Pricing comparison */}
                      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <span className="text-gray-400">Current</span>
                          <p className="font-mono text-gray-700">{formatPrice(item.currentSellingPrice)}</p>
                        </div>
                        <div>
                          <span className="text-gray-400">Simulated</span>
                          <p className="font-mono text-gray-700">{formatPrice(item.simulatedSellingPrice)}</p>
                        </div>
                        <div>
                          <span className="text-gray-400">Margin</span>
                          <p className="font-mono text-gray-700">{formatPct(item.simulatedMargin)}</p>
                        </div>
                      </div>

                      {/* Provider comparison */}
                      {(item.currentProvider || item.recommendedProvider) && (
                        <div className="mt-2 flex items-center gap-2 text-xs">
                          {item.currentProvider && <span className="text-violet-600">Current: {item.currentProvider}</span>}
                          {item.currentProvider && item.recommendedProvider && <span className="text-gray-300">→</span>}
                          {item.recommendedProvider && (
                            <span className="text-amber-600">Recommended: {item.recommendedProvider}</span>
                          )}
                          {item.costDifference != null && (
                            <span className={item.costDifference > 0 ? 'text-emerald-600' : 'text-red-600'}>
                              {item.costDifference > 0 ? '-' : '+'}{formatPrice(Math.abs(item.costDifference))}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Warnings */}
                      {item.warnings.length > 0 && (
                        <div className="mt-2 space-y-0.5">
                          {item.warnings.map((w, j) => (
                            <p key={j} className="text-xs text-red-500">⚠ {w}</p>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-gray-400">{item.confidence}%</p>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Processing Log (collapsed) */}
      <details className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <summary className="px-5 py-3 bg-gray-50/50 cursor-pointer text-sm font-semibold text-gray-700">Processing Log</summary>
        <div className="p-4 space-y-0.5 max-h-40 overflow-y-auto">
          {result.processingLog.map((entry, i) => (
            <p key={i} className="text-xs text-gray-500 font-mono">{entry}</p>
          ))}
        </div>
      </details>
    </div>
  )
}

function MetricCard({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    gray: 'bg-gray-50 border-gray-100 text-gray-700',
    amber: 'bg-amber-50 border-amber-100 text-amber-700',
    violet: 'bg-violet-50 border-violet-100 text-violet-700',
    red: 'bg-red-50 border-red-100 text-red-700',
  }
  return (
    <div className={`rounded-lg border p-3 text-center ${colors[color] || colors.gray}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs mt-1 opacity-80">{label}</p>
    </div>
  )
}

export type { PipelineResult, PipelineReviewItem }
