import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { CustomPackageForm } from './CustomPackageForm'
import { getEligibleBackingProviders, getEligibleUpstreamCreationProviders, getEligibleProviderPackagesForProvider } from '@/lib/services/custom-package/eligible-providers'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'

export default async function CustomPackageNewPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  // MODE A: providers that can back a custom package from existing ProviderPackages.
  const backingProvidersRaw = await getEligibleBackingProviders()

  const backingProviders = []
  for (const provider of backingProvidersRaw) {
    const packages = await getEligibleProviderPackagesForProvider(provider.id)
    if (packages.length === 0) continue
    backingProviders.push({
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

  // MODE B: providers that can author a NEW upstream package/template. Preload
  // their provider-neutral creation definitions (dynamic provider fields) so the
  // client form renders provider-specific inputs without a round-trip. Best-effort.
  const upstreamProviders = []
  for (const provider of await getEligibleUpstreamCreationProviders()) {
    let definition = null
    try {
      const connector = await buildConnectorFromProvider(provider.id)
      const def = connector?.getCustomPackageDefinition ? await connector.getCustomPackageDefinition() : null
      if (def?.success && def.definition) definition = def.definition
    } catch { /* best-effort */ }
    upstreamProviders.push({
      id: provider.id,
      name: provider.name,
      code: provider.code,
      status: provider.status,
      contractSupported: provider.contractSupported,
      implementationSupported: provider.implementationSupported,
      accountEnabled: provider.accountEnabled,
      gatedReason: provider.gatedReason || null,
      definition,
    })
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <Link href="/admin/provider-catalog" className="text-sm text-cyan-600 hover:underline">← Back to Provider Catalog</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Create Custom Package</h2>
        <p className="mt-1 text-gray-600">Build a OneSIM package from existing provider plans, or create a new package at a provider that supports upstream authoring.</p>
      </div>

      <CustomPackageForm backingProviders={backingProviders} upstreamProviders={upstreamProviders} />
    </div>
  )
}