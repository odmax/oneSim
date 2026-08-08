import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import PackageActions from '@/components/admin/packages/PackageActions'
import { roundMoney, computeMarkupFromCostAndSell, computeMarginAmount, computeMarginFromCostAndSell } from '@/lib/pricing/pricing-engine'
import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'

const TABS = [
  { id: 'live', label: 'Live Products' },
  { id: 'draft', label: 'Draft / Inactive' },
  { id: 'needs-pricing', label: 'Needs Pricing' },
] as const

const PROVIDER_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Choice', value: 'CHOICE' },
  { label: 'AirHub', value: 'AIRHUB' },
  { label: 'iBASIS', value: 'IBASIS' },
  { label: 'Telna', value: 'TELNA' },
  { label: 'Custom', value: 'CUSTOM' },
] as const

const VALIDITY_OPTIONS = [
  { label: 'All', days: 0 },
  { label: '1 Day', days: 1 },
  { label: '7 Days', days: 7 },
  { label: '15 Days', days: 15 },
  { label: '30 Days', days: 30 },
  { label: '60 Days', days: 60 },
  { label: '90 Days', days: 90 },
] as const

const SORT_OPTIONS = [
  { label: 'Cheapest', value: 'cheapest' },
  { label: 'Most Expensive', value: 'price-desc' },
  { label: 'Highest Margin', value: 'margin-desc' },
  { label: 'Lowest Margin', value: 'margin-asc' },
  { label: 'Data: Highest', value: 'data-desc' },
  { label: 'Validity: Longest', value: 'validity-desc' },
] as const

