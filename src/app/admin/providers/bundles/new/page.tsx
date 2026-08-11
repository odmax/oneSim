import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'

export default async function NewProviderBundlePage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const providers = await prisma.provider.findMany({ orderBy: { name: 'asc' } })
  const bundleProviders = providers.filter(p => {
    const caps = (p.enabledCapabilities || []) as string[]
    return caps.includes('CREATE_BUNDLE')
  })

  return (
    <div className="p-6 max-w-3xl">
      <Link href="/admin/providers/bundles" className="text-sm text-gray-400 hover:text-gray-600">← Back to Bundles</Link>
      <h2 className="text-2xl font-bold text-gray-900 mt-3">Create Provider Bundle</h2>
      <p className="mt-1 text-sm text-gray-500">Define a custom SKU/bundle for a provider that supports CREATE_BUNDLE. This will be available for pricing and catalog integration after creation.</p>

      <form action="/api/admin/bundles/create" method="POST" className="mt-6 space-y-4">
        {/* Provider selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
          <select name="providerId" required className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
            <option value="">Select provider...</option>
            {bundleProviders.map(p => (
              <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
            ))}
          </select>
        </div>

        {/* SKU */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            SKU / Bundle Code <span className="text-gray-400 text-xs">(max 25 chars)</span>
          </label>
          <input type="text" name="sku" maxLength={25} required placeholder="e.g. OS-MY-5GB-30D"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono focus:border-cyan-500 focus:outline-none" />
        </div>

        {/* Bundle Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Bundle Name</label>
          <input type="text" name="bundleName" required placeholder="e.g. OneSim 5GB 30 Days Global"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
        </div>

        {/* Pool */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Pool</label>
          <input type="text" name="pool" required placeholder="Pool number/identifier"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
        </div>

        {/* Data + Validity */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Data Amount</label>
            <input type="number" name="dataAllowance" min={1} defaultValue={1024}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Data Unit</label>
            <select name="dataUnit" defaultValue="MB" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
              <option value="MB">MB</option><option value="GB">GB</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Validity (Days)</label>
            <input type="number" name="validityDays" min={1} defaultValue={30}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
          </div>
        </div>

        {/* Occurrences */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Occurrences</label>
          <input type="number" name="occurrences" min={1} defaultValue={1}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
        </div>

        {/* Toggle options */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2.5 cursor-pointer hover:bg-gray-50">
            <input type="checkbox" name="tethering" value="true" className="rounded border-gray-300 text-cyan-600" />
            <span className="text-sm text-gray-700">Allow Tethering</span>
          </label>
          <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2.5 cursor-pointer hover:bg-gray-50">
            <input type="checkbox" name="throttling" value="true" className="rounded border-gray-300 text-cyan-600" />
            <span className="text-sm text-gray-700">Allow Throttling</span>
          </label>
        </div>

        {/* Roaming + Networks */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Roaming Profile ID</label>
            <input type="text" name="roamingProfileId" placeholder="Optional"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Serving Networks</label>
            <input type="text" name="servingNetworks" placeholder="Optional"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
          </div>
        </div>

        <div className="pt-4 border-t">
          <button type="submit" className="rounded-lg bg-cyan-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-cyan-700 shadow-sm">
            Create Bundle
          </button>
        </div>
      </form>
    </div>
  )
}
