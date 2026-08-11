import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  CREATING: 'bg-amber-100 text-amber-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-600',
  ARCHIVED: 'bg-gray-100 text-gray-400',
}

export default async function ProviderBundlesPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  // Only show providers with CREATE_BUNDLE or UPDATE_BUNDLE capability
  const providers = await prisma.provider.findMany({ orderBy: { name: 'asc' } })
  const bundleProviders = providers.filter(p => {
    const caps = (p.enabledCapabilities || []) as string[]
    return caps.includes('CREATE_BUNDLE') || caps.includes('UPDATE_BUNDLE') || caps.includes('LIST_BUNDLES')
  })

  const bundles = await prisma.$queryRawUnsafe<{ id: string; bundleName: string; bundleCode: string; externalSku: string; providerId: string; status: string; externalVersion: string; createdAt: string; 'provider.name': string }[]>(
    `SELECT b.*, p.name as "provider.name"
     FROM provider_bundle_definitions b JOIN providers p ON b."providerId" = p.id
     ORDER BY b."createdAt" DESC LIMIT 100`
  ).catch(() => [])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Provider Bundle Builder</h2>
          <p className="mt-1 text-sm text-gray-500">Create and manage custom provider SKU/bundle definitions</p>
        </div>
        {bundleProviders.length > 0 && (
          <Link href="/admin/providers/bundles/new" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700">
            New Bundle
          </Link>
        )}
      </div>

      {bundleProviders.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center">
          <p className="text-gray-500">No providers support bundle creation.</p>
          <p className="mt-1 text-xs text-gray-400">Add CREATE_BUNDLE capability to a provider to enable bundle management.</p>
        </div>
      )}

      {bundles.length === 0 && bundleProviders.length > 0 && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center">
          <p className="text-gray-500">No bundles created yet.</p>
          <Link href="/admin/providers/bundles/new" className="mt-4 inline-block text-sm font-medium text-cyan-600 hover:text-cyan-700">Create your first bundle →</Link>
        </div>
      )}

      {bundles.length > 0 && (
        <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-3">Bundle Name</th>
                <th className="px-3 py-3">SKU</th>
                <th className="px-3 py-3">Provider</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Version</th>
                <th className="px-3 py-3">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {bundles.map(b => (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2.5 font-medium text-gray-900">{b.bundleName}</td>
                  <td className="px-3 py-2.5 font-mono text-[10px] text-gray-500">{b.externalSku || b.bundleCode || '-'}</td>
                  <td className="px-3 py-2.5 text-gray-500">{b['provider.name']}</td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLORS[b.status] || ''}`}>{b.status}</span>
                  </td>
                  <td className="px-3 py-2.5 text-gray-400">{b.externalVersion || '-'}</td>
                  <td className="px-3 py-2.5 text-gray-400">{b.createdAt ? new Date(b.createdAt).toLocaleDateString() : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
