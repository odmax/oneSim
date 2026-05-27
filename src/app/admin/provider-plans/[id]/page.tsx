import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

export default async function ProviderPlanDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const plan = await prisma.eSIMPackage.findUnique({
    where: { id: params.id },
    include: { provider: { select: { id: true, name: true, code: true, type: true } } },
  })

  if (!plan || plan.source !== 'PROVIDER_PLAN') {
    redirect('/admin/provider-plans?error=Plan+not+found')
  }

  const costPrice = plan.costPriceUSD ? parseFloat(plan.costPriceUSD.toString()) : 0

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href="/admin/provider-plans" className="text-sm text-cyan-600 hover:underline">← Back to Provider Plans</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">{plan.name}</h2>
        <p className="text-gray-600">Imported provider plan — not sellable until converted</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Plan Details</h3>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">Name</dt><dd className="font-medium text-gray-900">{plan.name}</dd></div>
            {plan.description && <div className="flex justify-between"><dt className="text-gray-500">Description</dt><dd className="text-gray-700 max-w-[250px] truncate" title={plan.description}>{plan.description}</dd></div>}
            <div className="flex justify-between"><dt className="text-gray-500">Data</dt><dd className="font-medium text-gray-900">{plan.dataGB} GB</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Validity</dt><dd className="font-medium text-gray-900">{plan.validityDays} days</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Cost Price</dt><dd className="font-mono font-medium text-gray-900">{costPrice > 0 ? `$${costPrice.toFixed(2)}` : '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Source</dt><dd><span className="inline-flex rounded-full bg-yellow-100 px-2 text-xs font-semibold text-yellow-800">Provider Plan</span></dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Imported At</dt><dd className="text-gray-600">{plan.createdAt.toLocaleString()}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Last Updated</dt><dd className="text-gray-600">{plan.updatedAt.toLocaleString()}</dd></div>
          </dl>
        </div>

        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Provider Information</h3>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">Provider</dt><dd className="font-medium text-gray-900">{plan.provider?.name || plan.providerName || '—'}</dd></div>
            {plan.provider && <div className="flex justify-between"><dt className="text-gray-500">Provider Type</dt><dd><span className="inline-flex rounded-full px-2 text-xs font-semibold leading-5">{plan.provider.type}</span></dd></div>}
            {plan.providerPlanId && <div className="flex justify-between"><dt className="text-gray-500">Provider Plan ID</dt><dd className="font-mono text-xs text-gray-600">{plan.providerPlanId}</dd></div>}
            {plan.sku && <div className="flex justify-between"><dt className="text-gray-500">SKU</dt><dd className="font-mono text-xs text-purple-600">{plan.sku}</dd></div>}
            {plan.packageCode && <div className="flex justify-between"><dt className="text-gray-500">Package Code</dt><dd className="font-mono text-xs text-indigo-600">{plan.packageCode}</dd></div>}
            <div className="flex justify-between"><dt className="text-gray-500">Conversion Status</dt><dd>
              <span className="inline-flex rounded-full bg-yellow-100 px-2 text-xs font-semibold text-yellow-800">Not Converted</span>
            </dd></div>
          </dl>

          <div className="mt-6 flex gap-3">
            <Link
              href={`/admin/provider-plans/${plan.id}/convert`}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              Convert to Product
            </Link>
            <Link
              href={`/admin/providers/${plan.providerId}`}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              View Provider
            </Link>
          </div>
        </div>
      </div>

      {plan.providerRawData && (
        <div className="mt-6 rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Raw Provider Data</h3>
          <pre className="overflow-x-auto rounded bg-gray-50 p-4 text-xs font-mono text-gray-600 max-h-96 overflow-y-auto">
            {JSON.stringify(plan.providerRawData, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
