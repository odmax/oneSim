import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { togglePackageActivation } from '@/lib/actions/markup'

export default async function CatalogProductsPage({
  searchParams,
}: {
  searchParams?: { error?: string; success?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const products = await prisma.eSIMPackage.findMany({
    where: { source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    include: {
      provider: { select: { id: true, name: true, code: true } },
      _count: { select: { purchases: true } },
    },
    orderBy: { priceUSD: 'asc' },
  })

  return (
    <div className="p-6">
      <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
        This section now lives under{' '}
        <Link href="/admin/packages?tab=catalog" className="font-semibold underline">eSIM Packages → Catalog Products</Link>.
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Catalog Products</h2>
          <p className="text-gray-600">Sellable eSIM data plans</p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/catalog-products/analytics"
            className="rounded-lg border border-green-300 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-50"
          >
            Analytics
          </Link>
          <Link
            href="/admin/packages?tab=provider"
            className="rounded-lg border border-cyan-300 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50"
          >
            Provider Plans
          </Link>
          <Link
            href="/admin/packages/new"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Add Product
          </Link>
        </div>
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
              <th className="px-4 py-3 text-left font-medium text-gray-500">Source</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Data</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Validity</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Price</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Cost</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Margin</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">SKU</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Purchases</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {products.map((pkg) => {
              const costPrice = pkg.costPriceUSD ? parseFloat(pkg.costPriceUSD.toString()) : 0
              const sellingPrice = parseFloat(pkg.priceUSD.toString())
              const profitMargin = costPrice > 0 ? ((sellingPrice - costPrice) / costPrice * 100).toFixed(1) : null

              return (
                <tr key={pkg.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                  <Link href={`/admin/packages/${pkg.id}/edit`} className="text-cyan-700 hover:underline">{pkg.name}</Link>
                </td>
                  <td className="px-4 py-3">
                    {pkg.source === 'MANUAL' ? (
                      <span className="inline-flex rounded bg-yellow-50 px-2 py-0.5 text-xs font-medium text-yellow-700">Manual</span>
                    ) : pkg.provider ? (
                      <span className="inline-flex rounded bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-700">{pkg.provider.name}</span>
                    ) : (
                      <span className="inline-flex rounded bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">Catalog</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{pkg.dataGB}GB</td>
                  <td className="px-4 py-3 text-gray-700">{pkg.validityDays}d</td>
                  <td className="px-4 py-3 font-semibold text-blue-600">${sellingPrice.toFixed(2)}</td>
                  <td className="px-4 py-3 font-mono text-gray-500">
                    {costPrice > 0 ? `$${costPrice.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {profitMargin ? (
                      <span className="font-medium text-green-600">{profitMargin}%</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {pkg.sku ? (
                      <span className="font-mono text-xs text-purple-600">{pkg.sku}</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{pkg._count.purchases}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 text-xs font-semibold ${
                      pkg.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                    }`}>
                      {pkg.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <Link
                        href={`/admin/packages/${pkg.id}/edit`}
                        className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
                      >
                        Edit
                      </Link>
                      <form action={togglePackageActivation.bind(null, pkg.id)}>
                        <input type="hidden" name="isActive" value={pkg.isActive ? 'off' : 'on'} />
                        <button
                          type="submit"
                          className={`rounded px-2 py-1 text-xs font-medium ${
                            pkg.isActive
                              ? 'bg-red-50 text-red-600 hover:bg-red-100'
                              : 'bg-green-50 text-green-600 hover:bg-green-100'
                          }`}
                        >
                          {pkg.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              )
            })}
            {products.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-gray-500">
                  No catalog products yet.{' '}
                  <Link href="/admin/provider-plans" className="text-cyan-600 underline">Convert a provider plan</Link> or{' '}
                  <Link href="/admin/packages/new" className="text-blue-600 underline">create manually</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