type TabId = (typeof TABS)[number]['id']

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
  searchParams?: { error?: string; success?: string; tab?: string; search?: string; provider?: string; validity?: string; sort?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const tab: TabId = (TABS.some(t => t.id === searchParams?.tab) ? searchParams!.tab : 'live') as TabId
  const searchQuery = (searchParams?.search || '').trim()
  const providerFilter = (searchParams?.provider || '').toUpperCase()
  const validityFilter = parseInt(searchParams?.validity || '0') || 0
  const sortParam = searchParams?.sort || 'cheapest'

  // Base retail packages query
  const retailBase: any = {
    source: { in: ['CATALOG_PRODUCT', 'MANUAL'] as string[] },
    isActive: true,
    hiddenFromCatalog: false,
    archivedAt: null,
  }

  // All retail — for counts
  const allRetail = await prisma.eSIMPackage.findMany({
    where: retailBase,
    include: {
      providerPackage: { select: { publishStatus: true, costStatus: true, pricingStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true } },
      provider: { select: { status: true, enabledCapabilities: true, code: true, adapterStrategy: true } },
      _count: { select: { purchases: true, topUpRecords: true } },
    },
    orderBy: { priceUSD: 'asc' },
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

  // Filter by tab
  let tabFiltered = packagesWithReadiness
  if (tab === 'live') {
    tabFiltered = packagesWithReadiness.filter(p => p._readiness.ready)
  } else if (tab === 'draft') {
    tabFiltered = packagesWithReadiness.filter(p => !p.isActive || p.hiddenFromCatalog || p.archivedAt ||
      (p.providerPackage?.publishStatus && p.providerPackage.publishStatus !== 'PUBLISHED'))
  } else if (tab === 'needs-pricing') {
    tabFiltered = packagesWithReadiness.filter(p => !p._readiness.ready &&
      p.isActive && !p.hiddenFromCatalog && !p.archivedAt)
  }

  // Filtering pipeline: tab → search → provider → validity → sort
  let filtered = tabFiltered

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

  const livePackages = packagesWithReadiness.filter(p => p._readiness.ready)
  const draftPackages = packagesWithReadiness.filter(p => !p.isActive || p.hiddenFromCatalog || p.archivedAt ||
    (p.providerPackage?.publishStatus && p.providerPackage.publishStatus !== 'PUBLISHED'))
  const needsPricingPackages = packagesWithReadiness.filter(p => !p._readiness.ready &&
    p.isActive && !p.hiddenFromCatalog && !p.archivedAt)

  const tabCounts: Record<string, number> = { live: livePackages.length, draft: draftPackages.length, 'needs-pricing': needsPricingPackages.length }

  function buildUrl(targetTab: string, overrides: Record<string, string | number>) {
    const p = new URLSearchParams()
    if (targetTab !== 'live') p.set('tab', targetTab)
    const s = overrides.search !== undefined ? String(overrides.search || '') : searchQuery
    if (s) p.set('search', s)
    const prov = overrides.provider !== undefined ? String(overrides.provider || '') : providerFilter
    if (prov) p.set('provider', prov)
    const val = overrides.validity !== undefined ? Number(overrides.validity) : validityFilter
    if (val > 0) p.set('validity', String(val))
    const qs = p.toString()
    return qs ? `/admin/packages?${qs}` : '/admin/packages'
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Product Catalog</h2>
          <p className="mt-1 text-sm text-gray-500">Customer-facing retail packages — these are the products business clients see</p>
        </div>
        <Link href="/admin/provider-catalog"
          className="rounded-lg border border-cyan-300 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50">
          Provider Catalog →
        </Link>
      </div>

      {/* Summary cards */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Product Catalog" value={allRetail.length} color="text-blue-600" />
        <SummaryCard label="Live Products" value={livePackages.length} color="text-emerald-600" />
        <SummaryCard label="Draft / Inactive" value={draftPackages.length} color="text-amber-600" />
        <SummaryCard label="Needs Pricing" value={needsPricingPackages.length} color="text-red-600" />
      </div>

      {searchParams?.error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{decodeURIComponent(searchParams.error)}</div>
      )}
      {searchParams?.success && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">{decodeURIComponent(searchParams.success)}</div>
      )}

      {/* Search */}
      <form method="GET" action="/admin/packages" className="mb-4">
        {tab !== 'live' && <input type="hidden" name="tab" value={tab} />}
        <div className="relative">
          <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            type="text"
            name="search"
            defaultValue={searchQuery}
            placeholder="Search products, country, package code..."
            className="w-full rounded-xl border border-gray-200 bg-white pl-11 pr-10 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20 shadow-sm"
          />
          {searchQuery && (
            <a href={`/admin/packages${tab !== 'live' ? `?tab=${tab}` : ''}`}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </a>
          )}
        </div>
      </form>

      {/* Filters */}
      <div className="mb-4 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider w-14">Provider</span>
          {PROVIDER_OPTIONS.map(o => {
            const href = buildUrl(tab, { provider: o.value || '' })
            const active = (providerFilter || '') === o.value
            return <a key={o.value || 'all'} href={href} className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{o.label}</a>
          })}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider w-14">Validity</span>
          {VALIDITY_OPTIONS.map(o => {
            const href = buildUrl(tab, { validity: o.days || '' })
            const active = validityFilter === o.days
            return <a key={o.days} href={href} className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{o.label}</a>
          })}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider w-14">Sort</span>
          <form method="GET" action="/admin/packages" className="inline-flex items-center gap-1.5">
            {tab !== 'live' && <input type="hidden" name="tab" value={tab} />}
            {searchQuery && <input type="hidden" name="search" value={searchQuery} />}
            {providerFilter && <input type="hidden" name="provider" value={providerFilter} />}
            {validityFilter > 0 && <input type="hidden" name="validity" value={validityFilter} />}
            <select name="sort" defaultValue={sortParam} onChange={e => e.target.form?.submit()} className="rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] font-medium text-gray-700 bg-white focus:border-cyan-500 focus:outline-none">
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </form>
          {(searchQuery || providerFilter || validityFilter > 0) && (
            <a href={tab === 'live' ? '/admin/packages' : `/admin/packages?tab=${tab}`} className="ml-2 rounded-lg border border-gray-300 px-2.5 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-50">Clear Filters</a>
          )}
        </div>
      </div>

      {/* Pill tabs */}
      <div className="mb-6">
        <nav className="inline-flex rounded-xl bg-gray-100 p-1">
          {TABS.map((t) => {
            const href = buildUrl(t.id, {})
            const isActive = tab === t.id
            return (
              <Link
                key={t.id}
                href={href}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  isActive ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.label} <span className={`ml-1 text-xs ${isActive ? 'text-gray-400' : 'text-gray-400'}`}>({tabCounts[t.id] || 0})</span>
              </Link>
            )
          })}
        </nav>
      </div>

      {/* Result count */}
      {displayPackages.length > 0 && (
        <p className="mb-4 text-xs text-gray-400">
          {searchQuery
            ? `Showing ${displayPackages.length} of ${tabFiltered.length} products matching "${searchQuery}"`
            : `Showing ${displayPackages.length} of ${tabFiltered.length} products`}
          {providerFilter && ` · ${providerFilter}`}
          {validityFilter > 0 && ` · ${validityFilter} Days`}
        </p>
      )}

      {displayPackages.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          {searchQuery ? (
            <>
              <p className="text-gray-500">No products match your search.</p>
              <a href={`/admin/packages${tab !== 'live' ? `?tab=${tab}` : ''}`}
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

                <div className="mb-3">
                  <StatusBadge isActive={pkg.isActive} hiddenFromCatalog={pkg.hiddenFromCatalog || undefined} purchaseReady={pkg._readiness.ready} />
                </div>

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
