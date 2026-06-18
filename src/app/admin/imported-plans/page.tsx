import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { getImportedPlans, type ImportedPlansFilters } from '@/lib/actions/imported-plans'
import FilterBar from './FilterBar'
import ImportedPlansActions from './ImportedPlansClient'

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  unconfigured: { label: 'Unconfigured', color: 'bg-orange-50 text-orange-600' },
  configured: { label: 'Configured', color: 'bg-blue-50 text-blue-600' },
  published: { label: 'Published', color: 'bg-emerald-50 text-emerald-600' },
  archived: { label: 'Archived', color: 'bg-amber-50 text-amber-600' },
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_LABELS[status] || { label: status, color: 'bg-gray-50 text-gray-600' }
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${s.color}`}>{s.label}</span>
}

export default async function ImportedPlansPage({
  searchParams,
}: {
  searchParams?: { provider?: string; status?: string; costMissing?: string; hidden?: string; search?: string; error?: string; success?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const providers = await prisma.provider.findMany({
    where: { status: { in: ['ACTIVE', 'TESTING', 'DEGRADED'] } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, code: true },
  })

  const filters: ImportedPlansFilters = {
    providerId: searchParams?.provider || undefined,
    status: (searchParams?.status as any) || undefined,
    costMissing: searchParams?.costMissing === '1',
    hiddenFromCatalog: searchParams?.hidden === '1',
    search: searchParams?.search || undefined,
  }

  const plans = await getImportedPlans(filters)

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Imported eSIM Plans</h2>
        <p className="mt-1 text-sm text-gray-500">
          Synced provider plans that need pricing/configuration before they are available to business clients.
        </p>
      </div>

      {searchParams?.error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{decodeURIComponent(searchParams.error)}</div>
      )}
      {searchParams?.success && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">{decodeURIComponent(searchParams.success)}</div>
      )}

      {/* Summary */}
      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        {(['unconfigured', 'configured', 'published', 'archived'] as const).map(status => {
          const count = plans.filter(p => p.status === status).length
          const s = STATUS_LABELS[status]
          return (
            <div key={status} className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
              <p className="text-xs font-medium text-gray-500">{s.label}</p>
              <p className={`mt-1 text-2xl font-bold ${count > 0 ? 'text-gray-900' : 'text-gray-300'}`}>{count}</p>
            </div>
          )
        })}
      </div>

      <FilterBar providers={providers} />

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-100 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Provider</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Plan ID / SKU</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Country</th>
              <th className="px-4 py-3 text-center font-medium text-gray-500">Data</th>
              <th className="px-4 py-3 text-center font-medium text-gray-500">Validity</th>
              <th className="px-4 py-3 text-right font-medium text-gray-500">Provider Price</th>
              <th className="px-4 py-3 text-right font-medium text-gray-500">Cost Price</th>
              <th className="px-4 py-3 text-right font-medium text-gray-500">Selling Price</th>
              <th className="px-4 py-3 text-right font-medium text-gray-500">Margin</th>
              <th className="px-4 py-3 text-right font-medium text-gray-500">Markup</th>
              <th className="px-4 py-3 text-center font-medium text-gray-500">Status</th>
              <th className="px-4 py-3 text-center font-medium text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody>
            {plans.length === 0 ? (
              <tr><td colSpan={13} className="px-4 py-12 text-center text-gray-400">No imported plans found.</td></tr>
            ) : (
              plans.map(plan => {
                const marginAmt = plan.costPriceUSD && plan.sellingPrice ? (plan.sellingPrice - plan.costPriceUSD) : null
                const marginPct = marginAmt != null && plan.sellingPrice && plan.sellingPrice > 0
                  ? ((marginAmt / plan.sellingPrice) * 100).toFixed(1) : null
                const markupPct = plan.costPriceUSD && plan.sellingPrice && plan.costPriceUSD > 0
                  ? (((plan.sellingPrice - plan.costPriceUSD) / plan.costPriceUSD) * 100).toFixed(1) : null
                return (
                  <tr key={plan.providerPackageId} className="border-t border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-3 text-gray-700 font-medium">{plan.providerName}</td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs text-gray-500">{plan.providerPlanId}</div>
                      {plan.sku && <div className="font-mono text-xs text-gray-400">{plan.sku}</div>}
                    </td>
                    <td className="px-4 py-3 text-gray-900 max-w-[200px] truncate">{plan.name}</td>
                    <td className="px-4 py-3 text-gray-600">{plan.country || plan.region || '—'}</td>
                    <td className="px-4 py-3 text-center text-gray-900">{plan.dataGB}GB</td>
                    <td className="px-4 py-3 text-center text-gray-900">{plan.validityDays}d</td>
                    <td className="px-4 py-3 text-right text-gray-500">
                      ${Number(plan.providerCostPrice).toFixed(2)}
                      <span className="text-xs text-gray-400 ml-1">{plan.providerCurrency}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {plan.costPriceUSD != null && plan.costPriceUSD > 0 ? (
                        <span className="font-medium text-gray-900">${plan.costPriceUSD.toFixed(2)}</span>
                      ) : (
                        <span className="text-amber-600 text-xs font-medium">Missing</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {plan.sellingPrice != null && plan.sellingPrice > 0 ? (
                        <span className="font-semibold text-gray-900">${plan.sellingPrice.toFixed(2)}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {marginPct != null ? (
                        <span className={`font-medium ${parseFloat(marginPct) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {marginPct}%
                        </span>
                      ) : (
                        <span className="text-gray-400">N/A</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {markupPct != null ? (
                        <span className="font-medium text-gray-700">{markupPct}%</span>
                      ) : (
                        <span className="text-gray-400">N/A</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusBadge status={plan.status} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <ImportedPlansActions plan={plan} />
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
