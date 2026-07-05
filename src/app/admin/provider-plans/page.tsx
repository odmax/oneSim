import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { checkPermission, Permissions } from '@/lib/auth/permissions'

export default async function ProviderPlansPage({
  searchParams,
}: {
  searchParams?: { error?: string; success?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const plans = await prisma.eSIMPackage.findMany({
    where: { source: 'PROVIDER_PLAN' },
    include: {
      provider: { select: { id: true, name: true, code: true, type: true } },
      _count: { select: { purchases: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return (
    <div className="p-6">
      <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
        This section now lives under{' '}
        <Link href="/admin/provider-catalog" className="font-semibold underline">Provider Catalog</Link>.
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Provider Plans</h2>
          <p className="text-gray-600">Raw plans imported from providers — not yet sellable</p>
        </div>
        <Link
          href="/admin/providers"
          className="rounded-lg border border-cyan-300 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50"
        >
          Manage Providers
        </Link>
      </div>

      {searchParams?.error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {decodeURIComponent(searchParams.error)}
        </div>
      )}

      {searchParams?.success && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          {decodeURIComponent(searchParams.success)}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Provider</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Data</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Validity</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Cost Price</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Provider Plan ID</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">SKU</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Imported</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {plans.map((plan) => (
              <tr key={plan.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">
                  <Link href={`/admin/provider-plans/${plan.id}`} className="text-cyan-700 hover:underline">{plan.name}</Link>
                </td>
                <td className="px-4 py-3">
                  {plan.provider ? (
                    <Link href={`/admin/providers/${plan.provider.id}`} className="inline-flex rounded bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-700 hover:bg-cyan-100">
                      {plan.provider.name}
                    </Link>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-700">{plan.dataGB}GB</td>
                <td className="px-4 py-3 text-gray-700">{plan.validityDays}d</td>
                <td className="px-4 py-3 font-mono text-gray-700">
                  {plan.costPriceUSD ? `$${parseFloat(plan.costPriceUSD.toString()).toFixed(2)}` : '—'}
                </td>
                <td className="px-4 py-3">
                  {plan.providerPlanId ? (
                    <span className="font-mono text-xs text-gray-500">{plan.providerPlanId}</span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {plan.sku ? (
                    <span className="font-mono text-xs text-purple-600">{plan.sku}</span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {plan.createdAt.toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/provider-plans/${plan.id}/convert`}
                    className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                  >
                    Convert to Product
                  </Link>
                </td>
              </tr>
            ))}
            {plans.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                  No provider plans imported yet. Go to{' '}
                  <Link href="/admin/providers" className="text-cyan-600 underline">Providers</Link> to sync plans.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
