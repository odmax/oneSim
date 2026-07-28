'use client'

import { useState, useEffect, useCallback } from 'react'
import { getJobsAction, getJobStatsAction, cancelJobAction } from '@/lib/actions/job-management'

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function relativeTime(date: string | Date | null): string {
  if (!date) return '—'
  const d = new Date(date)
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const TYPE_LABELS: Record<string, string> = {
  PROVIDER_SYNC: 'Provider Sync',
  CATALOG_PIPELINE: 'Catalog Pipeline',
  REVIEW_REBUILD: 'Review Rebuild',
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  PROCESSING: 'bg-blue-100 text-blue-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
  CANCELLED: 'bg-gray-100 text-gray-400',
}

export default function JobsPage() {
  const [loading, setLoading] = useState(true)
  const [jobs, setJobs] = useState<any[]>([])
  const [stats, setStats] = useState<any>({})
  const [filter, setFilter] = useState({ status: '', type: '' })
  const [feedback, setFeedback] = useState<{ type: string; message: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [j, s] = await Promise.all([
        getJobsAction({ status: filter.status || undefined, type: filter.type || undefined }),
        getJobStatsAction(),
      ])
      setJobs(j)
      setStats(s)
    } catch (e: any) {
      setFeedback({ type: 'error', message: e.message })
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  async function handleCancel(jobId: string) {
    const result = await cancelJobAction(jobId)
    setFeedback({ type: result.success ? 'success' : 'error', message: result.success ? 'Job cancelled' : result.error || 'Failed' })
    load()
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold text-gray-900">Job Dashboard</h1>

      {feedback && (
        <div className={`rounded-lg p-4 text-sm flex items-center gap-2 ${feedback.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {feedback.message}
          <button onClick={() => setFeedback(null)} className="ml-auto text-xs opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-5">
        <StatCard label="Running" value={String(stats.running || 0)} color="blue" />
        <StatCard label="Pending" value={String(stats.pending || 0)} color="amber" />
        <StatCard label="Completed" value={String(stats.completed || 0)} color="emerald" />
        <StatCard label="Failed" value={String(stats.failed || 0)} color="red" />
        <StatCard label="Success Rate" value={stats.successRate != null ? `${stats.successRate}%` : '—'} color="gray" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border bg-white p-4">
          <p className="text-xs text-gray-500">Avg Duration</p>
          <p className="text-xl font-bold text-gray-700">{formatDuration(stats.avgDurationMs)}</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-xs text-gray-500">Total Jobs</p>
          <p className="text-xl font-bold text-gray-700">{stats.running + stats.completed + stats.failed + stats.pending}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <select value={filter.status} onChange={e => setFilter(prev => ({ ...prev, status: e.target.value }))}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
          <option value="">All Statuses</option>
          <option value="PROCESSING">Running</option>
          <option value="PENDING">Pending</option>
          <option value="COMPLETED">Completed</option>
          <option value="FAILED">Failed</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <select value={filter.type} onChange={e => setFilter(prev => ({ ...prev, type: e.target.value }))}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
          <option value="">All Types</option>
          <option value="PROVIDER_SYNC">Provider Sync</option>
          <option value="CATALOG_PIPELINE">Catalog Pipeline</option>
        </select>
        <button onClick={load} className="text-xs text-cyan-600 hover:text-cyan-700">Refresh</button>
      </div>

      {/* Jobs Table */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50/80 text-[11px] uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Provider</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-center">Progress</th>
                <th className="px-3 py-2 text-center">Attempts</th>
                <th className="px-3 py-2 text-right">Duration</th>
                <th className="px-3 py-2 text-left">Started</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={8} className="px-3 py-12 text-center text-gray-400">Loading...</td></tr>
              ) : jobs.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-12 text-center text-gray-400">No jobs found</td></tr>
              ) : jobs.map((job: any) => {
                const duration = job.startedAt && job.finishedAt
                  ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
                  : null
                return (
                  <tr key={job.id} className="hover:bg-gray-50/50">
                    <td className="px-3 py-3">
                      <span className="text-sm font-medium text-gray-900">{TYPE_LABELS[job.type] || job.type}</span>
                      {job.triggerSource && <div className="text-xs text-gray-400">{job.triggerSource}</div>}
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-500">{job.providerId || 'All'}</td>
                    <td className="px-3 py-3 text-center">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLORS[job.status] || ''}`}>
                        {job.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-center">
                      {job.progress != null ? (
                        <div className="flex items-center gap-2">
                          <div className="w-16 bg-gray-100 rounded-full h-1.5">
                            <div className="bg-cyan-500 h-1.5 rounded-full" style={{ width: `${job.progress}%` }} />
                          </div>
                          <span className="text-xs text-gray-500">{job.progress}%</span>
                        </div>
                      ) : job.status === 'COMPLETED' ? (
                        <span className="text-xs text-emerald-600">100%</span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center text-xs text-gray-500">
                      {job.attempts}/{job.maxAttempts}
                    </td>
                    <td className="px-3 py-3 text-right text-xs text-gray-500 font-mono">
                      {formatDuration(duration)}
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-400">{relativeTime(job.startedAt || job.createdAt)}</td>
                    <td className="px-3 py-3 text-right">
                      {(job.status === 'PROCESSING' || job.status === 'PENDING') && (
                        <button
                          onClick={() => handleCancel(job.id)}
                          className="rounded-md bg-red-100 px-2 py-1 text-[10px] font-medium text-red-700 hover:bg-red-200"
                        >
                          Cancel
                        </button>
                      )}
                      {job.status === 'FAILED' && job.lastError && (
                        <span className="text-xs text-red-500" title={job.lastError}>Error</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  const c: Record<string, string> = {
    blue: 'bg-blue-50 border-blue-100 text-blue-700',
    amber: 'bg-amber-50 border-amber-100 text-amber-700',
    emerald: 'bg-emerald-50 border-emerald-100 text-emerald-700',
    red: 'bg-red-50 border-red-100 text-red-700',
    gray: 'bg-gray-50 border-gray-100 text-gray-700',
  }
  return (
    <div className={`rounded-lg border p-3 text-center ${c[color] || c.gray}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs mt-1 opacity-80">{label}</p>
    </div>
  )
}
