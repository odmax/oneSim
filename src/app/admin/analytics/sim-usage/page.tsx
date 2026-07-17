import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { telnaGetDashboard, telnaGetAnalytics, telnaExportUsage, telnaGenerateAlerts } from '@/lib/actions/telna-usage-analytics'

function StatCard({ title, value, color }: { title: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    green: 'border-emerald-100 bg-gradient-to-br from-emerald-50 to-white text-emerald-700',
    red: 'border-red-100 bg-gradient-to-br from-red-50 to-white text-red-700',
    yellow: 'border-amber-100 bg-gradient-to-br from-amber-50 to-white text-amber-700',
    blue: 'border-blue-100 bg-gradient-to-br from-blue-50 to-white text-blue-700',
    purple: 'border-purple-100 bg-gradient-to-br from-purple-50 to-white text-purple-700',
  }
  const c = colors[color] || colors.blue
  return (
    <div className={`rounded-xl border p-5 shadow-sm ${c.split(' ').slice(0, 2).join(' ')}`}>
      <p className="text-xs font-medium uppercase tracking-wider opacity-80">{title}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  )
}

function TableCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-gray-50 px-5 py-4">
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}

export default async function AdminSimUsagePage({ searchParams }: { searchParams: { esimId?: string; tab?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const dashboard = await telnaGetDashboard()
  const dashboardData = dashboard.success ? dashboard.data : null

  let selectedEsim: any = null
  let analytics: any = null
  let usageRecords: any[] = []
  let sessions: any[] = []
  let alerts: any[] = []

  if (searchParams.esimId) {
    selectedEsim = await prisma.eSIM.findUnique({
      where: { id: searchParams.esimId },
      select: { id: true, iccid: true, status: true, packageName: true, dataUsedMB: true, dataTotalMB: true, dataRemainingMB: true, lastUsageSyncAt: true },
    })
    if (selectedEsim) {
      const analyticsResult = await telnaGetAnalytics(searchParams.esimId)
      if (analyticsResult.success) analytics = analyticsResult.data

      usageRecords = await prisma.usageRecord.findMany({
        where: { esimId: searchParams.esimId },
        orderBy: { timestamp: 'desc' },
        take: 50,
      })
      sessions = await prisma.usageSession.findMany({
        where: { esimId: searchParams.esimId },
        orderBy: { startTime: 'desc' },
        take: 20,
      })
      alerts = await prisma.usageAlert.findMany({
        where: { esimId: searchParams.esimId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
    }
  }

  const tab = searchParams.tab || 'dashboard'

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">SIM Usage Analytics</h1>
          <p className="mt-1 text-sm text-gray-500">Real-time operational visibility into SIM usage</p>
        </div>
        <div className="flex gap-2">
          <Link href="/admin/esims" className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">All eSIMs</Link>
          <Link href={`/admin/analytics/sim-usage`} className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700">Refresh</Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        <Link href={`/admin/analytics/sim-usage?tab=dashboard${searchParams.esimId ? `&esimId=${searchParams.esimId}` : ''}`}
          className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'dashboard' ? 'border-b-2 border-cyan-600 text-cyan-700' : 'text-gray-500 hover:text-gray-700'}`}>Dashboard</Link>
        <Link href={`/admin/analytics/sim-usage?tab=sessions${searchParams.esimId ? `&esimId=${searchParams.esimId}` : ''}`}
          className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'sessions' ? 'border-b-2 border-cyan-600 text-cyan-700' : 'text-gray-500 hover:text-gray-700'}`}>Sessions</Link>
        <Link href={`/admin/analytics/sim-usage?tab=alerts${searchParams.esimId ? `&esimId=${searchParams.esimId}` : ''}`}
          className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'alerts' ? 'border-b-2 border-cyan-600 text-cyan-700' : 'text-gray-500 hover:text-gray-700'}`}>Alerts</Link>
      </div>

      {/* Dashboard Tab */}
      {tab === 'dashboard' && (
        <>
          {/* Overview Stats */}
          {dashboardData && (
            <div className="grid gap-4 md:grid-cols-4">
              <StatCard title="Total SIMs" value={dashboardData.totalEsims.toString()} color="blue" />
              <StatCard title="Total Usage" value={`${Math.round(dashboardData.totalUsageMB / 1024)} GB`} color="green" />
              <StatCard title="Dormant (>30d)" value={dashboardData.dormantCount.toString()} color="yellow" />
              <StatCard title="Near Exhaustion" value={dashboardData.nearExhaustionCount.toString()} color="red" />
            </div>
          )}

          {/* Top Consumers */}
          {dashboardData && dashboardData.topConsumers.length > 0 && (
            <TableCard title="Top Consumers">
              <table className="w-full text-sm">
                <thead className="bg-gray-50/50">
                  <tr>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">ICCID</th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Total Usage</th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {dashboardData.topConsumers.map((c: any) => (
                    <tr key={c.esimId} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-5 py-3 font-mono text-sm text-gray-900">{c.iccid}</td>
                      <td className="px-5 py-3 text-sm text-gray-900 font-medium">{Math.round(c.totalMB / 1024)} GB</td>
                      <td className="px-5 py-3">
                        <Link href={`/admin/analytics/sim-usage?esimId=${c.esimId}&tab=dashboard`}
                          className="text-xs text-cyan-600 hover:underline">View Details</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>
          )}

          {/* SIM Usage Summary Stats */}
          {dashboardData && (
            <div className="grid gap-4 md:grid-cols-3">
              <StatCard title="Zero Usage SIMs" value={dashboardData.zeroUsageCount.toString()} color="purple" />
              <StatCard title="Total Alerts" value={dashboardData.totalAlerts.toString()} color="yellow" />
              <StatCard title="Total Sessions" value={dashboardData.totalSessions.toString()} color="blue" />
            </div>
          )}

          {/* Alerts Summary */}
          {dashboardData && dashboardData.totalAlerts > 0 && (
            <details className="rounded-xl border border-gray-100 bg-white shadow-sm">
              <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-gray-900">Recent Alerts ({dashboardData.totalAlerts})</summary>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50/50">
                    <tr>
                      <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Type</th>
                      <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Severity</th>
                      <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Message</th>
                      <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {(await prisma.usageAlert.findMany({ orderBy: { createdAt: 'desc' }, take: 20 })).map((a: any) => (
                      <tr key={a.id} className="hover:bg-gray-50/50 transition-colors">
                        <td className="px-5 py-3 font-mono text-xs text-gray-600">{a.alertType}</td>
                        <td className="px-5 py-3">
                          <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            a.severity === 'CRITICAL' ? 'bg-red-50 text-red-600' :
                            a.severity === 'WARNING' ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'
                          }`}>{a.severity}</span>
                        </td>
                        <td className="px-5 py-3 text-sm text-gray-700 max-w-md truncate">{a.message}</td>
                        <td className="px-5 py-3 text-xs text-gray-500">{a.createdAt.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {/* Per-SIM Detail */}
          {selectedEsim && analytics && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-gray-900">SIM Detail: {selectedEsim.iccid}</h2>
              <div className="grid gap-4 md:grid-cols-4">
                <StatCard title="Total Used" value={`${Math.round(analytics.totalUsedMB / 1024)} GB`} color="blue" />
                <StatCard title="Daily Avg" value={`${analytics.avgDailyMB} MB`} color="green" />
                <StatCard title="Remaining" value={analytics.remainingMB != null ? `${Math.round(analytics.remainingMB / 1024)} GB` : 'N/A'} color="yellow" />
                <StatCard title="Est. Remaining Days" value={analytics.remainingDays != null ? analytics.remainingDays.toString() : 'N/A'} color={analytics.remainingDays !== null && analytics.remainingDays < 7 ? 'red' : 'green'} />
              </div>

              {analytics.latestRecord && (
                <div className="rounded-xl border bg-white p-5 shadow-sm">
                  <h3 className="mb-3 text-sm font-semibold text-gray-700">Latest Usage Snapshot</h3>
                  <div className="mb-3 h-4 w-full rounded-full bg-gray-100">
                    <div className="h-4 rounded-full bg-gradient-to-r from-emerald-400 to-amber-400" style={{ width: `${Math.min(100, analytics.latestRecord.percentageUsed || 0)}%` }} />
                  </div>
                  <dl className="grid grid-cols-4 gap-4 text-sm">
                    <div><dt className="text-xs text-gray-500">Used</dt><dd className="font-medium">{analytics.latestRecord.dataUsedMB} MB</dd></div>
                    <div><dt className="text-xs text-gray-500">Remaining</dt><dd className="font-medium">{analytics.latestRecord.dataRemainingMB ?? 'N/A'} MB</dd></div>
                    <div><dt className="text-xs text-gray-500">Total</dt><dd className="font-medium">{analytics.latestRecord.dataTotalMB ?? 'N/A'} MB</dd></div>
                    <div><dt className="text-xs text-gray-500">Percentage</dt><dd className="font-medium">{analytics.latestRecord.percentageUsed ?? 'N/A'}%</dd></div>
                  </dl>
                </div>
              )}

              {/* Daily Charts */}
              {analytics.daily && analytics.daily.length > 0 && (
                <TableCard title="Daily Usage (Last 90 days)">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50/50">
                      <tr>
                        <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Date</th>
                        <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Usage (MB)</th>
                        <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Bar</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {analytics.daily.slice(0, 30).map((d: any) => {
                        const maxMb = Math.max(...analytics.daily.map((x: any) => x.mb), 1)
                        return (
                          <tr key={d.date} className="hover:bg-gray-50/50 transition-colors">
                            <td className="px-5 py-2 text-xs text-gray-600">{d.date}</td>
                            <td className="px-5 py-2 text-sm font-medium text-gray-900">{d.mb}</td>
                            <td className="px-5 py-2">
                              <div className="h-3 w-full rounded bg-gray-100">
                                <div className="h-3 rounded bg-cyan-500" style={{ width: `${(d.mb / maxMb) * 100}%` }} />
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </TableCard>
              )}

              {/* Weekly / Monthly Summary */}
              <div className="grid gap-6 md:grid-cols-2">
                {analytics.weekly && analytics.weekly.length > 0 && (
                  <TableCard title="Weekly Usage">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50/50">
                        <tr>
                          <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Week</th>
                          <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">MB</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {analytics.weekly.map((w: any) => (
                          <tr key={w.week} className="hover:bg-gray-50/50"><td className="px-5 py-2 text-xs text-gray-600">{w.week}</td><td className="px-5 py-2 text-sm font-medium">{w.mb}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </TableCard>
                )}
                {analytics.monthly && analytics.monthly.length > 0 && (
                  <TableCard title="Monthly Usage">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50/50">
                        <tr>
                          <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Month</th>
                          <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">MB</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {analytics.monthly.map((m: any) => (
                          <tr key={m.month} className="hover:bg-gray-50/50"><td className="px-5 py-2 text-xs text-gray-600">{m.month}</td><td className="px-5 py-2 text-sm font-medium">{m.mb}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </TableCard>
                )}
              </div>

              {/* Usage History */}
              {usageRecords.length > 0 && (
                <TableCard title="Usage History">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50/50">
                      <tr>
                        <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Timestamp</th>
                        <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Used (MB)</th>
                        <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Remaining</th>
                        <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Total</th>
                        <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">%</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {usageRecords.map((r: any) => (
                        <tr key={r.id} className="hover:bg-gray-50/50">
                          <td className="px-5 py-2 text-xs text-gray-500">{r.timestamp.toLocaleString()}</td>
                          <td className="px-5 py-2 text-sm font-medium text-gray-900">{r.dataUsedMB}</td>
                          <td className="px-5 py-2 text-sm text-gray-700">{r.dataRemainingMB ?? '-'}</td>
                          <td className="px-5 py-2 text-sm text-gray-700">{r.dataTotalMB ?? '-'}</td>
                          <td className="px-5 py-2 text-sm">{r.dataPercentage != null ? `${r.dataPercentage}%` : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableCard>
              )}
            </div>
          )}

          {!searchParams.esimId && (
            <div className="rounded-xl border border-dashed border-gray-200 bg-white p-12 text-center">
              <p className="text-sm text-gray-500">Select a SIM from the Top Consumers table or browse eSIMs to view detailed analytics.</p>
              <Link href="/admin/esims" className="mt-3 inline-block text-sm text-cyan-600 hover:underline">Browse eSIMs →</Link>
            </div>
          )}
        </>
      )}

      {/* Sessions Tab */}
      {tab === 'sessions' && (
        <div>
          {searchParams.esimId && sessions.length > 0 ? (
            <TableCard title="Session History">
              <table className="w-full text-sm">
                <thead className="bg-gray-50/50">
                  <tr>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Session ID</th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Start</th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Duration</th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Data</th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Country</th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Operator</th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Network</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {sessions.map((s: any) => (
                    <tr key={s.id} className="hover:bg-gray-50/50">
                      <td className="px-5 py-2 font-mono text-xs text-gray-500">{s.sessionId || '-'}</td>
                      <td className="px-5 py-2 text-xs text-gray-600">{s.startTime.toLocaleString()}</td>
                      <td className="px-5 py-2 text-sm text-gray-700">{s.durationSec != null ? `${Math.floor(s.durationSec / 60)}m ${s.durationSec % 60}s` : '-'}</td>
                      <td className="px-5 py-2 text-sm font-medium">{s.dataUsedMB != null ? `${s.dataUsedMB} MB` : '-'}</td>
                      <td className="px-5 py-2 text-sm text-gray-700">{s.country || '-'}</td>
                      <td className="px-5 py-2 text-sm text-gray-700">{s.operator || '-'}</td>
                      <td className="px-5 py-2 text-sm text-gray-500">{s.network || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>
          ) : (
            <div className="rounded-xl border border-dashed border-gray-200 bg-white p-12 text-center">
              <p className="text-sm text-gray-500">{searchParams.esimId ? 'No session data for this SIM.' : 'Select a SIM from the Dashboard tab to view sessions.'}</p>
            </div>
          )}
        </div>
      )}

      {/* Alerts Tab */}
      {tab === 'alerts' && (
        <div>
          {searchParams.esimId && alerts.length > 0 ? (
            <TableCard title="SIM Alerts">
              <table className="w-full text-sm">
                <thead className="bg-gray-50/50">
                  <tr>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Type</th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Severity</th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Message</th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Created</th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Acknowledged</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {alerts.map((a: any) => (
                    <tr key={a.id} className="hover:bg-gray-50/50">
                      <td className="px-5 py-2 font-mono text-xs text-gray-600">{a.alertType}</td>
                      <td className="px-5 py-2">
                        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          a.severity === 'CRITICAL' ? 'bg-red-50 text-red-600' :
                          a.severity === 'WARNING' ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'
                        }`}>{a.severity}</span>
                      </td>
                      <td className="px-5 py-2 text-sm text-gray-700 max-w-md truncate">{a.message}</td>
                      <td className="px-5 py-2 text-xs text-gray-500">{a.createdAt.toLocaleString()}</td>
                      <td className="px-5 py-2 text-xs text-gray-500">{a.acknowledgedAt ? a.acknowledgedAt.toLocaleString() : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>
          ) : (
            <div className="rounded-xl border border-dashed border-gray-200 bg-white p-12 text-center">
              <p className="text-sm text-gray-500">{searchParams.esimId ? 'No alerts for this SIM.' : 'Select a SIM from the Dashboard tab to view alerts.'}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
