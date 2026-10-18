import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import PackageActions from '@/components/admin/packages/PackageActions'
import { roundMoney, computeMarkupFromCostAndSell, computeMarginAmount, computeMarginFromCostAndSell } from '@/lib/pricing/pricing-engine'
import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'
import { buildPortalExposureForRetail } from '@/lib/packages/customer-visibility'
import { computeCatalogStats } from '@/lib/packages/catalog-stats'
import { ProductCatalogFilters } from './ProductCatalogFilters'
import { filterProductCatalogView, resolveProductCatalogView, type ProductCatalogView } from '@/lib/packages/product-catalog-view'

const PROVIDER_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Choice', value: 'CHOICE' },
  { label: 'AirHub', value: 'AIRHUB' },
  { label: 'iBASIS', value: 'IBASIS' },
  { label: 'Telna', value: 'TELNA' },
  { label: 'Custom', value: 'CUSTOM' },
] as const

function StatusBadge({ isActive, hiddenFromCatalog, purchaseReady }: { isActive: boolean; hiddenFromCatalog?: boolean; purchaseReady?: boolean }) {
  if (hiddenFromCatalog) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-600">Hidden</span>
  }
  if (purchaseReady) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-600">Live</span>
  }
  if (!isActive) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">Inactive</span>
  }
  return <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-600">Blocked</span>
}

function SummaryCard({ label, value, color, href, active, caption }: { label: string; value: number; color: string; href: string; active: boolean; caption?: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`rounded-xl border bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-cyan-500/30 ${
        active ? 'border-cyan-400 ring-2 ring-cyan-100' : 'border-gray-100'
      }`}
    >
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
      {caption && <p className="mt-1 text-[10px] text-gray-400">{caption}</p>}
    </Link>
  )
}

