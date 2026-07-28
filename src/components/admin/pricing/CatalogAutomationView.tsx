'use client'

import type { AutomationResult, AutomationReport, ReviewQueueItem, PackageClass, ReviewAction } from '@/lib/catalog/catalog-automation'

const CLASS_LABELS: Record<PackageClass, { label: string; bg: string; text: string }> = {
  NEW: { label: 'New', bg: 'bg-cyan-100', text: 'text-cyan-700' },
  UPDATED: { label: 'Updated', bg: 'bg-blue-100', text: 'text-blue-700' },
  READY_FOR_REVIEW: { label: 'Review', bg: 'bg-violet-100', text: 'text-violet-700' },
  UNCHANGED: { label: 'Unchanged', bg: 'bg-gray-100', text: 'text-gray-500' },
  NEEDS_ATTENTION: { label: '⚠ Needs Attention', bg: 'bg-red-100', text: 'text-red-700' },
}

const ACTION_LABELS: Record<ReviewAction, { label: string; bg: string; text: string }> = {
  CONFIGURE: { label: 'Configure', bg: 'bg-cyan-100', text: 'text-cyan-700' },
  REVIEW_PRICING: { label: 'Review Pricing', bg: 'bg-amber-100', text: 'text-amber-700' },
  SWITCH_PROVIDER: { label: 'Switch Provider', bg: 'bg-violet-100', text: 'text-violet-700' },
  ARCHIVE: { label: 'Archive', bg: 'bg-red-100', text: 'text-red-700' },
  PUBLISH: { label: 'Publish', bg: 'bg-emerald-100', text: 'text-emerald-700' },
  NO_ACTION: { label: 'No Action', bg: 'bg-gray-100', text: 'text-gray-500' },
}

interface Props {
  result: AutomationResult
  loading?: boolean
}

export default function CatalogAutomationView({ result, loading }: Props) {
  const { report, reviewQueue, packages } = result

  if (loading) {
    return (
      <div className="rounded-xl border bg-white shadow-sm p-6">
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3 text-sm text-gray-500">
            <svg className="animate-spin w-5 h-5 text-cyan-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            Running catalog automation...
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <h3 className="text-base font-semibold text-gray-900">Catalog Automation Report</h3>

      {/* Summary Cards */}
      <div className="grid gap-3 sm:grid-cols-5">
        <SummaryCard label="New" value={report.classificationSummary.newPackages} color="cyan" />
        <SummaryCard label="Updated" value={report.classificationSummary.updatedPackages} color="blue" />
        <SummaryCard label="Ready for Review" value={report.classificationSummary.readyForReview} color="violet" />
        <SummaryCard label="Needs Attention" value={report.classificationSummary.needsAttention} color="red" />
        <SummaryCard label="Unchanged" value={report.classificationSummary.unchanged} color="gray" />
      </div>

      {/* Pricing Changes */}
      {report.pricingChanges.count > 0 && (
        <div className="rounded-xl border bg-white shadow-sm p-4">
          <div className="flex items-center gap-4 text-sm">
            <span className="font-semibold text-gray-700">Pricing Changes</span>
            <span className="text-gray-500">{report.pricingChanges.count} packages</span>
            {report.pricingChanges.averageChangePercent != null && (
              <span className={report.pricingChanges.averageChangePercent >= 0 ? 'text-red-600' : 'text-emerald-600'}>
                Avg {report.pricingChanges.averageChangePercent >= 0 ? '+' : ''}{report.pricingChanges.averageChangePercent}%
              </span>
            )}
            <span className="text-emerald-600">{report.pricingChanges.decreases} ↓</span>
            <span className="text-red-600">{report.pricingChanges.increases} ↑</span>
          </div>
        </div>
      )}

      {/* Review Queue */}
      {reviewQueue.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b bg-gray-50/50 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">
              Review Queue <span className="text-gray-400 font-normal">({reviewQueue.length} items)</span>
            </span>
          </div>
          <div className="divide-y max-h-[500px] overflow-y-auto">
            {reviewQueue.slice(0, 30).map((item, i) => (
              <div key={i} className="p-4 hover:bg-gray-50/50">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="text-sm font-semibold text-gray-900 truncate">{item.packageName}</h4>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${CLASS_LABELS[item.classification].bg} ${CLASS_LABELS[item.classification].text}`}>
                        {CLASS_LABELS[item.classification].label}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">{item.reason}</p>
                    {item.providerName && (
                      <p className="text-xs text-gray-400 mt-0.5">{item.providerName}</p>
                    )}
                    {item.changes.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {item.changes.map((ch, j) => (
                          <span key={j} className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] ${ch.significant ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-gray-50 text-gray-500 border border-gray-100'}`}>
                            {ch.field}: {String(ch.before ?? '—')} → {String(ch.after ?? '—')}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${ACTION_LABELS[item.suggestedAction].bg} ${ACTION_LABELS[item.suggestedAction].text}`}>
                      {ACTION_LABELS[item.suggestedAction].label}
                    </span>
                    <span className="text-xs text-gray-400">{item.confidence}%</span>
                  </div>
                </div>
              </div>
            ))}
            {reviewQueue.length > 30 && (
              <div className="px-4 py-3 text-center text-xs text-gray-400">
                + {reviewQueue.length - 30} more items in queue
              </div>
            )}
          </div>
        </div>
      )}

      {/* No items */}
      {reviewQueue.length === 0 && (
        <div className="rounded-xl bg-gray-50 border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-500">All packages are up to date. Nothing needs review.</p>
        </div>
      )}

      {/* Footer */}
      <div className="text-xs text-gray-400">
        Generated {report.generatedAt.toLocaleString()} · {report.changeSummary.newPackages} new · {report.changeSummary.updatedPackages} updated · {report.changeSummary.unchangedPackages} unchanged · Completed in {result.durationMs}ms
      </div>
    </div>
  )
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  const colorMap: Record<string, string> = {
    cyan: 'bg-cyan-50 border-cyan-100',
    blue: 'bg-blue-50 border-blue-100',
    violet: 'bg-violet-50 border-violet-100',
    red: 'bg-red-50 border-red-100',
    gray: 'bg-gray-50 border-gray-100',
  }
  const textMap: Record<string, string> = {
    cyan: 'text-cyan-700',
    blue: 'text-blue-700',
    violet: 'text-violet-700',
    red: 'text-red-700',
    gray: 'text-gray-500',
  }
  return (
    <div className={`rounded-lg border ${colorMap[color] || 'bg-gray-50 border-gray-100'} p-3 text-center`}>
      <p className={`text-2xl font-bold ${textMap[color] || 'text-gray-700'}`}>{value}</p>
      <p className="text-xs text-gray-500 mt-1">{label}</p>
    </div>
  )
}

export type { AutomationResult, ReviewQueueItem }
