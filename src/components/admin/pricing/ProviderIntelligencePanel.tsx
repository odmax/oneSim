'use client'

import type { ProviderRecommendation, ProviderComparison, ProviderIndicator } from '@/lib/pricing/provider-intelligence'

function formatPrice(v: number | null): string {
  if (v == null) return '—'
  return `$${v.toFixed(2)}`
}

function formatPct(v: number | null): string {
  if (v == null) return '—'
  return `${v.toFixed(1)}%`
}

function diffText(current: number | null | undefined, recommended: number | null | undefined, prefix = '', suffix = ''): string {
  if (current == null || recommended == null) return '—'
  const delta = recommended - current
  const sign = delta > 0 ? '+' : ''
  return `${prefix}${sign}${delta.toFixed(2)}${suffix}`
}

function indicatorBadge(indicator: ProviderIndicator) {
  const map: Record<ProviderIndicator, { bg: string; text: string; label: string }> = {
    CHEAPEST: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Cheapest' },
    BEST_MARGIN: { bg: 'bg-cyan-100', text: 'text-cyan-700', label: 'Best Margin' },
    BEST_PROFIT: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Best Profit' },
    CURRENT_PROVIDER: { bg: 'bg-violet-100', text: 'text-violet-700', label: 'Current' },
    OPTIMAL: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Recommended' },
    MORE_EXPENSIVE: { bg: 'bg-red-50', text: 'text-red-500', label: 'More Expensive' },
    NO_PRICING: { bg: 'bg-gray-100', text: 'text-gray-400', label: 'No Pricing' },
  }
  const style = map[indicator]
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  )
}

interface Props {
  recommendation: ProviderRecommendation
  loading?: boolean
}

