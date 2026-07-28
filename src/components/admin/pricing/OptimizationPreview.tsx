'use client'

import type { OptimizationResult, BatchOptimizationResult, OptimizationStrategy } from '@/lib/pricing/provider-optimization'

function formatPrice(v: number | null): string {
  if (v == null) return '—'
  return `$${v.toFixed(2)}`
}

function formatPct(v: number | null): string {
  if (v == null) return '—'
  return `${v.toFixed(1)}%`
}

function diffText(current: number | null, recommended: number | null): string {
  if (current == null || recommended == null) return '—'
  const delta = recommended - current
  const sign = delta > 0 ? '+' : ''
  return `${sign}$${delta.toFixed(2)}`
}

function confidenceColor(score: number): string {
  if (score >= 90) return 'text-emerald-600 bg-emerald-50'
  if (score >= 70) return 'text-cyan-600 bg-cyan-50'
  if (score >= 50) return 'text-amber-600 bg-amber-50'
  return 'text-red-600 bg-red-50'
}

interface Props {
  result: BatchOptimizationResult
  loading?: boolean
}

export default function OptimizationPreview({ result, loading }: Props) {
  const { summary, results, strategy, rules } = result

  const strategyLabels: Record<OptimizationStrategy, string> = {
    LOWEST_COST: 'Lowest Cost',
    HIGHEST_MARGIN: 'Highest Margin',
    HIGHEST_PROFIT: 'Highest Profit',
    KEEP_CURRENT: 'Keep Current',
    CUSTOM: 'Custom',
  }

  if (loading) {
    return (
      <div className="rounded-xl border bg-white shadow-sm p-6">
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3 text-sm text-gray-500">
            <svg className="animate-spin w-5 h-5 text-cyan-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            Running optimization...
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Strategy Badge */}
      <div className="flex items-center gap-3">
        <h3 className="text-base font-semibold text-gray-900">Provider Optimization</h3>
        <span className="inline-flex items-center rounded-full bg-cyan-100 px-3 py-1 text-xs font-medium text-cyan-700">
          {strategyLabels[strategy]}
        </span>
        {rules.minMarginPercent && (
          <span className="text-xs text-gray-400">Min margin: {rules.minMarginPercent}%</span>
        )}
        {!rules.allowSwitching && (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">Switching Disabled</span>
        )}
      </div>

      {/* Summary */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b bg-gray-50/50">
          <span className="text-sm font-semibold text-gray-700">Batch Summary</span>
        </div>
        <div className="p-5">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-gray-50 border p-3 text-center">
              <p className="text-2xl font-bold text-gray-700">{summary.totalAnalyzed}</p>
              <p className="text-xs text-gray-500 mt-1">Total Analyzed</p>
            </div>
            <div className="rounded-lg bg-cyan-50 border border-cyan-100 p-3 text-center">
              <p className="text-2xl font-bold text-cyan-700">{summary.requireChange}</p>
              <p className="text-xs text-cyan-600 mt-1">Require Change</p>
            </div>
            <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-center">
              <p className="text-2xl font-bold text-emerald-700">{summary.alreadyOptimal}</p>
              <p className="text-xs text-emerald-600 mt-1">Already Optimal</p>
            </div>
            <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 text-center">
              <p className="text-2xl font-bold text-amber-700">{summary.skipped}</p>
              <p className="text-xs text-amber-600 mt-1">Skipped</p>
            </div>
          </div>

          {(summary.estimatedMonthlyCostSavings != null || summary.estimatedAdditionalMonthlyProfit != null) && (
            <div className="grid gap-3 sm:grid-cols-2 mt-3">
              {summary.estimatedMonthlyCostSavings != null && (
                <div className="rounded-lg bg-emerald-50/50 border border-emerald-100 p-3">
                  <p className="text-xs text-emerald-600">Estimated Monthly Savings</p>
                  <p className="text-lg font-bold text-emerald-700">{formatPrice(summary.estimatedMonthlyCostSavings)}</p>
                  <p className="text-xs text-emerald-500 mt-1">Per activation cost reduction</p>
                </div>
              )}
              {summary.estimatedAdditionalMonthlyProfit != null && (
                <div className="rounded-lg bg-blue-50/50 border border-blue-100 p-3">
                  <p className="text-xs text-blue-600">Additional Monthly Profit</p>
                  <p className="text-lg font-bold text-blue-700">{formatPrice(summary.estimatedAdditionalMonthlyProfit)}</p>
                  <p className="text-xs text-blue-500 mt-1">Profit gain from switching</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Per-Package Results */}
      {results.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b bg-gray-50/50">
            <span className="text-sm font-semibold text-gray-700">Recommendations <span className="text-gray-400 font-normal">({results.length})</span></span>
          </div>
          <div className="divide-y max-h-[550px] overflow-y-auto">
            {results.slice(0, 30).map((r, i) => (
              <OptimizationCard key={i} result={r} />
            ))}
            {results.length > 30 && (
              <div className="px-5 py-4 text-center text-xs text-gray-400">
                + {results.length - 30} more recommendations not shown
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function OptimizationCard({ result }: { result: OptimizationResult }) {
  const skipped = !!result.skipReason

  return (
    <div className={`p-4 ${skipped ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* Header */}
          <div className="flex items-center gap-2 mb-2">
            <h4 className="text-sm font-semibold text-gray-900 truncate">{result.packageName}</h4>
            {result.shouldSwitch ? (
              <span className="inline-flex items-center rounded-full bg-cyan-100 px-2 py-0.5 text-[10px] font-medium text-cyan-700">Switch</span>
            ) : skipped ? (
              <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-600">Skipped</span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">Optimal</span>
            )}
          </div>

          {/* Skip reason */}
          {skipped ? (
            <p className="text-xs text-red-500 mb-2">{result.skipReason}</p>
          ) : (
            <>
              {/* Provider comparison */}
              <div className="grid grid-cols-2 gap-3 mb-2 text-xs">
                <div className="rounded border border-violet-100 bg-violet-50/30 p-2">
                  <p className="text-violet-500 font-medium">Current</p>
                  <p className="text-gray-800 font-semibold">{result.currentProvider?.providerName || 'None'}</p>
                  <p className="text-gray-500">{formatPrice(result.currentProvider?.costPrice ?? null)}</p>
                </div>
                <div className="rounded border border-amber-100 bg-amber-50/30 p-2">
                  <p className="text-amber-600 font-medium">Recommended</p>
                  <p className="text-gray-800 font-semibold">{result.recommendedProvider?.providerName || '—'}</p>
                  <p className="text-gray-500">{formatPrice(result.recommendedProvider?.costPrice ?? null)}</p>
                </div>
              </div>

              {/* Differences */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {result.costDifference != null && (
                  <span className={result.costDifference > 0 ? 'text-emerald-600' : result.costDifference < 0 ? 'text-red-600' : 'text-gray-500'}>
                    Cost: {result.costDifference > 0 ? '-' : '+'}{formatPrice(Math.abs(result.costDifference))}
                  </span>
                )}
                {result.marginDifference != null && (
                  <span className={result.marginDifference > 0 ? 'text-emerald-600' : result.marginDifference < 0 ? 'text-red-600' : 'text-gray-500'}>
                    Margin: {result.marginDifference > 0 ? '+' : ''}{result.marginDifference.toFixed(1)}%
                  </span>
                )}
                {result.profitDifference != null && (
                  <span className={result.profitDifference > 0 ? 'text-emerald-600' : result.profitDifference < 0 ? 'text-red-600' : 'text-gray-500'}>
                    Profit: {diffText(0, result.profitDifference)}
                  </span>
                )}
              </div>
            </>
          )}

          {/* Reasons */}
          {!skipped && result.reasons.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {result.reasons.slice(0, 3).map((reason, i) => (
                <span key={i} className="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600">
                  {reason}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Confidence */}
        {!skipped && (
          <div className={`shrink-0 flex flex-col items-center justify-center rounded-lg px-3 py-2 ${confidenceColor(result.confidence)}`}>
            <span className="text-lg font-bold">{result.confidence}</span>
            <span className="text-[10px]">%</span>
          </div>
        )}
      </div>
    </div>
  )
}

export type { OptimizationResult, BatchOptimizationResult }