export default async function AdminPackagesPage({
  searchParams,
}: {
  searchParams?: { error?: string; success?: string; view?: string; tab?: string; search?: string; provider?: string; validity?: string; sort?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const view = resolveProductCatalogView(searchParams?.view, searchParams?.tab)
  const searchQuery = (searchParams?.search || '').trim()
  const providerFilter = (searchParams?.provider || '').toUpperCase()
  const validityFilter = parseInt(searchParams?.validity || '0') || 0
  const sortParam = searchParams?.sort || 'cheapest'

  // Base retail packages query
  const retailBase: any = {
    source: { in: ['CATALOG_PRODUCT', 'MANUAL'] as string[] },
  }

  // All retail — for counts
  const allRetail = await prisma.eSIMPackage.findMany({
    where: retailBase,
    include: {
      providerPackage: { select: { publishStatus: true, costStatus: true, pricingStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true, providerId: true, isAvailable: true } },
      provider: { select: { status: true, enabledCapabilities: true, code: true, adapterStrategy: true } },
      providerBindings: {
        orderBy: { priority: 'asc' },
        select: {
          id: true,
          isActive: true,
          providerPackage: {
            select: {
              id: true, providerId: true, publishStatus: true, configurationStatus: true,
              pricingStatus: true, costStatus: true, activePriceSnapshotId: true,
              sellingPrice: true, costPrice: true, isAvailable: true,
              provider: { select: { id: true, name: true, status: true, enabledCapabilities: true, code: true } },
            },
          },
        },
      },
      _count: { select: { purchases: true, topUpRecords: true } },
    },
    orderBy: [{ priceUSD: 'asc' }, { id: 'asc' }],
  })

  // Build searchable text for each package
  const buildSearchable = (pkg: any): string => {
    const parts = [pkg.displayName, pkg.name, pkg.sku, pkg.packageCode]
    if (pkg.providerPackage) {
      // Country/region only — no provider plan code exposed in Product Catalog
      // Provider plan codes are for Admin Provider Catalog
    }
    if (pkg.dataGB) parts.push(`${pkg.dataGB}GB`, `${pkg.dataGB}gb`)
    if (pkg.validityDays) parts.push(`${pkg.validityDays}d`, `${pkg.validityDays}days`, `${pkg.validityDays} day`, `${pkg.validityDays} days`)
    return parts.filter(Boolean).join(' ').toLowerCase()
  }

  // Compute readiness for all
  const packagesWithReadiness = allRetail.map(pkg => ({
    ...pkg,
    _readiness: getPackagePurchaseReadiness({
      pkg: { isActive: pkg.isActive, hiddenFromCatalog: pkg.hiddenFromCatalog, archivedAt: pkg.archivedAt, source: pkg.source, providerPackageId: pkg.providerPackageId },
      providerPkg: pkg.providerPackage,
      provider: pkg.provider,
    }),
    _searchable: buildSearchable(pkg),
  }))

  // CANONICAL CUSTOMER-VISIBILITY: the exact predicate the Business Buy eSIM
  // catalog and client API use (operational readiness + price parity + portal
  // exposure). "Operational Live" and "Customer-visible" are deliberately
  // separate counts — a live product can be stale-priced or provider-paused and
  // must not be shown to clients until repaired.
  const exposureMap = await buildPortalExposureForRetail(
    allRetail.map(p => ({ providerId: p.providerId, providerPackage: p.providerPackage?.providerId ? { providerId: p.providerPackage.providerId } : null })),
  )
  const catalogStats = computeCatalogStats(allRetail, exposureMap)
  const customerVisibleCount = catalogStats.customerVisible
  const customerVisibilityReasons = catalogStats.hiddenLiveReasons

  const operationalLiveIds = new Set(catalogStats.operationalLiveIds)
  const customerVisibleIds = new Set(catalogStats.customerVisibleIds)
  const draftInactiveIds = new Set(packagesWithReadiness
    .filter(p => !p.isActive || p.hiddenFromCatalog || p.archivedAt ||
      (p.providerPackage?.publishStatus && p.providerPackage.publishStatus !== 'PUBLISHED'))
    .map(p => p.id))
  const needsPricingIds = new Set(packagesWithReadiness
    .filter(p => !p._readiness.ready && !draftInactiveIds.has(p.id))
    .map(p => p.id))

  // Primary card view is evaluated against the complete population before
  // secondary search/provider/validity filters and sorting.
  const viewFiltered = filterProductCatalogView(packagesWithReadiness, view, {
    operationalLiveIds,
    customerVisibleIds,
    draftInactiveIds,
    needsPricingIds,
  })
  let filtered = viewFiltered

  // Search filter
  if (searchQuery) {
    filtered = filtered.filter(p => p._searchable.includes(searchQuery.toLowerCase()))
  }

  // Provider filter
  if (providerFilter && PROVIDER_OPTIONS.some(o => o.value === providerFilter)) {
    filtered = filtered.filter(p => {
      const strat = p.provider?.adapterStrategy?.toUpperCase()
      const code = p.provider?.code?.toUpperCase()
      return strat === providerFilter || code === providerFilter
    })
  }

  // Validity filter
  if (validityFilter > 0) {
    filtered = filtered.filter(p => (p.validityDays || 0) >= validityFilter)
  }

  // Sort
  filtered = [...filtered]
  switch (sortParam) {
    case 'price-asc':
    case 'cheapest':
      filtered.sort((a, b) => parseFloat(a.priceUSD?.toString?.() || '0') - parseFloat(b.priceUSD?.toString?.() || '0'))
      break
    case 'price-desc':
      filtered.sort((a, b) => parseFloat(b.priceUSD?.toString?.() || '0') - parseFloat(a.priceUSD?.toString?.() || '0'))
      break
    case 'margin-desc': {
      const margin = (p: any) => {
        const cost = parseFloat(p.costPriceUSD?.toString?.() || '0')
        const sell = parseFloat(p.priceUSD?.toString?.() || '0')
        if (cost <= 0 || sell <= 0) return -Infinity
        return ((sell - cost) / sell) * 100
      }
      filtered.sort((a, b) => margin(b) - margin(a))
      break
    }
    case 'margin-asc': {
      const margin = (p: any) => {
        const cost = parseFloat(p.costPriceUSD?.toString?.() || '0')
        const sell = parseFloat(p.priceUSD?.toString?.() || '0')
        if (cost <= 0 || sell <= 0) return Infinity
        return ((sell - cost) / sell) * 100
      }
      filtered.sort((a, b) => margin(a) - margin(b))
      break
    }
    case 'data-desc':
      filtered.sort((a, b) => (b.dataGB || 0) - (a.dataGB || 0))
      break
    case 'validity-desc':
      filtered.sort((a, b) => (b.validityDays || 0) - (a.validityDays || 0))
      break
    default:
      filtered.sort((a, b) => parseFloat(a.priceUSD?.toString?.() || '0') - parseFloat(b.priceUSD?.toString?.() || '0'))
  }
  const displayPackages = filtered

  const cardHref = (targetView: ProductCatalogView, options?: { clearSearch?: boolean }) => {
    const params = new URLSearchParams()
    if (targetView !== 'all') params.set('view', targetView)
    if (searchQuery && !options?.clearSearch) params.set('search', searchQuery)
    if (providerFilter) params.set('provider', providerFilter)
    if (validityFilter > 0) params.set('validity', String(validityFilter))
    if (sortParam !== 'cheapest') params.set('sort', sortParam)
    const query = params.toString()
    return query ? `/admin/packages?${query}` : '/admin/packages'
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Product Catalog</h2>
          <p className="mt-1 text-sm text-gray-500">Operational and customer-visible retail products — Operational Live is not necessarily client-visible</p>
        </div>
        <Link href="/admin/provider-catalog"
          className="rounded-lg border border-cyan-300 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50">
          Provider Catalog →
        </Link>
      </div>

      {/* Summary cards */}
      <div className="mb-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryCard label="Product Catalog" value={catalogStats.total} color="text-blue-600" href={cardHref('all')} active={view === 'all'} />
        <SummaryCard label="Operational Live" value={catalogStats.operationalLive} color="text-emerald-600" href={cardHref('operational-live')} active={view === 'operational-live'} caption="configured · publish-ready · not necessarily client-visible" />
        <SummaryCard label="Customer Visible" value={customerVisibleCount} color="text-cyan-600" href={cardHref('customer-visible')} active={view === 'customer-visible'} caption="matches Business Buy eSIM & portal query" />
        <SummaryCard label="Draft / Inactive" value={catalogStats.draftInactive} color="text-amber-600" href={cardHref('draft-inactive')} active={view === 'draft-inactive'} />
        <SummaryCard label="Needs Pricing" value={catalogStats.needsPricing} color="text-red-600" href={cardHref('needs-pricing')} active={view === 'needs-pricing'} />
      </div>

      {customerVisibilityReasons.length > 0 && (
        <div className="mb-2 rounded-lg border border-cyan-200 bg-cyan-50 p-3 text-xs text-cyan-800">
          <p className="font-semibold">Why operationally-live products are not customer-visible</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {customerVisibilityReasons.map(r => (
              <li key={r.reason}>{r.count}× {r.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {searchParams?.error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{decodeURIComponent(searchParams.error)}</div>
      )}
      {searchParams?.success && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">{decodeURIComponent(searchParams.success)}</div>
      )}

      {/* Search + Filters (Client Component) */}
      <ProductCatalogFilters
        view={view}
        search={searchQuery}
        provider={providerFilter}
        validity={String(validityFilter || '')}
        sort={sortParam}
      />

      {/* Result count */}
      {displayPackages.length > 0 && (
        <p className="mb-4 text-xs text-gray-400">
          {searchQuery
            ? `Showing ${displayPackages.length} of ${viewFiltered.length} products matching "${searchQuery}"`
            : `Showing ${displayPackages.length} of ${viewFiltered.length} products`}
          {providerFilter && ` · ${providerFilter}`}
          {validityFilter > 0 && ` · ${validityFilter} Days`}
        </p>
      )}

      {displayPackages.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          {searchQuery ? (
            <>
              <p className="text-gray-500">No products match your search.</p>
              <a href={cardHref(view, { clearSearch: true })}
                className="inline-block mt-4 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
                Clear Search
              </a>
            </>
          ) : (
            <p className="text-gray-500">No packages in this category.</p>
          )}
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {displayPackages.map((pkg) => {
            const costPrice = pkg.costPriceUSD ? parseFloat(pkg.costPriceUSD.toString()) : 0
            const sellingPrice = parseFloat(pkg.priceUSD.toString())
            const markupPct = computeMarkupFromCostAndSell(costPrice, sellingPrice)
            const profitAmount = computeMarginAmount(costPrice, sellingPrice)
            const marginPct = computeMarginFromCostAndSell(costPrice, sellingPrice)

            return (
              <div key={pkg.id} className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
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

                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <StatusBadge isActive={pkg.isActive} hiddenFromCatalog={pkg.hiddenFromCatalog || undefined} purchaseReady={pkg._readiness.ready} />
                  {(pkg.providerBindings?.length ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-600">
                      CUSTOM
                      <span className="text-indigo-400">· {(pkg.providerBindings.filter((b: any) => b.isActive !== false).length || pkg.providerBindings.length)} providers</span>
                    </span>
                  )}
                </div>

                {(pkg.providerBindings?.length ?? 0) > 0 && (
                  <div className="mb-3 rounded-lg bg-indigo-50/50 px-3 py-2 text-xs text-indigo-700">
                    <span className="font-medium">Primary:</span> {pkg.providerBindings[0]?.providerPackage?.provider?.name || '?'}
                    {(pkg.providerBindings.length || 0) > 1 && (
                      <span className="text-indigo-500"> · {(pkg.providerBindings.length || 0) - 1} fallback{(pkg.providerBindings.length || 0) - 1 > 1 ? 's' : ''}</span>
                    )}
                  </div>
                )}

                {(pkg.customerDescription || pkg.description) && (
                  <p className="mb-3 text-xs text-gray-500 line-clamp-2">{pkg.customerDescription || pkg.description}</p>
                )}

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
                        ${profitAmount.toFixed(2)} ({marginPct?.toFixed(1)}%)
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

                <PackageActions pkg={pkg as any} isImported={false} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
