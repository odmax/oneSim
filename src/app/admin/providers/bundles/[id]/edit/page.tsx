import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { updateProviderBundle } from '@/lib/actions/bundle-management'

export default async function EditBundlePage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const bundle = await prisma.$queryRawUnsafe<any[]>(`SELECT * FROM provider_bundle_definitions WHERE id=$1`, params.id).catch(() => [])
  if (!bundle.length) return <div className="p-6"><p className="text-red-600">Bundle not found.</p></div>
  const b = bundle[0]

  return (
    <div className="p-6 max-w-3xl">
      <Link href={`/admin/providers/bundles/${params.id}`} className="text-sm text-gray-400 hover:text-gray-600">← Back to Bundle</Link>
      <h2 className="text-2xl font-bold text-gray-900 mt-3">Edit Bundle</h2>
      <p className="mt-1 text-sm text-gray-500">Update SKU: {b.externalSku || b.bundleCode}. Previous version: {b.externalVersion || 'N/A'}</p>

      <form action={updateProviderBundle} className="mt-6 space-y-4">
        <input type="hidden" name="bundleId" value={params.id} />
        <input type="hidden" name="providerId" value={b.providerId} />
        <input type="hidden" name="sku" value={b.externalSku || b.bundleCode} />

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Bundle Name</label>
          <input type="text" name="bundleName" required defaultValue={b.bundleName}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Data (MB)</label>
            <input type="number" name="dataAllowance" defaultValue={b.dataAllowance || ''}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Validity (Days)</label>
            <input type="number" name="validityDays" defaultValue={b.validityDays || ''}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Occurrences</label>
            <input type="number" name="occurrences" defaultValue={b.occurrences || 1}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Pool</label>
            <input type="text" name="pool" defaultValue={b.pool || ''}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Serving Networks</label>
            <input type="text" name="servingNetworks" defaultValue={b.servingNetworks || ''}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
          </div>
        </div>

        <div className="border-t pt-4 flex gap-3">
          <button type="submit" className="rounded-lg bg-cyan-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-cyan-700 shadow-sm">
            Save & Update Provider
          </button>
          <Link href={`/admin/providers/bundles/${params.id}`}
            className="rounded-lg border border-gray-300 px-6 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</Link>
        </div>
      </form>
    </div>
  )
}
