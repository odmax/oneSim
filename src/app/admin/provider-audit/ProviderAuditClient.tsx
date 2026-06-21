'use client'

import { useState } from 'react'

interface CheckItem {
  id: string; category: string; checkKey: string; label: string
  status: string; isCritical: boolean; notes: string | null
  checkedAt: string | null; checkedBy: string | null
}

interface Props {
  audit: { id: string; certificationStatus: string; passCount: number; failCount: number; totalChecks: number }
  checks: CheckItem[]
}

const CATEGORIES = [
  { key: 'CONNECTIVITY', label: 'Connectivity' },
  { key: 'CATALOG', label: 'Catalog' },
  { key: 'PRICING', label: 'Pricing' },
  { key: 'PUBLISHING', label: 'Catalog Publishing' },
  { key: 'PROVISIONING', label: 'Provisioning' },
  { key: 'FEATURES', label: 'Provider Features' },
  { key: 'COMMERCIAL', label: 'Commercial' },
  { key: 'OPERATIONS', label: 'Operations' },
]

export default function ProviderAuditClient({ audit, checks: initialChecks }: Props) {
  const [checks, setChecks] = useState(initialChecks)
  const [noteInputs, setNoteInputs] = useState<Record<string, string>>({})
  const [report, setReport] = useState<any>(null)
  const [reportLoading, setReportLoading] = useState<string | null>(null)

  async function mark(id: string, status: 'PASS' | 'FAIL') {
    try {
      const { markAuditCheck } = await import('@/lib/actions/provider-audit')
      await markAuditCheck(audit.id, id, status)
      setChecks(prev => prev.map(c => c.id === id ? { ...c, status, checkedAt: new Date().toISOString() } : c))
    } catch (e: any) { alert(e.message) }
  }

  async function addNote(auditId: string) {
    const content = noteInputs[auditId]?.trim()
    if (!content) return
    try {
      const { addAuditNote } = await import('@/lib/actions/provider-audit')
      await addAuditNote(auditId, content)
      setNoteInputs(prev => ({ ...prev, [auditId]: '' }))
    } catch (e: any) { alert(e.message) }
  }

  async function reset() {
    if (!confirm('Reset all audit checks to PENDING?')) return
    try {
      const { resetAudit } = await import('@/lib/actions/provider-audit')
      await resetAudit(audit.id)
      setChecks(prev => prev.map(c => ({ ...c, status: 'PENDING', checkedAt: null, checkedBy: null, notes: null })))
    } catch (e: any) { alert(e.message) }
  }

  async function generateReport() {
    setReportLoading(audit.id)
    try {
      const { generateCertificationReport } = await import('@/lib/actions/provider-audit')
      const r = await generateCertificationReport(audit.id)
      setReport(r)
    } catch (e: any) { alert(e.message) }
    setReportLoading(null)
  }

  return (
    <div className="p-6">
      {/* Category groups */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {CATEGORIES.map(cat => {
          const catChecks = checks.filter(c => c.category === cat.key)
          return (
            <div key={cat.key} className="rounded-lg border border-gray-100 bg-gray-50/50 p-3">
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">{cat.label}</h4>
              <div className="space-y-1.5">
                {catChecks.map(check => (
                  <div key={check.id} className="flex items-center justify-between gap-1">
                    <span className="text-xs text-gray-700 flex-1">
                      {check.label}
                      {check.isCritical && <span className="text-red-400 ml-0.5" title="Critical">*</span>}
                    </span>
                    <div className="flex gap-0.5 shrink-0">
                      <button onClick={() => mark(check.id, 'PASS')}
                        className={`px-1.5 py-0.5 text-[10px] rounded font-medium transition-colors ${
                          check.status === 'PASS' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-400 hover:bg-emerald-50 hover:text-emerald-600'
                        }`}>✓</button>
                      <button onClick={() => mark(check.id, 'FAIL')}
                        className={`px-1.5 py-0.5 text-[10px] rounded font-medium transition-colors ${
                          check.status === 'FAIL' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-400 hover:bg-red-50 hover:text-red-600'
                        }`}>✗</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Action buttons */}
      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={reset}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
          Reset Audit
        </button>
        <button onClick={generateReport} disabled={reportLoading === audit.id}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 shadow-sm">
          {reportLoading === audit.id ? 'Generating...' : 'Generate Certification Report'}
        </button>
      </div>

      {/* Note input */}
      <div className="mt-4 flex gap-2">
        <input type="text" value={noteInputs[audit.id] || ''}
          onChange={e => setNoteInputs(prev => ({ ...prev, [audit.id]: e.target.value }))}
          placeholder="Add a note..."
          className="flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          onKeyDown={e => { if (e.key === 'Enter') addNote(audit.id) }}
        />
        <button onClick={() => addNote(audit.id)}
          className="rounded-lg bg-gray-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 shadow-sm">
          Add Note
        </button>
      </div>

      {/* Certification Report */}
      {report && (
        <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-900">Certification Report</h3>
            <button onClick={() => setReport(null)}
              className="text-xs text-gray-400 hover:text-gray-600">Close</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="bg-white rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500">Pass %</p>
              <p className="text-xl font-bold text-emerald-600">{report.passPercent}%</p>
            </div>
            <div className="bg-white rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500">Fail %</p>
              <p className="text-xl font-bold text-red-600">{report.failPercent}%</p>
            </div>
            <div className="bg-white rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500">Status</p>
              <p className="text-xl font-bold text-gray-900">{report.certificationStatus}</p>
            </div>
            <div className="bg-white rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500">Generated</p>
              <p className="text-sm font-mono text-gray-600">{new Date(report.generatedAt).toLocaleDateString()}</p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <h4 className="text-xs font-semibold text-emerald-600 mb-2">Passed ({report.passedChecks.length})</h4>
              <ul className="space-y-1">{report.passedChecks.map((c: any) => <li key={c.label} className="text-xs text-gray-600">✓ {c.label}</li>)}</ul>
            </div>
            {report.failedChecks.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-red-600 mb-2">Failed ({report.failedChecks.length})</h4>
                <ul className="space-y-1">{report.failedChecks.map((c: any) => <li key={c.label} className="text-xs text-red-600">✗ {c.label}</li>)}</ul>
              </div>
            )}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 mb-2">Outstanding ({report.outstandingChecks.length})</h4>
              <ul className="space-y-1">{report.outstandingChecks.map((c: any) => <li key={c.label} className="text-xs text-gray-500">○ {c.label}</li>)}</ul>
            </div>
          </div>

          {report.notes.length > 0 && (
            <div className="mt-4 border-t border-gray-200 pt-4">
              <h4 className="text-xs font-semibold text-gray-500 mb-2">Notes</h4>
              {report.notes.map((n: any, i: number) => (
                <p key={i} className="text-xs text-gray-600"><strong>{n.author}:</strong> {n.content} <span className="text-gray-400">({new Date(n.createdAt).toLocaleDateString()})</span></p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
