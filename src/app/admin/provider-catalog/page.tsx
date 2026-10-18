import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { BulkConfigTable } from './BulkConfigTable'
import { PublishAllReadyButton } from './PublishAllReadyButton'
import { buildPortalExposureForRetail } from '@/lib/packages/customer-visibility'
import { computeCatalogStats } from '@/lib/packages/catalog-stats'
import { PROVIDER_PACKAGE_STATE_LABELS, PROVIDER_PACKAGE_STATE_COLORS, type ProviderPackageAdminState } from '@/lib/packages/provider-package-state'
import { buildProviderCatalogView } from '@/lib/packages/provider-catalog-pipeline'
import { buildProviderCatalogWhere } from '@/lib/packages/provider-catalog-query'

const ADMIN_STATES: ProviderPackageAdminState[] = ['READY', 'NEEDS_CONFIGURATION', 'NEEDS_PRICING', 'UNAVAILABLE_QUARANTINED', 'DRAFT_UNPUBLISHED', 'BLOCKED_OTHER']

function isAdminState(s: string | undefined): s is ProviderPackageAdminState {
  return !!s && (ADMIN_STATES as string[]).includes(s)
}

export default async function ProviderCatalogPage({ searchParams }: { searchParams?: { provider?: string; publishStatus?: string; configStatus?: string; search?: string; country?: string; page?: string; costFilter?: string; state?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const requestedPage = Number.parseInt(searchParams?.page || '1', 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const limit = 50

  // NOTE: `state` is deliberately NOT part of the SQL where-clause. State is
  // computed with the canonical classifier over the COMPLETE matching
  // population; the filter and the tab counts come from that same classified
  // set (see buildProviderCatalogView). This removes all SQL approximation.

  const where = buildProviderCatalogWhere(searchParams || {})

  const rules = await prisma.packageConfigurationRule.findMany({
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, name: true, priority: true, isActive: true },
  })

  // Load the COMPLETE applicable ProviderPackage population (non-state filters
  // apply at SQL level), classify every row with the canonical state classifier,
  // then filter by state and paginate deterministically — never filtering an
  // already-paginated subset.
  const [population, providers, countries] = await Promise.all([
    prisma.providerPackage.findMany({
      where,
      include: { provider: { select: { id: true, name: true, code: true, status: true, enabledCapabilities: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    }).catch(() => []),
    prisma.provider.findMany({ where: { providerPackages: { some: {} } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }).catch(() => []),
    prisma.providerPackage.findMany({ where: { country: { not: null } }, select: { country: true }, distinct: ['country'], orderBy: { country: 'asc' } }).catch(() => []),
  ])

  const parsedState = (searchParams?.state && isAdminState(searchParams.state) ? searchParams.state : null)
  const view = buildProviderCatalogView({ rows: population, state: parsedState, page, pageSize: limit })

  // CANONICAL customer-visible count (the predicate /business/buy-esim and the
  // client API actually enforce): operational readiness + price parity + portal
  // exposure — not a naive "active product" count.
  const retailForStats = await prisma.eSIMPackage.findMany({
    where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    select: {
      id: true, isActive: true, hiddenFromCatalog: true, archivedAt: true, source: true, providerPackageId: true, priceUSD: true, providerId: true,
      providerPackage: { select: { publishStatus: true, costStatus: true, pricingStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true, providerId: true, isAvailable: true } },
      provider: { select: { status: true, enabledCapabilities: true, code: true } },
      providerBindings: {
        where: { isActive: true },
        select: {
          id: true, isActive: true,
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
    },
  }).catch(() => [])
  const exposureMap = await buildPortalExposureForRetail(retailForStats.map(p => ({ providerId: p.providerId, providerPackage: p.providerPackage?.providerId ? { providerId: p.providerPackage.providerId } : null })))
  const catalogStats = computeCatalogStats(retailForStats as any, exposureMap)

  const stateLink = (state: string) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(searchParams || {})) {
      if (value && key !== 'page' && key !== 'state') params.set(key, value)
    }
    if (state) params.set('state', state)
    return `/admin/provider-catalog?${params}`
  }

  const totalPages = view.totalPages
  const stats = {
    total: view.counts.total,
    configured: await prisma.providerPackage.count({ where: { ...where, configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] } } }).catch(() => 0),
    unconfigured: await prisma.providerPackage.count({ where: { ...where, configurationStatus: 'UNCONFIGURED' } }).catch(() => 0),
    published: await prisma.providerPackage.count({ where: { ...where, publishStatus: 'PUBLISHED' } }).catch(() => 0),
    clientVisible: catalogStats.customerVisible,
    operationalLive: catalogStats.operationalLive,
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Provider Catalog</h2>
          <p className="text-gray-600">Configure raw provider packages here, then publish selected packages to Product Catalog</p>
        </div>
        <div className="flex gap-2">
          <a href="/api/admin/provider-catalog-export"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Export CSV
          </a>
          <a href="/api/admin/provider-catalog-export/xlsx"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Export XLSX
          </a>
          <Link href="/admin/provider-catalog/history"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            History
          </Link>
          <Link href="/admin/provider-catalog/health"
            className="rounded-lg border border-amber-300 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50">
            Health
          </Link>
          <Link href="/admin/provider-catalog?state=READY"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
            Ready to Publish
          </Link>
          <Link href="/admin/provider-catalog/custom/new"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            Create Custom Package
          </Link>
          <Link href="/admin/package-rules" className="rounded-lg border border-purple-300 px-4 py-2 text-sm font-medium text-purple-700 hover:bg-purple-50">
            Manage Rules
          </Link>
        </div>
      </div>

      {/* Quick filter tabs — exact canonical state counts from the complete population */}
      <div className="flex flex-wrap gap-2">
        <Link href="/admin/provider-catalog" className={`rounded-full px-3 py-1 text-xs font-medium ${!searchParams?.state && !searchParams?.configStatus && !searchParams?.publishStatus ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>All ({view.counts.total})</Link>
        {ADMIN_STATES.map(state => (
          <Link
            key={state}
            href={stateLink(state)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${parsedState === state ? 'bg-gray-900 text-white' : `${PROVIDER_PACKAGE_STATE_COLORS[state]} hover:opacity-80`}`}
          >
            {PROVIDER_PACKAGE_STATE_LABELS[state]} ({view.counts[state]})
          </Link>
        ))}
        <Link href="/admin/provider-catalog?costFilter=missing" className={`rounded-full px-3 py-1 text-xs font-medium ${searchParams?.costFilter === 'missing' ? 'bg-red-900 text-white' : 'bg-red-50 text-red-600 hover:bg-red-100'}`}>Missing Cost</Link>
        <Link href="/admin/provider-catalog?configStatus=UNCONFIGURED" className={`rounded-full px-3 py-1 text-xs font-medium ${searchParams?.configStatus === 'UNCONFIGURED' && !searchParams?.publishStatus ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Config: Unconfigured</Link>
        <Link href="/admin/provider-catalog?publishStatus=PUBLISHED" className={`rounded-full px-3 py-1 text-xs font-medium ${searchParams?.publishStatus === 'PUBLISHED' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Publish: Published</Link>
        <Link href="/admin/provider-catalog?publishStatus=READY" className={`rounded-full px-3 py-1 text-xs font-medium ${searchParams?.publishStatus === 'READY' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Publish: Ready</Link>
      </div>

      {/* Ready tab — bulk publish banner */}
      {searchParams?.publishStatus === 'READY' && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-emerald-800">Ready to Publish</p>
            <p className="text-xs text-emerald-600 mt-0.5">These packages have valid pricing and configuration — publish them to make them available in the Product Catalog.</p>
          </div>
          <PublishAllReadyButton />
        </div>
      )}

      {/* Direction — how manual configuration works */}
      <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-sm text-cyan-800">
        <p className="font-medium mb-1">How to configure packages</p>
        <ol className="list-decimal list-inside space-y-1 text-cyan-700">
          <li><strong>Set cost price</strong> — enter the provider cost (raw or admin-override). Edit a row or select multiple and click <strong>Configure</strong>.</li>
          <li><strong>Set selling price</strong> — enter a client-facing price, or use Markup % to auto-calculate from cost.</li>
          <li><strong>Mark as Configured</strong> — set Config Status to <strong>Configured</strong> (or let <strong>Apply Rules</strong> do this automatically).</li>
          <li><strong>Publish</strong> — set Publish Status to <strong>Published</strong>. The package then appears in the <strong>Product Catalog</strong> for client activation.</li>
        </ol>
        <p className="mt-2 text-cyan-600">Use <strong>Apply Rules</strong> to auto-configure all unconfigured packages. Use <strong>Undo Last Rules</strong> to rollback. Click <strong>Edit</strong> per row for fine-grained control.</p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-5">
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Total Packages</p>
          <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Configured</p>
          <p className="text-2xl font-bold text-emerald-600">{stats.configured}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Unconfigured</p>
          <p className="text-2xl font-bold text-amber-600">{stats.unconfigured}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Published</p>
          <p className="text-2xl font-bold text-blue-600">{stats.published}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Client-Visible</p>
          <p className="text-2xl font-bold text-emerald-600">{stats.clientVisible}</p>
          <p className="mt-1 text-[10px] text-gray-400">{stats.operationalLive} operational · exact Business Buy predicate</p>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <form method="GET" action="/admin/provider-catalog" className="flex flex-wrap gap-3 items-end">
          {parsedState && <input type="hidden" name="state" value={parsedState} />}
          {searchParams?.costFilter && <input type="hidden" name="costFilter" value={searchParams.costFilter} />}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Search</label>
            <input type="text" name="search" defaultValue={searchParams?.search || ''} placeholder="Name, plan ID, SKU..."
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none w-48" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Provider</label>
            <select name="provider" defaultValue={searchParams?.provider || ''} className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
              <option value="">All</option>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Publish Status</label>
            <select name="publishStatus" defaultValue={searchParams?.publishStatus || ''} className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
              <option value="">All</option>
              <option value="DRAFT">Draft</option>
              <option value="READY">Ready</option>
              <option value="PUBLISHED">Published</option>
              <option value="HIDDEN">Hidden</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Configuration</label>
            <select name="configStatus" defaultValue={searchParams?.configStatus || ''} className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
              <option value="">All</option>
              <option value="UNCONFIGURED">Unconfigured</option>
              <option value="PARTIAL">Partial</option>
              <option value="CONFIGURED">Configured</option>
              <option value="AUTO_CONFIGURED">Auto Configured</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Country</label>
            <select name="country" defaultValue={searchParams?.country || ''} className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
              <option value="">All</option>
              {countries.filter(c => c.country).map(c => <option key={c.country!} value={c.country!}>{c.country}</option>)}
            </select>
          </div>
          <button type="submit" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700">Filter</button>
          {(searchParams?.provider || searchParams?.publishStatus || searchParams?.configStatus || searchParams?.search || searchParams?.country || searchParams?.costFilter || searchParams?.state) && (
            <Link href="/admin/provider-catalog" className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Clear</Link>
          )}
        </form>
      </div>

      {/* Table — rows are the canonical-classified page slice of the state-filtered population */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <BulkConfigTable
          rules={rules}
          providers={providers}
          matchingIds={view.orderedIds}
          initialPackages={view.pageRows.map(c => {
            const p = c.row as any
            const state: ProviderPackageAdminState = c.state
            const readiness = { ready: c.ready, reasons: c.reasons }
            return {
              id: p.id,
              providerId: p.providerId,
              providerPlanId: p.providerPlanId,
              providerPlanCode: p.providerPlanCode,
              name: p.name,
              dataGB: p.dataGB,
              validityDays: p.validityDays,
              costPrice: p.costPrice,
              currency: p.currency,
              country: p.country,
              region: p.region,
              sellingPrice: p.sellingPrice,
              sellingCurrency: p.sellingCurrency,
              markupPercent: p.markupPercent,
              pricingMode: p.pricingMode,
              configurationStatus: p.configurationStatus,
              publishStatus: p.publishStatus,
              notes: p.notes,
              isAvailable: p.isAvailable,
              purchaseReady: readiness.ready,
              readinessReasons: readiness.reasons,
              state,
              stateLabel: PROVIDER_PACKAGE_STATE_LABELS[state],
              stateColor: PROVIDER_PACKAGE_STATE_COLORS[state],
              provider: p.provider ? { id: p.provider.id, name: p.provider.name, code: p.provider.code } : null,
            }
          })}
          total={view.total}
          page={Math.min(page, Math.max(1, view.totalPages))}
          totalPages={totalPages}
        />
      </div>
    </div>
  )
}
