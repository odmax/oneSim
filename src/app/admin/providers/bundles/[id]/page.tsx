import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'
import { publishProviderPackageToRetailCatalog } from '@/lib/services/catalog/publish-to-retail'

const STATUS_COLORS: Record<string, string> = { DRAFT: 'bg-gray-100 text-gray-600', CREATING: 'bg-amber-100 text-amber-700', ACTIVE: 'bg-emerald-100 text-emerald-700', FAILED: 'bg-red-100 text-red-600', ARCHIVED: 'bg-gray-100 text-gray-400' }

export default async function BundleDetailPage({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string; success?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const bundle = await prisma.$queryRawUnsafe<any[]>(`SELECT b.*, p.name as "provider.name", p.code as "provider.code", p.adapterStrategy as "provider.adapterStrategy"
    FROM provider_bundle_definitions b JOIN providers p ON b."providerId" = p.id WHERE b.id = $1`, params.id
  ).catch(() => [])

  if (!bundle.length) return <div className="p-6"><p className="text-red-600">Bundle not found.</p></div>
  const b = bundle[0]
  const providerId = b.providerId
  const hasUpdate = (DEFAULT_PROVIDER_CAPABILITIES[b['provider.code']?.toUpperCase()] || []).includes('UPDATE_BUNDLE')

  return (
    <div className="p-6 max-w-3xl">
      <Link href="/admin/providers/bundles" className="text-sm text-gray-400 hover:text-gray-600">← Back to Bundles</Link>

      {searchParams?.error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{searchParams.error}</div>}
      {searchParams?.success && <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">{searchParams.success}</div>}

      <div className="mt-3 flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{b.bundleName}</h2>
          <p className="text-sm text-gray-500">SKU: {b.externalSku || b.bundleCode || '-'} · {b['provider.name']} ({b['provider.code']})</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[b.status] || ''}`}>{b.status}</span>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 text-sm">
        <KV label="Pool" value={b.pool || '-'} />
        <KV label="Version" value={b.externalVersion || '-'} />
        <KV label="Data" value={b.dataAllowance ? `${b.dataAllowance} ${b.dataUnit || 'MB'}` : '-'} />
        <KV label="Validity" value={b.validityDays ? `${b.validityDays} days` : '-'} />
        <KV label="Occurrences" value={b.occurrences || '-'} />
        <KV label="Tethering" value={b.tethering ? 'Yes' : 'No'} />
        <KV label="Throttling" value={b.throttling ? 'Yes' : 'No'} />
        <KV label="Roaming Profile" value={b.roamingProfileId || '-'} />
        <KV label="Serving Networks" value={b.servingNetworks || '-'} />
        <KV label="Created" value={b.createdAt ? new Date(b.createdAt).toLocaleDateString() : '-'} />
      </div>

      {/* Actions */}
      <div className="mt-6 flex flex-wrap gap-3 border-t pt-5">
        {b.status === 'ACTIVE' && (
          <form action={async () => { 'use server'
            const { prisma } = await import('@/lib/prisma')
            // Link this bundle to a ProviderPackage for catalog integration
            const pp = await prisma.providerPackage.findFirst({ where: { providerId, providerPlanCode: b.externalSku || b.bundleCode } })
            if (pp) {
              await prisma.providerPackage.update({ where: { id: pp.id }, data: { configurationStatus: 'CONFIGURED', sellable: true } as any })
            }
            redirect('/admin/providers/bundles?success=configured')
          }}>
            <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">Configure for Sale</button>
          </form>
        )}

        {hasUpdate && b.status === 'ACTIVE' && (
          <Link href={`/admin/providers/bundles/${params.id}/edit`}
            className="rounded-lg border border-cyan-300 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50">Edit Bundle</Link>
        )}

        {b.status === 'DRAFT' && (
          <Link href={`/admin/providers/bundles/${params.id}/edit`}
            className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700">Finish Draft</Link>
        )}
      </div>
    </div>
  )
}

function KV({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between"><span className="text-gray-500">{label}</span><span className="font-medium text-gray-900">{value}</span></div>
}
