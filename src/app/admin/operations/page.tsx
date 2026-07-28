'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  getHealthAction, getProviderHealthAction, getPipelineMetricsAction,
  getSystemMetricsAction, getAlertsAction, getRunningJobsAction, getErrorsAction,
} from '@/lib/actions/operations-actions'

const HEALTH_COLORS: Record<string, string> = {
  HEALTHY: 'bg-emerald-100 text-emerald-700',
  WARNING: 'bg-amber-100 text-amber-700',
  CRITICAL: 'bg-red-100 text-red-700',
  OFFLINE: 'bg-gray-100 text-gray-400',
}

const SEVERITY_COLORS: Record<string, string> = {
  info: 'bg-cyan-100 text-cyan-700',
  warning: 'bg-amber-100 text-amber-700',
  critical: 'bg-red-100 text-red-700',
}

function formatMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function relativeTime(date: string | Date | null): string {
  if (!date) return 'Never'
  const d = new Date(date)
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

export default function OperationsDashboard() {
  const [loading, setLoading] = useState(true)
  const [health, setHealth] = useState<any>({})
  const [providers, setProviders] = useState<any[]>([])
  const [pipeline, setPipeline] = useState<any[]>([])
  const [metrics, setMetrics] = useState<any>({})
  const [alerts, setAlerts] = useState<any[]>([])
  const [runningJobs, setRunningJobs] = useState<any[]>([])
  const [errors, setErrors] = useState<any[]>([])
  const [errorFilter, setErrorFilter] = useState({ type: '', providerId: '' })
  const [tab, setTab] = useState('overview')
  const [autoRefresh, setAutoRefresh] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [h, p, pl, m, a, rj, er] = await Promise.all([
        getHealthAction(), getProviderHealthAction(), getPipelineMetricsAction(),
        getSystemMetricsAction(), getAlertsAction(), getRunningJobsAction(),
        getErrorsAction(errorFilter),
      ])
      setHealth(h); setProviders(p); setPipeline(pl)
      setMetrics(m); setAlerts(a); setRunningJobs(rj); setErrors(er.items)
    } catch { /* silent */ }
    setLoading(false)
  }, [errorFilter])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(load, 15000)
    return () => clearInterval(interval)
  }, [autoRefresh, load])

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Operations Center</h1>
          <p className="text-sm text-gray-500 mt-1">System health, monitoring, and diagnostics</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="rounded border-gray-300" />
            Auto-refresh (15s)
          </label>
          <button onClick={load} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">Refresh</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {(['overview', 'providers', 'pipeline', 'jobs', 'errors', 'alerts'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${tab === t ? 'text-cyan-700 border-b-2 border-cyan-600' : 'text-gray-500 hover:text-gray-700'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {tab === 'overview' && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-4">
            <Card label="System Health" value={health.successRate != null ? `${health.successRate}%` : '—'} sub="Success rate" />
            <Card label="Running Jobs" value={String(health.runningJobs || 0)} sub={`${health.activeWorkers || 0} workers`} />
            <Card label="Failed (24h)" value={String(health.failedJobs24h || 0)} sub="Last 24 hours" />
            <Card label="Pending Reviews" value={String(health.pendingReviews || 0)} sub="In review queue" />
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Card label="Active Providers" value={String(health.activeProviders || 0)} sub="Active + Testing" />
            <Card label="Avg Sync" value={formatMs(health.avgSyncDurationMs)} sub="Duration" />
            <Card label="Avg Pipeline" value={formatMs(health.avgPipelineDurationMs)} sub="Duration" />
            <Card label="Last Sync" value={relativeTime(health.lastSuccessfulSync)} sub={health.lastSuccessfulSync ? new Date(health.lastSuccessfulSync).toLocaleTimeString() : ''} />
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Card label="Jobs/Hour" value={String(metrics.jobsPerHour || 0)} sub="Last hour" />
            <Card label="Queue Length" value={String(metrics.queueLength || 0)} sub="Pending jobs" />
            <Card label="Provider Failures" value={String(metrics.providerFailures || 0)} sub="24h" />
            <Card label="Throughput" value={String(metrics.pipelineThroughput || 0)} sub="Syncs/day" />
          </div>
        </div>
      )}

      {/* ── PROVIDERS ── */}
      {tab === 'providers' && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50/80 text-[11px] uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">Provider</th>
                  <th className="px-3 py-2 text-center">Health</th>
                  <th className="px-3 py-2 text-center">Status</th>
                  <th className="px-3 py-2 text-right">Packages</th>
                  <th className="px-3 py-2 text-right">Success Rate</th>
                  <th className="px-3 py-2 text-right">Retries</th>
                  <th className="px-3 py-2 text-left">Last Sync</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {providers.map(p => (
                  <tr key={p.providerId} className="hover:bg-gray-50/50">
                    <td className="px-3 py-3">
                      <div className="text-sm font-medium text-gray-900">{p.providerName}</div>
                      <div className="text-xs text-gray-400">{p.providerCode}</div>
                    </td>
                    <td className="px-3 py-3 text-center">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${HEALTH_COLORS[p.health]}`}>{p.health}</span>
                    </td>
                    <td className="px-3 py-3 text-center text-xs text-gray-500">{p.status}</td>
                    <td className="px-3 py-3 text-right text-xs text-gray-700">{p.packagesSynced}</td>
                    <td className="px-3 py-3 text-right text-xs text-gray-700">{p.successRate != null ? `${p.successRate}%` : '—'}</td>
                    <td className="px-3 py-3 text-right text-xs text-amber-600">{p.retryCount}</td>
                    <td className="px-3 py-3 text-xs text-gray-400">{relativeTime(p.lastSyncAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── PIPELINE ── */}
      {tab === 'pipeline' && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50/80 text-[11px] uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">Stage</th>
                  <th className="px-3 py-2 text-center">Status</th>
                  <th className="px-3 py-2 text-right">Avg Duration</th>
                  <th className="px-3 py-2 text-right">Errors</th>
                  <th className="px-3 py-2 text-right">Packages</th>
                  <th className="px-3 py-2 text-left">Last Run</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pipeline.map((s: any) => (
                  <tr key={s.stage} className="hover:bg-gray-50/50">
                    <td className="px-3 py-3 text-sm font-medium text-gray-900">{s.stage.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-3 text-center">
                      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">{s.status}</span>
                    </td>
                    <td className="px-3 py-3 text-right text-xs text-gray-700">{formatMs(s.avgDurationMs)}</td>
                    <td className="px-3 py-3 text-right text-xs text-red-600">{s.errorCount}</td>
                    <td className="px-3 py-3 text-right text-xs text-gray-700">{s.packagesProcessed}</td>
                    <td className="px-3 py-3 text-xs text-gray-400">{relativeTime(s.lastExecutedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── JOBS (Live Monitor) ── */}
      {tab === 'jobs' && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b bg-gray-50/50">
            <span className="text-sm font-semibold text-gray-700">Live Job Monitor <span className="text-gray-400 font-normal">({runningJobs.length} running)</span></span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50/80 text-[11px] uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-left">Provider</th>
                  <th className="px-3 py-2 text-left">Worker</th>
                  <th className="px-3 py-2 text-center">Progress</th>
                  <th className="px-3 py-2 text-center">Attempts</th>
                  <th className="px-3 py-2 text-left">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {runningJobs.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-12 text-center text-gray-400">No running jobs</td></tr>
                ) : runningJobs.map((j: any) => (
                  <tr key={j.id} className="hover:bg-gray-50/50">
                    <td className="px-3 py-3 text-xs font-medium text-gray-900">{j.type}</td>
                    <td className="px-3 py-3 text-xs text-gray-500">{j.providerId || '—'}</td>
                    <td className="px-3 py-3 text-xs text-gray-400 font-mono">{j.workerId?.slice(0, 12) || '—'}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-20 bg-gray-100 rounded-full h-1.5"><div className="bg-cyan-500 h-1.5 rounded-full" style={{ width: `${j.progress || 0}%` }} /></div>
                        <span className="text-xs text-gray-500">{j.progress || 0}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-center text-xs text-gray-500">{j.attempts}/{j.maxAttempts}</td>
                    <td className="px-3 py-3 text-xs text-gray-400">{relativeTime(j.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── ERRORS ── */}
      {tab === 'errors' && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <select value={errorFilter.type} onChange={e => setErrorFilter(p => ({ ...p, type: e.target.value }))}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
              <option value="">All Types</option>
              <option value="PROVIDER_SYNC">Provider Sync</option>
              <option value="CATALOG_PIPELINE">Catalog Pipeline</option>
            </select>
            <input type="text" placeholder="Provider ID" value={errorFilter.providerId}
              onChange={e => setErrorFilter(p => ({ ...p, providerId: e.target.value }))}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm w-40" />
            <button onClick={load} className="text-xs text-cyan-600 hover:text-cyan-700">Search</button>
          </div>
          <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50/80 text-[11px] uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Provider</th>
                    <th className="px-3 py-2 text-left">Error</th>
                    <th className="px-3 py-2 text-center">Retryable?</th>
                    <th className="px-3 py-2 text-right">Attempts</th>
                    <th className="px-3 py-2 text-left">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {errors.length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-12 text-center text-gray-400">No errors found</td></tr>
                  ) : errors.map((e: any) => (
                    <tr key={e.id} className="hover:bg-gray-50/50">
                      <td className="px-3 py-3 text-xs text-gray-700">{e.type}</td>
                      <td className="px-3 py-3 text-xs text-gray-500">{e.providerId || '—'}</td>
                      <td className="px-3 py-3 text-xs text-red-600 truncate max-w-[300px]" title={e.lastError}>{e.lastError?.slice(0, 80)}</td>
                      <td className="px-3 py-3 text-center">
                        <span className={`text-[10px] font-medium ${e.retryClassification === 'NON_RETRYABLE' ? 'text-red-600' : 'text-amber-600'}`}>
                          {e.retryClassification || 'RETRYABLE'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-xs text-gray-500">{e.attempts}</td>
                      <td className="px-3 py-3 text-xs text-gray-400">{relativeTime(e.finishedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── ALERTS ── */}
      {tab === 'alerts' && (
        <div className="space-y-3">
          {alerts.map(alert => (
            <div key={alert.id} className={`rounded-lg border p-4 flex items-start gap-3 ${alert.severity === 'critical' ? 'border-red-200 bg-red-50' : alert.severity === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-cyan-100 bg-cyan-50'}`}>
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium mt-0.5 ${SEVERITY_COLORS[alert.severity]}`}>
                {alert.severity}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">{alert.type.replace(/_/g, ' ')}</p>
                <p className="text-xs text-gray-600 mt-0.5">{alert.message}</p>
                {alert.suggestedAction && <p className="text-xs text-gray-400 mt-1">Suggested: {alert.suggestedAction}</p>}
              </div>
              <span className="text-xs text-gray-400 shrink-0">{relativeTime(alert.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Card({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      <p className="text-xs text-gray-400 mt-0.5">{sub}</p>
    </div>
  )
}
