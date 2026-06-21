import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { getAuditData } from '@/lib/actions/provider-audit'
import ProviderAuditClient from './ProviderAuditClient'

const STATUS_STYLES: Record<string, { label: string; color: string }> = {
  CERTIFIED: { label: 'Certified', color: 'bg-emerald-50 text-emerald-700 ring-emerald-300' },
  IN_PROGRESS: { label: 'In Progress', color: 'bg-blue-50 text-blue-700 ring-blue-300' },
  FAILED: { label: 'Failed', color: 'bg-red-50 text-red-700 ring-red-300' },
  NOT_STARTED: { label: 'Not Started', color: 'bg-gray-50 text-gray-500 ring-gray-200' },
}

function SummaryCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${value > 0 ? 'text-gray-900' : 'text-gray-300'}`}>{value}</p>
    </div>
  )
}

export default async function ProviderAuditPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const auditData = await getAuditData()

  const total = auditData.length
  const certified = auditData.filter(a => a.audit.certificationStatus === 'CERTIFIED').length
  const inProgress = auditData.filter(a => a.audit.certificationStatus === 'IN_PROGRESS').length
  const failed = auditData.filter(a => a.audit.certificationStatus === 'FAILED').length
  const notStarted = auditData.filter(a => a.audit.certificationStatus === 'NOT_STARTED').length

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Provider Certification Audit</h2>
        <p className="mt-1 text-sm text-gray-500">Verify providers are production-ready before go-live</p>
      </div>

      {/* Dashboard cards */}
      <div className="mb-6 grid gap-4 sm:grid-cols-5">
        <SummaryCard label="Total Providers" value={total} />
        <SummaryCard label="Certified" value={certified} />
        <SummaryCard label="In Progress" value={inProgress} />
        <SummaryCard label="Failed" value={failed} />
        <SummaryCard label="Not Started" value={notStarted} />
      </div>

      {/* Provider audit table */}
      <div className="space-y-6">
        {auditData.map(({ provider, audit, checks, notes }) => {
          const st = STATUS_STYLES[audit.certificationStatus] || STATUS_STYLES.NOT_STARTED
          const passPct = audit.totalChecks > 0 ? Math.round((audit.passCount / audit.totalChecks) * 100) : 0

          return (
            <div key={audit.id} className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
              {/* Provider header */}
              <div className="flex items-center justify-between border-b border-gray-50 bg-gray-50/50 px-6 py-4">
                <div className="flex items-center gap-3">
                  <div>
                    <h3 className="font-semibold text-gray-900">{provider.name}</h3>
                    <p className="text-xs text-gray-500 font-mono">{provider.code} · {provider.environment} · {provider.status}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">{passPct}% pass</span>
                  <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ${st.color}`}>{st.label}</span>
                </div>
              </div>

              {/* Audit controls */}
              <ProviderAuditClient audit={audit} checks={checks} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
