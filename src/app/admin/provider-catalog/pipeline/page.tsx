import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { STAGE_LABELS } from '@/lib/catalog-pipeline'

function fmt(v: any): string {
  if (v == null || v === '') return '—'
  return String(v)
}

function timeAgo(d: Date): string {
  const secs = Math.floor((Date.now() - new Date(d).getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

function statusColor(status: string): string {
  switch (status) {
    case 'SUCCESS': return 'bg-emerald-100 text-emerald-700'
    case 'PARTIAL': return 'bg-amber-100 text-amber-700'
    case 'FAILED': return 'bg-red-100 text-red-700'
    case 'RUNNING': return 'bg-blue-100 text-blue-700'
    default: return 'bg-gray-100 text-gray-600'
  }
}

export default async function CatalogPipelinePage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const [recentRuns, allPackages, allProviders] = await Promise.all([
    prisma.catalogPipelineRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 50,
      include: { stages: { orderBy: { createdAt: 'asc' } } },
    }),
    prisma.providerPackage.findMany({
      include: { provider: { select: { name: true } } },
    }),
    prisma.provider.findMany({
      where: { status: { notIn: ['ARCHIVED'] } },
      select: { id: true, name: true, code: true },
    }),
  ])

  const lastRun = recentRuns[0] || null

  const synced = allPackages.length
  const configured = allPackages.filter(p =>
    p.configurationStatus === 'CONFIGURED' || p.configurationStatus === 'AUTO_CONFIGURED'
  ).length
  const published = allPackages.filter(p => p.publishStatus === 'PUBLISHED').length
  const ready = allPackages.filter(p => p.publishStatus === 'READY').length
  const hidden = allPackages.filter(p => p.publishStatus === 'HIDDEN').length
  const cheapestWinners = allPackages.filter(p => p.isCheapestCandidate).length

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Catalog Pipeline</h2>
          <p className="text-gray-600">Observability and diagnostics for every stage of the catalog pipeline</p>
        </div>
        <Link href="/admin/provider-catalog/health" className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
          ← Back to Health
        </Link>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Last Run</p>
          <p className={`text-lg font-bold ${lastRun ? '' : 'text-gray-400'}`}>{lastRun ? timeAgo(lastRun.startedAt) : 'Never'}</p>
          {lastRun && <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColor(lastRun.status)}`}>{lastRun.status}</span>}
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Synced</p>
          <p className="text-2xl font-bold text-gray-900">{synced}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Configured</p>
          <p className="text-2xl font-bold text-cyan-600">{configured}</p>
          <p className="text-[10px] text-gray-400">{Math.round(configured / Math.max(synced, 1) * 100)}% of synced</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Health Eligible</p>
          <p className="text-2xl font-bold text-emerald-600">{configured}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Cheapest Winners</p>
          <p className="text-2xl font-bold text-cyan-600">{cheapestWinners}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Ready for Publish</p>
          <p className="text-2xl font-bold text-blue-600">{ready}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Published</p>
          <p className="text-2xl font-bold text-emerald-600">{published}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Hidden / Blocked</p>
          <p className="text-2xl font-bold text-red-600">{hidden}</p>
        </div>
      </div>

      {/* Pipeline Runs Table */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b">
          <h3 className="text-base font-semibold text-gray-900">Recent Pipeline Runs ({recentRuns.length})</h3>
          <p className="text-xs text-gray-500 mt-1">Each major catalog action creates a traceable pipeline run</p>
        </div>
        {recentRuns.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            No pipeline runs recorded yet. Perform a sync, configuration, or publish action to create one.
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500 border-b bg-gray-50">
                <th className="pb-2 pt-2 px-3">Started</th>
                <th className="pb-2 pt-2 px-3">Provider</th>
                <th className="pb-2 pt-2 px-3">Trigger</th>
                <th className="pb-2 pt-2 px-3">Status</th>
                <th className="pb-2 pt-2 px-3 text-right">Duration</th>
                <th className="pb-2 pt-2 px-3 text-right">Input</th>
                <th className="pb-2 pt-2 px-3 text-right">Output</th>
                <th className="pb-2 pt-2 px-3">Stages</th>
                <th className="pb-2 pt-2 px-3">Error</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map(run => (
                <tr key={run.id} className="border-t hover:bg-gray-50">
                  <td className="py-2 px-3 text-gray-600 whitespace-nowrap">{timeAgo(run.startedAt)}</td>
                  <td className="py-2 px-3 text-gray-600">{run.providerCode || 'All'}</td>
                  <td className="py-2 px-3"><span className="text-gray-500">{run.trigger}</span></td>
                  <td className="py-2 px-3"><span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColor(run.status)}`}>{run.status}</span></td>
                  <td className="py-2 px-3 text-right font-mono text-gray-600">{run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="py-2 px-3 text-right text-gray-600">{run.totalInput}</td>
                  <td className="py-2 px-3 text-right text-gray-600">{run.totalOutput}</td>
                  <td className="py-2 px-3">
                    <div className="flex gap-1 flex-wrap">
                      {run.stages.map(s => (
                        <span key={s.id} className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium ${statusColor(s.status)}`} title={`${STAGE_LABELS[s.stage as keyof typeof STAGE_LABELS] || s.stage}: ${s.passed} passed, ${s.failed} failed`}>
                          {s.stage.slice(0, 4)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 px-3 text-red-600 max-w-[150px] truncate">{run.errorMessage ? fmt(run.errorMessage) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>

      {/* Provider Summary */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b">
          <h3 className="text-base font-semibold text-gray-900">Provider Summary</h3>
          <p className="text-xs text-gray-500 mt-1">Per-provider catalog state</p>
        </div>
        <div className="overflow-x-auto p-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="pb-2 pr-3">Provider</th>
                <th className="pb-2 pr-3 text-right">Synced</th>
                <th className="pb-2 pr-3 text-right">Configured</th>
                <th className="pb-2 pr-3 text-right">Ready</th>
                <th className="pb-2 pr-3 text-right">Published</th>
                <th className="pb-2 pr-3 text-right">Hidden</th>
                <th className="pb-2 pr-3 text-right">Cheapest</th>
              </tr>
            </thead>
            <tbody>
              {allProviders.map(prov => {
                const provPkgs = allPackages.filter(p => p.providerId === prov.id)
                return (
                  <tr key={prov.id} className="border-t">
                    <td className="py-2 pr-3 text-gray-700 font-medium">{prov.name} ({prov.code})</td>
                    <td className="py-2 pr-3 text-right text-gray-600">{provPkgs.length}</td>
                    <td className="py-2 pr-3 text-right text-gray-600">{provPkgs.filter(p => p.configurationStatus === 'CONFIGURED' || p.configurationStatus === 'AUTO_CONFIGURED').length}</td>
                    <td className="py-2 pr-3 text-right text-gray-600">{provPkgs.filter(p => p.publishStatus === 'READY').length}</td>
                    <td className="py-2 pr-3 text-right text-emerald-600">{provPkgs.filter(p => p.publishStatus === 'PUBLISHED').length}</td>
                    <td className="py-2 pr-3 text-right text-amber-600">{provPkgs.filter(p => p.publishStatus === 'HIDDEN').length}</td>
                    <td className="py-2 pr-3 text-right text-cyan-600">{provPkgs.filter(p => p.isCheapestCandidate).length}</td>
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
