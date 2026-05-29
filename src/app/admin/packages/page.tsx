import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { togglePackageActivation, hidePackageFromClients, movePackageToProviderPlan } from '@/lib/actions/markup'
import { convertToCatalogProduct, bulkConvertToCatalog } from '@/lib/actions/catalog'
import { DeletePackageButton } from '@/components/admin/providers/DeletePackageButton'
import { ConfirmForm } from '@/components/admin/providers/ConfirmForm'

const TABS = [
  { id: 'all', label: 'All Packages' },
  { id: 'provider', label: 'Provider Plans' },
  { id: 'catalog', label: 'Catalog Products' },
  { id: 'manual', label: 'Manual' },
] as const

type TabId = (typeof TABS)[number]['id']

function sourceFilter(tab: TabId): any {
  switch (tab) {
    case 'provider': return { source: 'PROVIDER_PLAN' }
    case 'catalog': return { source: 'CATALOG_PRODUCT' }
    case 'manual': return { source: 'MANUAL' }
    default: return {}
  }
}

function StatusBadge({ source, isActive }: { source: string; isActive: boolean }) {
  if (source === 'PROVIDER_PLAN') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2.5 py-0.5 text-xs font-medium text-orange-600"><span className="h-1.5 w-1.5 rounded-full bg-orange-400" /> Not in catalog</span>
  }
  if (source === 'CATALOG_PRODUCT' && isActive) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-600"><span className="h-1.5 w-1.5 rounded-full bg-green-400" /> Visible to clients</span>
  }
  if (source === 'CATALOG_PRODUCT' && !isActive) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500"><span className="h-1.5 w-1.5 rounded-full bg-gray-400" /> Hidden from clients</span>
  }
  if (source === 'MANUAL' && isActive) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-600"><span className="h-1.5 w-1.5 rounded-full bg-green-400" /> Visible to clients</span>
  }
  return null
}

