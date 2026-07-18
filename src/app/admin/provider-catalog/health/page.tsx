import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { markPreferredPackage, unmarkPreferredPackage, hideDuplicatesInGroup, autoPickCheapestForGroup, autoPickAllGroups, excludePackageFromAutoPick, includePackageInAutoPick } from '@/lib/actions/auto-pick'
import { HealthActionButtons } from './HealthActionButtons'
import { checkPackageEligibility } from '@/lib/packages/package-eligibility'

function formatPrice(v: any): string {
  if (v == null) return '—'
  const n = typeof v === 'object' && 'toString' in v ? parseFloat(v.toString()) : Number(v)
  return isNaN(n) ? '—' : `$${n.toFixed(2)}`
}

function fmt(v: any): string {
  if (v == null || v === '') return '—'
  return String(v)
}

interface PackageWithProvider {
  id: string
  name: string
  providerId: string
  dataGB: number
  validityDays: number
  country: string | null
  region: string | null
  costPrice: any
  sellingPrice: any
  sellingCurrency: string | null
  configurationStatus: string | null
  publishStatus: string | null
  isAvailable: boolean
  excludedFromCheapest: boolean
  excludedFromAutoPick: boolean
  isPreferred: boolean
  autoPickReason: string | null
  cheapestRank: number | null
  isCheapestCandidate: boolean
  cheapestReason: string | null
  effectiveCostPrice: number | null
  provider: { id: string; name: string; status?: string | null } | null
  publishedAs?: { archivedAt?: Date | string | null } | null
}

