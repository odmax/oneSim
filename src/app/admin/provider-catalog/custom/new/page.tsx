import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { CustomPackageForm } from './CustomPackageForm'
import { getEligibleCustomPackageProviders, getEligibleProviderPackagesForProvider } from '@/lib/services/custom-package/eligible-providers'

export default async function CustomPackageNewPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  // Provider-neutral: load eligible providers first, then their packages.
  const eligibleProviders = await getEligibleCustomPackageProviders()

  const providers = []
  for (const provider of eligibleProviders) {
    const packages = await getEligibleProviderPackagesForProvider(provider.id)
    if (packages.length === 0) continue
    providers.push({
      id: provider.id,
      name: provider.name,
      code: provider.code,
      status: provider.status,
      hasPurchaseCapability: provider.hasPurchaseCapability,
      hasCustomPackageCreationCapability: provider.hasCustomPackageCreationCapability,
      packages: packages.map(b => ({
        id: b.id,
        name: b.name,
        dataGB: b.dataGB,
        validityDays: b.validityDays,
        country: b.country,
        region: b.region,
        cost: b.costPrice != null ? Number(b.costPrice) : 0,
        sellingPrice: b.sellingPrice != null ? Number(b.sellingPrice) : 0,
        currency: b.currency || 'USD',
        pricingStatus: b.pricingStatus,
        configurationStatus: b.configurationStatus,
        publishStatus: b.publishStatus,
      })),
    })
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <Link href="/admin/provider-catalog" className="text-sm text-cyan-600 hover:underline">← Back to Provider Catalog</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Create Custom Package</h2>
        <p className="mt-1 text-gray-600">Create a OneSIM package backed by one or more connected providers.</p>
      </div>

      <CustomPackageForm providers={providers} />
    </div>
  )
}
