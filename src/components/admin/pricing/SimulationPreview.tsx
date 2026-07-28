'use client'

import type { SimulationResult, PackageSimulation, RuleImpactSummary, SimulationWarning } from '@/lib/pricing/pricing-simulation-service'

function formatPrice(v: number | null): string {
  if (v == null) return '—'
  return `$${v.toFixed(2)}`
}

function formatPct(v: number | null): string {
  if (v == null) return '—'
  return `${v.toFixed(1)}%`
}

function diffClass(status: string): string {
  switch (status) {
    case 'increase': return 'text-emerald-600'
    case 'decrease': return 'text-red-600'
    case 'new': return 'text-cyan-600'
    default: return 'text-gray-500'
  }
}

function diffPct(current: number | null, next: number | null): string {
  if (current == null && next == null) return '—'
  if (current == null) return `→ ${next!.toFixed(1)}%`
  if (next == null) return '—'
  const delta = next - current
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toFixed(1)}%`
}

function diffMoney(current: number | null, next: number | null): string {
  if (current == null && next == null) return '—'
  if (current == null) return `→ $${next!.toFixed(2)}`
  if (next == null) return '—'
  const delta = next - current
  const sign = delta > 0 ? '+' : ''
  return `${sign}$${delta.toFixed(2)}`
}

interface Props {
  simulation: SimulationResult
  onApply?: () => void
  onBack?: () => void
  loading?: boolean
}

export default function SimulationPreview({ simulation, onApply, onBack, loading }: Props) {
  const { summary, warnings, packages } = simulation

  const hasWarnings = warnings.length > 0
  const hasCritical = warnings.some(w => w.type === 'BELOW_COST' || w.type === 'INVALID_PRICING')

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h3 className="text-base font-semibold text-gray-900">Dry Run — Simulation Results</h3>
        <p className="text-sm text-gray-500 mt-1">No changes have been applied yet. Review the impact before continuing.</p>
      </div>

      {/* Impact Summary Card */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b bg-gray-50/50 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">Impact Summary</span>
          <span className="text-xs text-gray-400">
            Simulated in {simulation.durationMs}ms
          </span>
        </div>
        <div className="p-5">
          <div className="grid gap-4 sm:grid-cols-4 mb-4">
            <div className="rounded-xl bg-cyan-50 border border-cyan-100 p-4 text-center">
              <p className="text-2xl font-bold text-cyan-700">{summary.packagesEvaluated}</p>
              <p className="text-xs font-medium text-cyan-600 mt-1">Packages Evaluated</p>
            </div>
            <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4 text-center">
              <p className="text-2xl font-bold text-emerald-700">{summary.packagesUpdated}</p>
              <p className="text-xs font-medium text-emerald-600 mt-1">Packages Updated</p>
            </div>
            <div className="rounded-xl bg-amber-50 border border-amber-100 p-4 text-center">
              <p className="text-2xl font-bold text-amber-700">{summary.packagesSkipped}</p>
              <p className="text-xs font-medium text-amber-600 mt-1">Packages Skipped</p>
            </div>
            <div className="rounded-xl bg-gray-50 border border-gray-100 p-4 text-center">
              <p className="text-2xl font-bold text-gray-700">{summary.packagesUnchanged}</p>
              <p className="text-xs font-medium text-gray-500 mt-1">Unchanged</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-gray-50 border p-3">
              <p className="text-xs text-gray-500 mb-1">Avg Margin</p>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-600">{formatPct(summary.averageMarginBefore)}</span>
                {summary.averageMarginBefore != null && summary.averageMarginAfter != null && (
                  <span className={`text-xs font-medium ${summary.averageMarginAfter >= summary.averageMarginBefore ? 'text-emerald-600' : 'text-red-600'}`}>
                    → {formatPct(summary.averageMarginAfter)}
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-lg bg-gray-50 border p-3">
              <p className="text-xs text-gray-500 mb-1">Est. Revenue</p>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-600">{formatPrice(summary.estimatedRevenueBefore)}</span>
                <span className={`text-xs font-medium ${summary.estimatedRevenueAfter >= summary.estimatedRevenueBefore ? 'text-emerald-600' : 'text-red-600'}`}>
                  → {formatPrice(summary.estimatedRevenueAfter)}
                </span>
              </div>
            </div>
            <div className="rounded-lg bg-gray-50 border p-3">
              <p className="text-xs text-gray-500 mb-1">Est. Profit</p>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-600">{formatPrice(summary.estimatedProfitBefore)}</span>
                <span className={`text-xs font-medium ${summary.estimatedProfitAfter >= summary.estimatedProfitBefore ? 'text-emerald-600' : 'text-red-600'}`}>
                  → {formatPrice(summary.estimatedProfitAfter)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Warnings */}
      {hasWarnings && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b bg-gray-50/50">
            <span className="text-sm font-semibold text-gray-700">
              ⚠ Warnings <span className="text-gray-400 font-normal">({warnings.length})</span>
            </span>
          </div>
          <div className="p-4 space-y-2 max-h-48 overflow-y-auto">
            {warnings.map((w, i) => {
              let borderClass = 'border-amber-200 bg-amber-50'
              let textClass = 'text-amber-700'
              if (w.type === 'BELOW_COST' || w.type === 'INVALID_PRICING') {
                borderClass = 'border-red-200 bg-red-50'
                textClass = 'text-red-700'
              }
              return (
                <div key={i} className={`flex items-center justify-between rounded-lg border ${borderClass} px-3 py-2`}>
                  <div>
                    <span className={`text-sm font-medium ${textClass}`}>{w.packageName}</span>
                    <p className="text-xs text-gray-500 mt-0.5">{w.message}</p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full bg-white border ${borderClass} font-medium`}>
                    {w.type.replace(/_/g, ' ')}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Before/After Table (first 20 packages for performance) */}
      {packages.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b bg-gray-50/50 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">
              Before / After Comparison
              <span className="text-gray-400 font-normal ml-1">({packages.length} packages)</span>
            </span>
          </div>
          <div className="overflow-x-auto max-h-72">
            <table className="w-full text-sm">
              <thead className="bg-gray-50/80 text-[11px] uppercase tracking-wider text-gray-500 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left">Package</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2 text-right">Current</th>
                  <th className="px-3 py-2 text-right">New</th>
                  <th className="px-3 py-2 text-right">Δ</th>
                  <th className="px-3 py-2 text-right">Margin</th>
                  <th className="px-3 py-2 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {packages.slice(0, 20).map(p => (
                  <tr key={p.packageId} className="hover:bg-gray-50/50">
                    <td className="px-3 py-2">
                      <div className="text-sm font-medium text-gray-900 truncate max-w-[160px]">{p.packageName}</div>
                      {p.providerName && <div className="text-xs text-gray-400">{p.providerName}</div>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">{formatPrice(p.costPrice)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-gray-600">{formatPrice(p.currentSellingPrice)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-gray-900">{formatPrice(p.newSellingPrice)}</td>
                    <td className={`px-3 py-2 text-right font-mono text-xs font-medium ${p.newSellingPrice != null && p.currentSellingPrice != null ? (p.newSellingPrice >= p.currentSellingPrice ? 'text-emerald-600' : 'text-red-600') : 'text-gray-400'}`}>
                      {diffMoney(p.currentSellingPrice, p.newSellingPrice)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">
                      {p.currentMarginPercent != null && p.newMarginPercent != null ? (
                        <span className={p.newMarginPercent >= p.currentMarginPercent ? 'text-emerald-600' : 'text-red-600'}>
                          {diffPct(p.currentMarginPercent, p.newMarginPercent)}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        p.status === 'increase' ? 'bg-emerald-100 text-emerald-700' :
                        p.status === 'decrease' ? 'bg-red-100 text-red-700' :
                        p.status === 'new' ? 'bg-cyan-100 text-cyan-700' :
                        'bg-gray-100 text-gray-500'
                      }`}>
                        {p.status.replace('_', ' ')}
                      </span>
                    </td>
                  </tr>
                ))}
                {packages.length > 20 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-3 text-center text-xs text-gray-400">
                      + {packages.length - 20} more packages not shown in preview
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* No matches message */}
      {packages.length === 0 && (
        <div className="rounded-xl bg-gray-50 border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-500">No packages matched the current rule criteria. Try broadening your filters or selecting a different scope.</p>
        </div>
      )}
    </div>
  )
}

export type { SimulationResult, PackageSimulation, RuleImpactSummary, SimulationWarning }