function ProgressIndicator({ source, isActive, hasDisplayName }: { source: string; isActive: boolean; hasDisplayName: boolean }) {
  const steps = [
    { label: 'Imported', done: true },
    { label: 'Configured', done: source !== 'PROVIDER_PLAN' || hasDisplayName },
    { label: 'Catalog', done: source !== 'PROVIDER_PLAN' },
    { label: 'Live', done: source !== 'PROVIDER_PLAN' && isActive },
  ]
  return (
    <div className="flex items-center gap-0">
      {steps.map((step, i) => (
        <div key={step.label} className="flex items-center">
          <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
            step.done ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-400'
          }`}>
            {step.done ? '✓' : i + 1}
          </div>
          <span className={`ml-1.5 text-[11px] font-medium ${step.done ? 'text-emerald-600' : 'text-gray-400'}`}>{step.label}</span>
          {i < 3 && (
            <div className={`mx-2 h-0.5 w-6 rounded-full ${step.done && steps[i + 1]?.done ? 'bg-emerald-400' : 'bg-gray-200'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
    </div>
  )
}

export default async function AdminPackagesPage({
  searchParams,
}: {
  searchParams?: { error?: string; success?: string; tab?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const tab: TabId = (TABS.some(t => t.id === searchParams?.tab) ? searchParams!.tab : 'all') as TabId

  const allPackages = await prisma.eSIMPackage.findMany({
    where: tab === 'all' ? {} : sourceFilter(tab),
    include: { _count: { select: { purchases: true } } },
    orderBy: { priceUSD: 'asc' },
  })

  const providerPlans = tab === 'provider' ? allPackages : []
  const totalProvider = await prisma.eSIMPackage.count({ where: { source: 'PROVIDER_PLAN' } })
  const totalCatalog = await prisma.eSIMPackage.count({ where: { source: 'CATALOG_PRODUCT' } })
  const totalLive = await prisma.eSIMPackage.count({ where: { source: 'CATALOG_PRODUCT', isActive: true } })
  const totalNeedsPrice = await prisma.eSIMPackage.count({ where: { source: 'PROVIDER_PLAN', priceUSD: 0 } })

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">eSIM Packages</h2>
        <p className="mt-1 text-sm text-gray-500">Manage provider plans, catalog products, and pricing</p>
      </div>

      {/* Summary cards */}
      {tab === 'all' && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard label="Imported Plans" value={totalProvider} color="text-orange-600" />
          <SummaryCard label="Catalog Products" value={totalCatalog} color="text-blue-600" />
          <SummaryCard label="Live Products" value={totalLive} color="text-emerald-600" />
          <SummaryCard label="Needs Pricing" value={totalNeedsPrice} color="text-red-600" />
        </div>
      )}

      {searchParams?.error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{decodeURIComponent(searchParams.error)}</div>
      )}
      {searchParams?.success && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">{decodeURIComponent(searchParams.success)}</div>
      )}

      {/* Pill tabs */}
      <div className="mb-6">
        <nav className="inline-flex rounded-xl bg-gray-100 p-1">
          {TABS.map((t) => {
            const href = t.id === 'all' ? '/admin/packages' : `/admin/packages?tab=${t.id}`
            const isActive = tab === t.id
            return (
              <Link
                key={t.id}
                href={href}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  isActive ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.label}
              </Link>
            )
          })}
        </nav>
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-gray-500">
            {tab === 'provider' && 'Imported provider plans — configure and publish as catalog products'}
            {tab === 'catalog' && 'Catalog products — activate to make them visible to business clients'}
            {tab === 'manual' && 'Manually created packages'}
            {tab === 'all' && 'Overview of all packages across your catalog'}
          </p>
          <div className="flex gap-2">
            {tab === 'provider' && providerPlans.length > 0 && (
              <form action={bulkConvertToCatalog.bind(null, providerPlans.map(p => p.id))}>
                <button type="submit" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
                  Convert All to Catalog
                </button>
              </form>
            )}
            {tab !== 'provider' && (
              <Link href="/admin/packages/new" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 shadow-sm">
                Add Package
              </Link>
            )}
          </div>
        </div>
      </div>

      {allPackages.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No {tab === 'all' ? '' : (tab === 'provider' ? 'provider plans' : tab === 'catalog' ? 'catalog products' : 'packages')} found.</p>
          <div className="mt-4 flex justify-center gap-3">
            {tab === 'provider' && <Link href="/admin/providers" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Sync plans from providers →</Link>}
            {tab === 'catalog' && <Link href="/admin/packages?tab=provider" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Convert a provider plan →</Link>}
            {(tab === 'all' || tab === 'manual') && <Link href="/admin/packages/new" className="text-sm font-medium text-blue-600 hover:text-blue-700">Create a new package →</Link>}
          </div>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {allPackages.map((pkg) => {
            const isImported = !!pkg.providerName
            const costPrice = pkg.costPriceUSD ? parseFloat(pkg.costPriceUSD.toString()) : 0
            const sellingPrice = parseFloat(pkg.priceUSD.toString())
            const profitMargin = costPrice > 0 ? ((sellingPrice - costPrice) / costPrice * 100).toFixed(1) : null
            const needsConfig = pkg.source === 'PROVIDER_PLAN' && !pkg.displayName

            return (
              <div key={pkg.id} className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
                {/* Progress on provider plans */}
                {pkg.source === 'PROVIDER_PLAN' && (
                  <div className="mb-4">
                    <ProgressIndicator source={pkg.source} isActive={pkg.isActive} hasDisplayName={!!pkg.displayName} />
                    <p className="mt-2 text-xs text-gray-400">Imported provider plan. Configure and add to catalog before clients can buy it.</p>
                  </div>
                )}

                {/* Header */}
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-gray-900 truncate">{pkg.name}</h3>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {tab === 'all' && (
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          pkg.source === 'PROVIDER_PLAN' ? 'bg-orange-50 text-orange-600' :
                          pkg.source === 'CATALOG_PRODUCT' ? 'bg-blue-50 text-blue-600' :
                          'bg-yellow-50 text-yellow-600'
                        }`}>
                          {pkg.source === 'PROVIDER_PLAN' ? 'Provider Plan' : pkg.source === 'CATALOG_PRODUCT' ? 'Catalog Product' : 'Manual'}
                        </span>
                      )}
                      {pkg.sku && <span className="rounded-md bg-gray-50 px-1.5 py-0.5 text-[11px] font-mono text-gray-500">{pkg.sku}</span>}
                      {pkg.packageCode && <span className="rounded-md bg-gray-50 px-1.5 py-0.5 text-[11px] font-mono text-gray-500">{pkg.packageCode}</span>}
                    </div>
                  </div>
                </div>

                {/* Status */}
                <div className="mb-3">
                  <StatusBadge source={pkg.source} isActive={pkg.isActive} />
                </div>

                {/* Details grid */}
                <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Data</span>
                    <span className="font-medium text-gray-900">{pkg.dataGB}GB</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Validity</span>
                    <span className="font-medium text-gray-900">{pkg.validityDays}d</span>
                  </div>
                  {costPrice > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Cost</span>
                      <span className="font-medium text-gray-500">${costPrice.toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-gray-500">Price</span>
                    <span className="font-semibold text-gray-900">${sellingPrice.toFixed(2)}</span>
                  </div>
                  {profitMargin && (
                    <div className="flex justify-between col-span-2">
                      <span className="text-gray-500">Margin</span>
                      <span className={`font-medium ${parseFloat(profitMargin) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {profitMargin}%
                        {parseFloat(profitMargin) < 0 && ' (below cost)'}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between col-span-2">
                    <span className="text-gray-500">Purchases</span>
                    <span className="font-medium text-gray-900">{pkg._count.purchases}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  {pkg.source === 'PROVIDER_PLAN' ? (
                    <>
                      <Link
                        href={`/admin/packages/${pkg.id}/edit`}
                        className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-emerald-700 shadow-sm"
                      >
                        {needsConfig ? 'Configure & Publish' : 'Edit & Publish'}
                      </Link>
                      <form action={convertToCatalogProduct.bind(null, pkg.id)}>
                        <input type="hidden" name="priceUSD" value={sellingPrice > 0 ? sellingPrice.toString() : (costPrice > 0 ? (costPrice * 1.2).toFixed(2) : '1.00')} />
                        <input type="hidden" name="localPrice" value={sellingPrice > 0 ? sellingPrice.toString() : (costPrice > 0 ? (costPrice * 1.2).toFixed(2) : '1.00')} />
                        <input type="hidden" name="isActive" value="off" />
                        <button type="submit" className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
                          Quick Add
                        </button>
                      </form>
                      {pkg._count.purchases === 0 && (
                        <DeletePackageButton packageId={pkg.id} variant="card" />
                      )}
                    </>
                  ) : (
                    <>
                      <Link
                        href={`/admin/packages/${pkg.id}/edit`}
                        className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Edit
                      </Link>
                      {pkg.isActive ? (
                        <ConfirmForm action={hidePackageFromClients.bind(null, pkg.id)} message="Hide this package from business clients? Existing orders/eSIMs will not be affected.">
                          <button type="submit" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-100">
                            Hide
                          </button>
                        </ConfirmForm>
                      ) : (
                        <form action={togglePackageActivation.bind(null, pkg.id)}>
                          <input type="hidden" name="isActive" value="on" />
                          <button type="submit" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-600 hover:bg-emerald-100">
                            Activate
                          </button>
                        </form>
                      )}
                      {pkg.source === 'CATALOG_PRODUCT' && isImported && !pkg.isActive && (
                        <ConfirmForm action={movePackageToProviderPlan.bind(null, pkg.id)} message="Move this package back to Provider Plans? It will no longer appear under Catalog Products. Provider mapping will be preserved.">
                          <button type="submit" className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-50">
                            Revert
                          </button>
                        </ConfirmForm>
                      )}
                      <DeletePackageButton packageId={pkg.id} variant="card" />
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