export default async function CatalogHealthPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const all = await prisma.providerPackage.findMany({
    include: { provider: { select: { id: true, name: true } } },
    orderBy: { name: 'asc' },
  }) as PackageWithProvider[]

  // Compute eligibility for every package using the shared function
  const withEligibility = all.map(pkg => {
    const elig = checkPackageEligibility(pkg)
    return { ...pkg, elig }
  })

  const eligiblePlans = withEligibility.filter(p => p.elig.catalogHealthEligible)
  const ineligiblePlans = withEligibility.filter(p => !p.elig.catalogHealthEligible)

  // Group eligible plans by country|dataGB|validityDays
  const groups = new Map<string, typeof eligiblePlans>()
  for (const pkg of eligiblePlans) {
    const key = `${pkg.country || 'XX'}|${pkg.dataGB}|${pkg.validityDays}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(pkg)
  }

  const duplicateGroups = Array.from(groups.entries())
    .filter(([, pkgs]) => pkgs.length > 1)
    .sort((a, b) => b[1].length - a[1].length)

  const soloPlans = Array.from(groups.entries())
    .filter(([, pkgs]) => pkgs.length === 1)
    .map(([, pkgs]) => pkgs[0])

  const stats = {
    total: all.length,
    eligible: eligiblePlans.length,
    ineligible: ineligiblePlans.length,
    unconfigured: all.filter(p => p.configurationStatus === 'UNCONFIGURED').length,
    missingPrice: all.filter(p => !p.sellingPrice || parseFloat(p.sellingPrice.toString()) <= 0).length,
    duplicateGroups: duplicateGroups.length,
    soloPlans: soloPlans.length,
    published: all.filter(p => p.publishStatus === 'PUBLISHED').length,
    hidden: all.filter(p => p.publishStatus === 'HIDDEN').length,
    archived: all.filter(p => p.publishStatus === 'ARCHIVED').length,
  }

  function InlineBadge({ label, color }: { label: string; color: string }) {
    return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${color}`}>{label}</span>
  }

  function IneligibleRow({ pkg }: { pkg: typeof withEligibility[0] }) {
    return (
      <tr className="border-t border-gray-100">
        <td className="py-2 pr-3 text-xs text-gray-600">{pkg.provider?.name || '—'}</td>
        <td className="py-2 pr-3 text-xs text-gray-900 truncate max-w-[200px]">{pkg.name}</td>
        <td className="py-2 pr-3 text-xs text-gray-500">{fmt(pkg.configurationStatus)}</td>
        <td className="py-2 pr-3 text-xs text-gray-500">{fmt(pkg.publishStatus)}</td>
        <td className="py-2 pr-3 text-xs font-mono text-gray-500">{formatPrice(pkg.sellingPrice)}</td>
        <td className="py-2 pr-3 text-xs text-gray-500">{fmt(pkg.sellingCurrency)}</td>
        <td className="py-2 text-xs">
          <div className="flex flex-wrap gap-1 max-w-[300px]">
            {pkg.elig.reasons.map((r, i) => (
              <span key={i} className="inline-flex items-center rounded-full bg-red-50 px-1.5 py-0.5 text-[9px] font-medium text-red-600 border border-red-100">
                {r}
              </span>
            ))}
            {pkg.elig.reasons.length === 0 && <span className="text-gray-400 text-[9px]">Unknown</span>}
          </div>
        </td>
      </tr>
    )
  }

  function EligibleRow({ pkg, rank }: { pkg: typeof withEligibility[0]; rank?: number }) {
    return (
      <tr className={`border-t ${rank === 1 ? 'bg-emerald-50' : ''}`}>
        <td className="py-2 pr-3 text-xs text-gray-600">
          {pkg.provider?.name || '—'}
          {pkg.isPreferred && <InlineBadge label="Preferred" color="bg-cyan-100 text-cyan-700 ml-1" />}
          {pkg.excludedFromAutoPick && <InlineBadge label="Excluded" color="bg-gray-100 text-gray-500 ml-1" />}
          {rank === 1 && <InlineBadge label="Cheapest" color="bg-emerald-100 text-emerald-700 ml-1" />}
        </td>
        <td className="py-2 pr-3 text-xs text-gray-900 truncate max-w-[180px]">{pkg.name}</td>
        <td className="py-2 pr-3 text-xs font-mono text-gray-600">{formatPrice(pkg.costPrice)}</td>
        <td className="py-2 pr-3 text-xs font-mono text-gray-600">{formatPrice(pkg.sellingPrice)}</td>
        <td className="py-2 pr-3 text-xs text-gray-500">{fmt(pkg.sellingCurrency)}</td>
        <td className="py-2 pr-3 text-xs text-gray-500">{fmt(pkg.configurationStatus)}</td>
        <td className="py-2 pr-3 text-xs text-gray-500">{fmt(pkg.publishStatus)}</td>
        <td className="py-2 text-xs">
          <div className="flex gap-1">
            {pkg.isPreferred ? (
              <form action={unmarkPreferredPackage.bind(null, pkg.id)}>
                <button type="submit" className="rounded border border-amber-200 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 hover:bg-amber-50">Unmark</button>
              </form>
            ) : (
              <form action={markPreferredPackage.bind(null, pkg.id)}>
                <button type="submit" className="rounded border border-cyan-200 px-1.5 py-0.5 text-[9px] font-medium text-cyan-700 hover:bg-cyan-50">Mark Preferred</button>
              </form>
            )}
            {pkg.excludedFromAutoPick ? (
              <form action={includePackageInAutoPick.bind(null, pkg.id)}>
                <button type="submit" className="rounded border border-emerald-200 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700 hover:bg-emerald-50">Include</button>
              </form>
            ) : (
              <form action={excludePackageFromAutoPick.bind(null, pkg.id)}>
                <button type="submit" className="rounded border border-gray-200 px-1.5 py-0.5 text-[9px] font-medium text-gray-500 hover:bg-gray-50">Exclude</button>
              </form>
            )}
          </div>
        </td>
      </tr>
    )
  }

  function DuplicateGroup({ groupKey, pkgs }: { groupKey: string; pkgs: typeof eligiblePlans }) {
    const prices = new Set(pkgs.map(p => p.sellingPrice?.toString()).filter(Boolean))
    const providerNames = [...new Set(pkgs.map(p => p.provider?.name).filter(Boolean))]
    const published = pkgs.filter(p => p.publishStatus === 'PUBLISHED')
    const sorted = [...pkgs].sort((a, b) => {
      const aC = parseFloat(a.costPrice.toString())
      const bC = parseFloat(b.costPrice.toString())
      if (aC !== bC) return aC - bC
      return a.id.localeCompare(b.id)
    })

    return (
      <div key={groupKey} className="p-4">
        <div className="flex items-center gap-3 mb-2">
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
            {pkgs.length} packages
          </span>
          <span className="text-sm text-gray-600">
            {[...new Set(pkgs.map(p => p.country).filter(Boolean))].join(', ')} · {pkgs[0].dataGB} GB · {pkgs[0].validityDays}d
          </span>
          <span className="text-xs text-gray-400">Providers: {providerNames.join(', ')}</span>
          {prices.size > 1 && (
            <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">Price Conflict</span>
          )}
          {published.length > 0 && (
            <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">{published.length} published</span>
          )}
          <div className="ml-auto flex gap-1">
            <form action={autoPickCheapestForGroup.bind(null, groupKey)}>
              <button type="submit" className="rounded border border-cyan-200 px-2 py-0.5 text-[10px] font-medium text-cyan-700 hover:bg-cyan-50">Auto-Pick</button>
            </form>
            <form action={hideDuplicatesInGroup.bind(null, groupKey)}>
              <button type="submit" className="rounded border border-amber-200 px-2 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-50">Hide Duplicates</button>
            </form>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="pb-1">Provider</th>
                <th className="pb-1">Name</th>
                <th className="pb-1 text-right">Cost</th>
                <th className="pb-1 text-right">Selling</th>
                <th className="pb-1">Currency</th>
                <th className="pb-1">Config</th>
                <th className="pb-1">Publish</th>
                <th className="pb-1 w-20">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((pkg, i) => (
                <EligibleRow key={pkg.id} pkg={pkg} rank={i + 1} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Catalog Health</h2>
          <p className="text-gray-600">Comprehensive package eligibility view — configured, priced packages only are publishable</p>
        </div>
        <div className="flex gap-2">
          {duplicateGroups.length > 0 && (
            <div className="flex gap-2">
              <form action={autoPickAllGroups}>
                <button type="submit" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700">
                  Auto-Pick Cheapest
                </button>
              </form>
              <HealthActionButtons hasDuplicates={duplicateGroups.length > 0} />
            </div>
          )}
          <Link href="/admin/provider-catalog" className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            ← Back to Catalog
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Total Packages</p>
          <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Eligible (in scope)</p>
          <p className="text-2xl font-bold text-emerald-600">{stats.eligible}</p>
          <p className="text-[10px] text-gray-400">Configured + priced + not hidden/archived</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Ineligible</p>
          <p className="text-2xl font-bold text-red-600">{stats.ineligible}</p>
          <p className="text-[10px] text-gray-400">Missing config, price, or hidden/archived</p>
        </div>
        <div className={`rounded-xl border bg-white p-4 shadow-sm ${duplicateGroups.length > 0 ? 'border-amber-300' : ''}`}>
          <p className="text-xs text-gray-500 uppercase">Duplicate Groups</p>
          <p className={`text-2xl font-bold ${duplicateGroups.length > 0 ? 'text-amber-600' : 'text-gray-900'}`}>{duplicateGroups.length}</p>
          <p className="text-[10px] text-gray-400">{stats.soloPlans} solo, {stats.duplicateGroups} overlapping</p>
        </div>
      </div>

      {/* Eligible Solo Plans */}
      {soloPlans.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b">
            <h3 className="text-base font-semibold text-gray-900">Solo Eligible Plans ({soloPlans.length})</h3>
            <p className="text-xs text-gray-500 mt-1">Unique packages — no duplicates in their country+data+validity group</p>
          </div>
          <div className="overflow-x-auto p-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="pb-2 pr-3">Provider</th>
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pr-3 text-right">Cost</th>
                  <th className="pb-2 pr-3 text-right">Selling</th>
                  <th className="pb-2 pr-3">Currency</th>
                  <th className="pb-2 pr-3">Config</th>
                  <th className="pb-2 pr-3">Publish</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {soloPlans.map(pkg => (
                  <EligibleRow key={pkg.id} pkg={pkg} rank={1} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Duplicate Groups */}
      {duplicateGroups.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b">
            <h3 className="text-base font-semibold text-gray-900">Duplicate / Overlapping Groups ({duplicateGroups.length})</h3>
            <p className="text-xs text-gray-500 mt-1">Multiple packages with same country, data, and validity — potential duplicates</p>
          </div>
          <div className="divide-y">
            {duplicateGroups.map(([key, pkgs]) => (
              <DuplicateGroup key={key} groupKey={key} pkgs={pkgs} />
            ))}
          </div>
        </div>
      )}

      {/* Ineligible Plans */}
      {ineligiblePlans.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b bg-red-50">
            <h3 className="text-base font-semibold text-red-800">Ineligible Plans ({ineligiblePlans.length})</h3>
            <p className="text-xs text-red-600 mt-1">These plans are not visible in Catalog Health — fix the listed issues to make them eligible</p>
          </div>
          <div className="overflow-x-auto p-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="pb-2 pr-3">Provider</th>
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pr-3">Config Status</th>
                  <th className="pb-2 pr-3">Publish Status</th>
                  <th className="pb-2 pr-3 text-right">Selling Price</th>
                  <th className="pb-2 pr-3">Currency</th>
                  <th className="pb-2">Reasons</th>
                </tr>
              </thead>
              <tbody>
                {ineligiblePlans.map(pkg => (
                  <IneligibleRow key={pkg.id} pkg={pkg} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {eligiblePlans.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No eligible packages found.</p>
          <p className="text-xs text-gray-400 mt-1">Configure plans with prices, currency, and set publishStatus to READY to appear here.</p>
        </div>
      )}
    </div>
  )
}
