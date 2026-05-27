import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { convertToCatalogProduct } from '@/lib/actions/catalog'

export default async function ConvertPlanPage({
  params,
  searchParams,
}: {
  params: { id: string }
  searchParams?: { error?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const plan = await prisma.eSIMPackage.findUnique({
    where: { id: params.id },
    include: { provider: { select: { id: true, name: true, code: true } } },
  })

  if (!plan || plan.source !== 'PROVIDER_PLAN') {
    redirect('/admin/provider-plans?error=Plan+not+found')
  }

  const costPrice = plan.costPriceUSD ? parseFloat(plan.costPriceUSD.toString()) : 0
  const suggestedPrice = costPrice > 0 ? (costPrice * 1.2).toFixed(2) : plan.priceUSD.toString()

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link href="/admin/provider-plans" className="text-sm text-cyan-600 hover:underline">← Back to Provider Plans</Link>
      <h2 className="mt-2 text-2xl font-bold text-gray-900">Convert to Catalog Product</h2>
      <p className="mt-1 text-gray-600">Configure pricing and activate {plan.name}</p>

      {searchParams?.error && (
        <div className="mb-4 mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {decodeURIComponent(searchParams.error)}
        </div>
      )}

      <div className="mt-6 rounded-lg border bg-white p-6 shadow-sm">
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Plan Details</h3>
        <dl className="mb-6 grid grid-cols-2 gap-4 text-sm">
          <div><dt className="text-gray-500">Provider</dt><dd className="font-medium text-gray-900">{plan.provider?.name || plan.providerName || '—'}</dd></div>
          <div><dt className="text-gray-500">Data</dt><dd className="font-medium text-gray-900">{plan.dataGB}GB</dd></div>
          <div><dt className="text-gray-500">Validity</dt><dd className="font-medium text-gray-900">{plan.validityDays} days</dd></div>
          <div><dt className="text-gray-500">Cost Price</dt><dd className="font-mono font-medium text-gray-900">${costPrice.toFixed(2)}</dd></div>
          {plan.sku && <div className="col-span-2"><dt className="text-gray-500">SKU</dt><dd className="font-mono text-gray-900">{plan.sku}</dd></div>}
          {plan.packageCode && <div className="col-span-2"><dt className="text-gray-500">Package Code</dt><dd className="font-mono text-gray-900">{plan.packageCode}</dd></div>}
          {plan.providerPlanId && <div className="col-span-2"><dt className="text-gray-500">Provider Plan ID</dt><dd className="font-mono text-gray-900">{plan.providerPlanId}</dd></div>}
        </dl>

        <form action={convertToCatalogProduct.bind(null, plan.id)} className="space-y-4">
          <div>
            <label htmlFor="priceUSD" className="block text-sm font-medium text-gray-700">Selling Price (USD)</label>
            <input
              type="number"
              id="priceUSD"
              name="priceUSD"
              step="0.01"
              min="0.01"
              required
              defaultValue={suggestedPrice}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="localPrice" className="block text-sm font-medium text-gray-700">Local Price (optional)</label>
            <input
              type="number"
              id="localPrice"
              name="localPrice"
              step="0.01"
              min="0"
              defaultValue={suggestedPrice}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isActive"
              name="isActive"
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <label htmlFor="isActive" className="text-sm font-medium text-gray-700">Activate immediately</label>
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Convert to Product
            </button>
            <Link
              href="/admin/provider-plans"
              className="rounded-lg border border-gray-300 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  )
}
