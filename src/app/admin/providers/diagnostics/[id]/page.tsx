import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { getProviderDiagnosticsDetail } from '@/lib/services/operations/provider-diagnostics'

const SEVERITY_COLORS: Record<string, string> = {
  HEALTHY: 'bg-emerald-100 text-emerald-800',
  DEGRADED: 'bg-amber-100 text-amber-800',
  OFFLINE: 'bg-gray-100 text-gray-500',
  UNKNOWN: 'bg-gray-100 text-gray-500',
}

const VERDICT_COLORS: Record<string, string> = {
  READY: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  DEGRADED: 'bg-amber-100 text-amber-800 border-amber-300',
  BLOCKED: 'bg-red-100 text-red-800 border-red-300',
  UNKNOWN: 'bg-gray-100 text-gray-500 border-gray-300',
}

const CHECK_COLORS: Record<string, string> = {
  PASS: 'bg-emerald-100 text-emerald-700',
  WARN: 'bg-amber-100 text-amber-700',
  FAIL: 'bg-red-100 text-red-600',
}

export default async function ProviderDiagnosticDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const d = await getProviderDiagnosticsDetail(params.id)
  if (!d) return <div className="p-6"><p className="text-red-600">Provider not found.</p></div>

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <Link href="/admin/providers/diagnostics" className="text-sm text-gray-400 hover:text-gray-600">← Back</Link>
        <h2 className="text-2xl font-bold text-gray-900">{d.name}</h2>
        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${SEVERITY_COLORS[d.severity]}`}>{d.severity}</span>
        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${VERDICT_COLORS[d.verdict]}`}>Purchase: {d.verdict}</span>
        <span className="text-xs text-gray-400">{d.verdictReason}</span>
      </div>

      {d.recommendations.length > 0 && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 space-y-2">
          <p className="text-sm font-semibold text-blue-800">Recommended Actions</p>
          {d.recommendations.map((r, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="rounded bg-blue-200 px-1.5 py-0.5 font-mono text-[10px] text-blue-700">{r.code}</span>
              <span className="text-blue-600">{r.action}</span>
            </div>
          ))}
        </div>
      )}

      {d.alerts.length > 0 && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 space-y-2">
          <p className="text-sm font-semibold text-orange-800">Active Alerts</p>
          {d.alerts.map((a, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="rounded bg-orange-200 px-1.5 py-0.5 font-mono text-[10px] text-orange-700">{a.code}</span>
              <span className="text-orange-600">{a.message?.substring(0, 200)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Overview */}
      <Section title="Overview">
        <KV label="Code" value={d.code} />
        <KV label="Adapter" value={d.adapterStrategy || d.type} />
        <KV label="Status" value={d.status} />
        <KV label="Environment" value={d.environment || 'N/A'} />
        <KV label="Capabilities" value={d.enabledCapabilities.join(', ') || 'None'} />
      </Section>

      {/* Auth */}
      <Section title="Authentication">
        <KV label="Configured" value={d.auth.configured ? 'Yes' : 'No'} />
        <KV label="Strategy" value={d.auth.strategy || 'N/A'} />
        <KV label="Last Test" value={d.auth.lastConnectionTest ? new Date(d.auth.lastConnectionTest).toISOString() : 'Never'} />
        <KV label="Last Failure" value={d.auth.lastAuthFailure ? new Date(d.auth.lastAuthFailure).toISOString() : 'None'} />
      </Section>

      {/* Purchase */}
      <Section title="Purchase Readiness">
        {d.purchase.checks.map((c, i) => (
          <div key={i} className="flex items-center justify-between py-1">
            <span className="text-sm text-gray-600">{c.name}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${CHECK_COLORS[c.status]}`}>{c.status}</span>
            <span className="text-xs text-gray-400 ml-2">{c.message}</span>
          </div>
        ))}
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-gray-50 p-2"><p className="text-lg font-bold text-gray-900">{d.purchase.configuredPackages}</p><p className="text-[10px] text-gray-500">Configured</p></div>
          <div className="rounded-lg bg-emerald-50 p-2"><p className="text-lg font-bold text-emerald-700">{d.purchase.purchaseReadyPackages}</p><p className="text-[10px] text-gray-500">Ready</p></div>
          <div className="rounded-lg bg-red-50 p-2"><p className="text-lg font-bold text-red-600">{d.purchase.blockedPackages}</p><p className="text-[10px] text-gray-500">Blocked</p></div>
        </div>
      </Section>

      {/* Balance */}
      <Section title="Provider Balance">
        <KV label="Known" value={d.balance.known ? 'Yes' : 'No'} />
        <KV label="Currency" value={d.balance.currency || 'N/A'} />
        <KV label="Last Refresh" value={d.balance.lastRefresh ? new Date(d.balance.lastRefresh).toISOString() : 'Never'} />
        <KV label="Low Balance" value={d.balance.lowBalance ? 'Yes' : 'No'} />
        {d.balance.latestError && (
          <div className="mt-1 rounded bg-red-50 p-2 text-xs text-red-600">{d.balance.latestError}</div>
        )}
      </Section>

      {/* Catalog */}
      <Section title="Catalog Health">
        <KV label="Total" value={d.catalog.total} />
        <KV label="Configured" value={d.catalog.configured} />
        <KV label="Published" value={d.catalog.published} />
        <KV label="Purchase-ready" value={d.catalog.purchaseReady} />
        <KV label="Blocked by pricing" value={d.catalog.blockedByPricing} />
        <KV label="Blocked by cost" value={d.catalog.blockedByCost} />
        <KV label="Blocked by snapshot" value={d.catalog.blockedBySnapshot} />
        <KV label="Stale bundles" value={d.catalog.staleBundles} />
      </Section>

      {/* Travel Date */}
      <Section title="Travel Date">
        {d.travelDate.required ? (
          <>
            <KV label="Required" value="Yes" />
            <KV label="Default Policy" value={d.travelDate.defaultPolicy || 'N/A'} />
            <KV label="Default Requirement" value={d.travelDate.defaultRequirement || 'N/A'} />
            <KV label="Matching" value={d.travelDate.policyMatches} />
            <KV label="Mismatches" value={d.travelDate.policyMismatches} />
          </>
        ) : (
          <p className="text-sm text-gray-400">Not required for this provider</p>
        )}
      </Section>

      {/* Circuit */}
      <Section title="Circuit Breaker">
        <KV label="State" value={d.circuit.state} />
        <KV label="Failure Count" value={d.circuit.failureCount} />
        <KV label="Opened At" value={d.circuit.openedAt ? new Date(d.circuit.openedAt).toISOString() : 'N/A'} />
        <KV label="Failover Eligible" value={d.circuit.failoverEligible ? 'Yes' : 'No'} />
      </Section>

      {/* Webhooks */}
      <Section title="Webhooks">
        <KV label="Configured" value={d.webhooks.configured ? 'Yes' : 'No'} />
        <KV label="Last Event" value={d.webhooks.lastEventReceived ? new Date(d.webhooks.lastEventReceived).toISOString() : 'None'} />
        <KV label="Failed" value={d.webhooks.failedCount} />
      </Section>

      {/* Recent Attempts */}
      <Section title="Recent Purchases">
        {d.recentAttempts.length === 0 ? (
          <p className="text-sm text-gray-400">No purchase attempts recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-2 py-2">Order</th>
                  <th className="px-2 py-2">#</th>
                  <th className="px-2 py-2">Time</th>
                  <th className="px-2 py-2">Result</th>
                  <th className="px-2 py-2">Duration</th>
                  <th className="px-2 py-2">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {d.recentAttempts.map((a, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-2 py-1.5 font-mono text-[10px]">{a.orderId.slice(-8)}</td>
                    <td className="px-2 py-1.5">{a.attemptNumber}</td>
                    <td className="px-2 py-1.5 text-gray-500">{new Date(a.timestamp).toLocaleTimeString()}</td>
                    <td className="px-2 py-1.5">
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${a.success ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600'}`}>
                        {a.success ? 'OK' : 'FAIL'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-gray-400">{a.duration != null ? `${a.duration}ms` : '-'}</td>
                    <td className="px-2 py-1.5 text-gray-500 max-w-[200px] truncate">{a.errorMessage || a.errorCode || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Last Request/Response */}
      <Section title="Last Request">
        <KV label="Endpoint" value={d.lastRequest.endpointPath || 'N/A'} />
        <KV label="Auth Present" value={d.lastRequest.authPresent ? 'Yes' : 'No'} />
        <KV label="Travel Date" value={d.lastRequest.travelDatePresent ? 'Sent' : 'Not sent'} />
        <KV label="Plan ID" value={d.lastRequest.planIdPresent ? 'Sent' : 'Missing'} />
      </Section>

      <Section title="Last Response">
        <KV label="Status" value={d.lastResponse.httpStatus ? String(d.lastResponse.httpStatus) : 'N/A'} />
        <KV label="Result" value={d.lastResponse.result || 'N/A'} />
        <KV label="Error Code" value={d.lastResponse.errorCode || 'None'} />
        {d.lastResponse.message && (
          <div className="mt-1 rounded bg-gray-50 p-2 text-xs text-gray-600">{d.lastResponse.message}</div>
        )}
        <KV label="Retry Class" value={d.lastResponse.retryClass || 'N/A'} />
        <KV label="Reconciliation" value={d.lastResponse.reconciliationRequired ? 'Yes' : 'No'} />
      </Section>

      {/* Failure Classification */}
      <Section title="Failure Classification">
        {d.failureCategories.length === 0 ? (
          <p className="text-sm text-gray-400">No failures recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-2 py-2">Category</th>
                  <th className="px-2 py-2 text-center">1h</th>
                  <th className="px-2 py-2 text-center">24h</th>
                  <th className="px-2 py-2 text-center">7d</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {d.failureCategories.map((f, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1.5 font-medium">{f.category}</td>
                    <td className="px-2 py-1.5 text-center">{f.count1h}</td>
                    <td className="px-2 py-1.5 text-center">{f.count24h}</td>
                    <td className="px-2 py-1.5 text-center">{f.count7d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function KV({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900 ml-4 text-right">{value ?? 'N/A'}</span>
    </div>
  )
}