export default function ProviderIntelligencePanel({ recommendation, loading }: Props) {
  const { currentProvider, recommendedProvider, lowestCostProvider, highestProfitProvider, highestMarginProvider, comparisons, recommendationReason, estimatedProfitDifference, estimatedMarginDifference, estimatedCostSavings, currency } = recommendation

  if (loading) {
    return (
      <div className="rounded-xl border bg-white shadow-sm p-6">
        <div className="flex items-center justify-center py-8">
          <div className="flex items-center gap-3 text-sm text-gray-500">
            <svg className="animate-spin w-5 h-5 text-cyan-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            Analysing providers...
          </div>
        </div>
      </div>
    )
  }

  if (comparisons.length === 0) {
    return (
      <div className="rounded-xl border bg-white shadow-sm p-6">
        <h3 className="text-sm font-semibold text-gray-900">Provider Intelligence</h3>
        <p className="text-sm text-gray-400 mt-4 text-center py-4">No comparison data available</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b bg-gray-50/50">
        <h3 className="text-sm font-semibold text-gray-900">Provider Intelligence</h3>
      </div>

      <div className="p-5 space-y-5">
        {/* Recommendation Cards */}
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Current Provider */}
          <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-4">
            <p className="text-xs font-medium text-violet-500 uppercase tracking-wider mb-2">Current Provider</p>
            {currentProvider ? (
              <>
                <p className="text-sm font-bold text-gray-900">{currentProvider.providerName}</p>
                <p className="text-xs text-gray-500 mt-0.5">{currentProvider.packageName}</p>
                <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
                  <span className="text-gray-400">Cost</span>
                  <span className="text-right font-mono text-gray-700">{formatPrice(currentProvider.costPrice)}</span>
                  <span className="text-gray-400">Profit</span>
                  <span className="text-right font-mono text-gray-700">{formatPrice(currentProvider.profit)}</span>
                  <span className="text-gray-400">Margin</span>
                  <span className="text-right font-mono text-gray-700">{formatPct(currentProvider.marginPercent)}</span>
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-400">None selected</p>
            )}
          </div>

          {/* Recommended Provider */}
          <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4">
            <p className="text-xs font-medium text-amber-600 uppercase tracking-wider mb-2">Recommended</p>
            {recommendedProvider ? (
              <>
                <p className="text-sm font-bold text-gray-900">{recommendedProvider.providerName}</p>
                <p className="text-xs text-gray-500 mt-0.5">{recommendedProvider.packageName}</p>
                <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
                  <span className="text-gray-400">Cost</span>
                  <span className="text-right font-mono font-semibold text-emerald-700">{formatPrice(recommendedProvider.costPrice)}</span>
                  <span className="text-gray-400">Profit</span>
                  <span className="text-right font-mono font-semibold text-emerald-700">{formatPrice(recommendedProvider.profit)}</span>
                  <span className="text-gray-400">Margin</span>
                  <span className="text-right font-mono font-semibold text-emerald-700">{formatPct(recommendedProvider.marginPercent)}</span>
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-400">No recommendation available</p>
            )}
          </div>
        </div>

        {/* Reason */}
        <div className="rounded-lg bg-gray-50 border border-gray-100 p-3">
          <p className="text-xs text-gray-500 font-medium">Why this recommendation?</p>
          <p className="text-sm text-gray-700 mt-1">{recommendationReason}</p>
        </div>

        {/* Estimated Differences */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-gray-100 bg-gray-50/50 p-3 text-center">
            <p className="text-xs text-gray-400 mb-1">Cost Savings</p>
            <p className={`text-lg font-bold ${(estimatedCostSavings ?? 0) > 0 ? 'text-emerald-600' : 'text-gray-500'}`}>
              {estimatedCostSavings != null ? `$${estimatedCostSavings.toFixed(2)}` : '—'}
            </p>
          </div>
          <div className="rounded-lg border border-gray-100 bg-gray-50/50 p-3 text-center">
            <p className="text-xs text-gray-400 mb-1">Profit Difference</p>
            <p className={`text-lg font-bold ${(estimatedProfitDifference ?? 0) > 0 ? 'text-emerald-600' : (estimatedProfitDifference ?? 0) < 0 ? 'text-red-600' : 'text-gray-500'}`}>
              {diffText(currentProvider?.profit, recommendedProvider?.profit, '$')}
            </p>
          </div>
          <div className="rounded-lg border border-gray-100 bg-gray-50/50 p-3 text-center">
            <p className="text-xs text-gray-400 mb-1">Margin Difference</p>
            <p className={`text-lg font-bold ${(estimatedMarginDifference ?? 0) > 0 ? 'text-emerald-600' : (estimatedMarginDifference ?? 0) < 0 ? 'text-red-600' : 'text-gray-500'}`}>
              {diffText(currentProvider?.marginPercent, recommendedProvider?.marginPercent, '', '%')}
            </p>
          </div>
        </div>

        {/* Rankings */}
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-lg border border-emerald-100 bg-emerald-50/30 p-3">
            <p className="text-xs text-emerald-600 font-medium">Cheapest</p>
            <p className="text-sm font-semibold text-gray-900 mt-0.5">{lowestCostProvider?.providerName || '—'}</p>
            <p className="text-xs text-gray-500">{lowestCostProvider ? formatPrice(lowestCostProvider.costPrice) : ''}</p>
          </div>
          <div className="rounded-lg border border-blue-100 bg-blue-50/30 p-3">
            <p className="text-xs text-blue-600 font-medium">Best Profit</p>
            <p className="text-sm font-semibold text-gray-900 mt-0.5">{highestProfitProvider?.providerName || '—'}</p>
            <p className="text-xs text-gray-500">{highestProfitProvider ? formatPrice(highestProfitProvider.profit) : ''}</p>
          </div>
          <div className="rounded-lg border border-cyan-100 bg-cyan-50/30 p-3">
            <p className="text-xs text-cyan-600 font-medium">Best Margin</p>
            <p className="text-sm font-semibold text-gray-900 mt-0.5">{highestMarginProvider?.providerName || '—'}</p>
            <p className="text-xs text-gray-500">{highestMarginProvider ? formatPct(highestMarginProvider.marginPercent) : ''}</p>
          </div>
        </div>

        {/* Comparison Table */}
        {comparisons.length > 1 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50/80 text-[11px] uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">Provider</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2 text-right">Profit</th>
                  <th className="px-3 py-2 text-right">Margin</th>
                  <th className="px-3 py-2 text-center">Indicators</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {comparisons.map((c, i) => (
                  <tr key={i} className={`hover:bg-gray-50/50 ${c.isCurrentProvider ? 'bg-violet-50/30' : ''}`}>
                    <td className="px-3 py-2">
                      <div className="text-sm font-medium text-gray-900">{c.providerName}</div>
                      <div className="text-xs text-gray-400">{c.providerCode}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-gray-700">{formatPrice(c.costPrice)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-gray-700">{formatPrice(c.profit)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-gray-700">{formatPct(c.marginPercent)}</td>
                    <td className="px-3 py-2 text-center">
                      <div className="flex flex-wrap gap-1 justify-center">
                        {c.indicators.map(ind => (
                          <span key={ind}>{indicatorBadge(ind)}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export type { ProviderRecommendation, ProviderComparison, ProviderIndicator }
