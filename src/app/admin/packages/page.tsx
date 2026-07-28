import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import PackageActions from '@/components/admin/packages/PackageActions'
import { roundMoney, computeMarkupFromCostAndSell, computeMarginAmount } from '@/lib/pricing/pricing-engine'

const TABS = [
  { id: 'catalog', label: 'Catalog Products' },
  { id: 'manual', label: 'Manual' },
] as const

type TabId = (typeof TABS)[number]['id']

function sourceFilter(tab: TabId): any {
  switch (tab) {
    case 'catalog': return { source: 'CATALOG_PRODUCT' }
    case 'manual': return { source: 'MANUAL' }
    default: return { source: 'CATALOG_PRODUCT' }
  }
}

function StatusBadge({ source, isActive, hiddenFromCatalog }: { source: string; isActive: boolean; hiddenFromCatalog?: boolean }) {
  if (hiddenFromCatalog) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-600"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Archived</span>
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
  if (source === 'MANUAL' && !isActive) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500"><span className="h-1.5 w-1.5 rounded-full bg-gray-400" /> Hidden from clients</span>
  }
  return null
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

  const tab: TabId = (TABS.some(t => t.id === searchParams?.tab) ? searchParams!.tab : 'catalog') as TabId

  const allPackages = await prisma.eSIMPackage.findMany({
    where: { ...sourceFilter(tab), costPriceUSD: { gt: 0 }, priceUSD: { gt: 0 } },
    include: { _count: { select: { purchases: true, topUpRecords: true } } },
    orderBy: { priceUSD: 'asc' },
  })

  const totalPublished = await prisma.eSIMPackage.count({ where: { source: { in: ['CATALOG_PRODUCT', 'MANUAL'] }, costPriceUSD: { gt: 0 }, priceUSD: { gt: 0 } } })
  const totalLive = await prisma.eSIMPackage.count({ where: { source: { in: ['CATALOG_PRODUCT', 'MANUAL'] }, costPriceUSD: { gt: 0 }, priceUSD: { gt: 0 }, isActive: true } })
  const totalDraft = await prisma.eSIMPackage.count({ where: { source: { in: ['CATALOG_PRODUCT', 'MANUAL'] }, costPriceUSD: { gt: 0 }, priceUSD: { gt: 0 }, isActive: false } })
  const totalNeedsPricing = await prisma.eSIMPackage.count({ where: { source: { in: ['CATALOG_PRODUCT', 'MANUAL'] }, priceUSD: { lte: 0 } } })

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Product Catalog</h2>
          <p className="mt-1 text-sm text-gray-500">Customer-facing packages available for sale — manage catalog visibility and pricing</p>
          <p className="mt-2 text-xs text-gray-400">Provider costs, provider IDs, and raw provider data are never shown to clients.</p>
        </div>
        <Link href="/admin/provider-catalog"
          className="rounded-lg border border-cyan-300 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50">
          Provider Catalog →
        </Link>
      </div>

      {/* Summary cards */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Product Catalog" value={totalPublished} color="text-blue-600" />
        <SummaryCard label="Live Products" value={totalLive} color="text-emerald-600" />
        <SummaryCard label="Draft / Inactive" value={totalDraft} color="text-amber-600" />
        <SummaryCard label="Needs Pricing" value={totalNeedsPricing} color="text-red-600" />
      </div>

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
            const href = t.id === 'catalog' ? '/admin/packages' : `/admin/packages?tab=${t.id}`
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
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-gray-500">
              {tab === 'catalog' && 'Products published from Provider Catalog — activate to make visible to business clients'}
              {tab === 'manual' && 'Manually created packages'}
            </p>
            <div className="flex flex-wrap gap-2">
              {tab !== 'manual' && (
                <Link href="/admin/packages/new" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 shadow-sm">
                  Add Package
                </Link>
              )}
            </div>
        </div>
      </div>

      {allPackages.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No {tab === 'catalog' ? 'catalog products' : 'packages'} found.</p>
          <div className="mt-4 flex justify-center gap-3">
            {tab === 'catalog' && <Link href="/admin/provider-catalog" className="text-sm font-medium text-emerald-600 hover:text-emerald-700">Go to Provider Catalog →</Link>}
            {tab === 'manual' && <Link href="/admin/packages/new" className="text-sm font-medium text-blue-600 hover:text-blue-700">Create a new package →</Link>}
          </div>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {allPackages.map((pkg) => {
            const costPrice = pkg.costPriceUSD ? parseFloat(pkg.costPriceUSD.toString()) : 0
            const sellingPrice = parseFloat(pkg.priceUSD.toString())
            const markupPct = computeMarkupFromCostAndSell(costPrice, sellingPrice)
            const profitAmount = computeMarginAmount(costPrice, sellingPrice)

            return (
              <div key={pkg.id} className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
                {/* Header */}
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-gray-900 truncate">{pkg.displayName || pkg.name}</h3>
                    {pkg.displayName && <p className="text-xs text-gray-400 truncate">{pkg.name}</p>}
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {pkg.sku && <span className="rounded-md bg-gray-50 px-1.5 py-0.5 text-[11px] font-mono text-gray-500">{pkg.sku}</span>}
                      {pkg.packageCode && <span className="rounded-md bg-gray-50 px-1.5 py-0.5 text-[11px] font-mono text-gray-500">{pkg.packageCode}</span>}
                    </div>
                  </div>
                </div>

                {/* Status */}
                <div className="mb-3">
                  <StatusBadge source={pkg.source} isActive={pkg.isActive} hiddenFromCatalog={pkg.hiddenFromCatalog || undefined} />
                </div>

                {(pkg.customerDescription || pkg.description) && (
                  <p className="mb-3 text-xs text-gray-500 line-clamp-2">{pkg.customerDescription || pkg.description}</p>
                )}

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
                  <div className="flex justify-between">
                    <span className="text-gray-500">Cost</span>
                    {costPrice > 0 ? (
                      <span className="font-medium text-gray-700">${costPrice.toFixed(2)}</span>
                    ) : (
                      <span className="text-xs text-amber-600 font-medium">Cost missing</span>
                    )}
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Sell Price</span>
                    <span className="font-semibold text-gray-900">${sellingPrice.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between col-span-2">
                    <span className="text-gray-500">Margin</span>
                    {profitAmount != null ? (
                      <span className={`font-medium ${profitAmount >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        ${profitAmount.toFixed(2)} ({markupPct?.toFixed(1)}%)
                        {profitAmount < 0 && ' ↓'}
                      </span>
                    ) : (
                      <span className="text-gray-400">N/A</span>
                    )}
                  </div>
                  <div className="flex justify-between col-span-2">
                    <span className="text-gray-500">Markup</span>
                    {markupPct != null ? (
                      <span className="font-medium text-gray-700">{markupPct.toFixed(1)}%</span>
                    ) : (
                      <span className="text-gray-400">N/A</span>
                    )}
                  </div>
                  <div className="flex justify-between col-span-2">
                    <span className="text-gray-500">Purchases</span>
                    <span className="font-medium text-gray-900">{pkg._count.purchases}</span>
                  </div>
                </div>

                {/* Actions — shared component, state-driven */}
                <PackageActions pkg={pkg as any} isImported={false} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
