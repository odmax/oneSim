import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { markPreferred, unmarkPreferredPackage, hideDuplicatesInGroup, autoPickCheapestForGroup, autoPickAllGroups, excludeFromAutoPick, includePackageInAutoPick } from '@/lib/actions/auto-pick'
import { autoPickAndPublishWinners, publishPreferredOnly } from '@/lib/actions/auto-publish'

function isValidForHealth(pkg: { configurationStatus: string | null; sellingPrice: any; sellingCurrency: string | null; publishStatus: string | null }) {
  const configured = pkg.configurationStatus === 'CONFIGURED' || pkg.configurationStatus === 'AUTO_CONFIGURED'
  const hasPrice = pkg.sellingPrice && parseFloat(pkg.sellingPrice.toString()) > 0
  const hasCurrency = !!pkg.sellingCurrency
  const notHidden = pkg.publishStatus !== 'HIDDEN' && pkg.publishStatus !== 'ARCHIVED'
  return configured && hasPrice && hasCurrency && notHidden
}

export default async function CatalogHealthPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const all = await prisma.providerPackage.findMany({
    include: { provider: { select: { id: true, name: true } } },
    orderBy: { name: 'asc' },
  })

  // Only show configured/valid packages in health
  const validPackages = all.filter(isValidForHealth)

  // Stats (total still from all, health from valid)
  const stats = {
    total: all.length,
    validForHealth: validPackages.length,
    unconfigured: all.filter(p => p.configurationStatus === 'UNCONFIGURED').length,
    missingPrice: all.filter(p => !p.sellingPrice || parseFloat(p.sellingPrice.toString()) <= 0).length,
    published: all.filter(p => p.publishStatus === 'PUBLISHED').length,
    hidden: all.filter(p => p.publishStatus === 'HIDDEN').length,
    archived: all.filter(p => p.publishStatus === 'ARCHIVED').length,
    configured: all.filter(p => p.configurationStatus === 'CONFIGURED' || p.configurationStatus === 'AUTO_CONFIGURED').length,
  }

  // Duplicate detection: group by country + dataGB + validityDays (only valid packages)
  const groups = new Map<string, typeof validPackages>()
  for (const pkg of validPackages) {
    const key = `${pkg.country || 'XX'}|${pkg.dataGB}|${pkg.validityDays}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(pkg)
  }

  const duplicates = Array.from(groups.entries())
    .filter(([, pkgs]) => pkgs.length > 1)
    .sort((a, b) => b[1].length - a[1].length)

  // Conflicting prices: same group but different selling prices
  const conflicts = duplicates.map(([key, pkgs]) => {
    const prices = new Set(pkgs.map(p => p.sellingPrice?.toString()).filter(Boolean))
    const providerNames = [...new Set(pkgs.map(p => p.provider?.name).filter(Boolean))]
    const published = pkgs.filter(p => p.publishStatus === 'PUBLISHED')
    const cheapestIdx = pkgs.reduce((best, p, i) => {
      const cp = parseFloat(p.costPrice.toString())
      return cp < parseFloat(pkgs[best].costPrice.toString()) ? i : best
    }, 0)

    return {
      key,
      count: pkgs.length,
      countries: [...new Set(pkgs.map(p => p.country).filter(Boolean))],
      dataGB: pkgs[0].dataGB,
      validityDays: pkgs[0].validityDays,
      providers: providerNames,
      hasConflict: prices.size > 1,
      prices: [...prices],
      published,
      packages: pkgs.map(p => ({
        id: p.id,
        name: p.name,
        provider: p.provider?.name || '—',
        costPrice: p.costPrice.toString(),
        sellingPrice: p.sellingPrice?.toString(),
        publishStatus: p.publishStatus,
        configurationStatus: p.configurationStatus,
        isCheapest: p === pkgs[cheapestIdx],
        isPreferred: p.isPreferred,
        excludedFromAutoPick: p.excludedFromAutoPick,
        autoPickReason: p.autoPickReason,
      })),
    }
  })

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Catalog Health</h2>
          <p className="text-gray-600">Detect duplicates and conflicts among configured, priced packages only</p>
        </div>
        <div className="flex gap-2">
          {duplicates.length > 0 && (
            <div className="flex gap-2">
              <form action={autoPickAllGroups}>
                <button type="submit" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700">
                  Auto-Pick Cheapest
                </button>
              </form>
              <form action={async () => { 'use server'; await autoPickAndPublishWinners() }}>
                <button type="submit" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                  Auto-Pick + Publish
                </button>
              </form>
              <form action={async () => { 'use server'; await publishPreferredOnly() }}>
                <button type="submit" className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700">
                  Publish Preferred Only
                </button>
              </form>
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
          <p className="text-xs text-gray-500 uppercase">In Health Scope</p>
          <p className="text-2xl font-bold text-gray-900">{stats.validForHealth}</p>
          <p className="text-[10px] text-gray-400">Configured + priced + not hidden/archived</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Unconfigured (excluded)</p>
          <p className="text-2xl font-bold text-amber-600">{stats.unconfigured}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 uppercase">Missing Price (excluded)</p>
          <p className="text-2xl font-bold text-red-600">{stats.missingPrice}</p>
        </div>
        <div className={`rounded-xl border bg-white p-4 shadow-sm ${duplicates.length > 0 ? 'border-amber-300' : ''}`}>
          <p className="text-xs text-gray-500 uppercase">Duplicate Groups</p>
          <p className={`text-2xl font-bold ${duplicates.length > 0 ? 'text-amber-600' : 'text-gray-900'}`}>{duplicates.length}</p>
        </div>
      </div>

      {/* Duplicate Groups */}
      {duplicates.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b">
            <h3 className="text-base font-semibold text-gray-900">Similar Packages ({duplicates.length} groups)</h3>
            <p className="text-xs text-gray-500 mt-1">Groups of packages with same country, data, and validity — potential duplicates</p>
          </div>
          <div className="divide-y">
            {conflicts.map((group) => (
              <div key={group.key} className="p-4">
                <div className="flex items-center gap-3 mb-2">
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                    {group.count} packages
                  </span>
                  <span className="text-sm text-gray-600">
                    {group.countries.join(', ')} · {group.dataGB} GB · {group.validityDays}d
                  </span>
                  <span className="text-xs text-gray-400">
                    Providers: {group.providers.join(', ')}
                  </span>
                  {group.hasConflict && (
                    <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">
                      Price Conflict
                    </span>
                  )}
                  {group.published.length > 0 && (
                    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      {group.published.length} published
                    </span>
                  )}
                  <div className="ml-auto flex gap-1">
                    <form action={autoPickCheapestForGroup.bind(null, group.key)}>
                      <button type="submit" className="rounded border border-cyan-200 px-2 py-0.5 text-[10px] font-medium text-cyan-700 hover:bg-cyan-50">Auto-Pick</button>
                    </form>
                    <form action={hideDuplicatesInGroup.bind(null, group.key)}>
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
                        <th className="pb-1">Config</th>
                        <th className="pb-1">Publish</th>
                      <th className="pb-1 w-16">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.packages.map(pkg => (
                        <tr key={pkg.id} className={`border-t ${pkg.isCheapest ? 'bg-emerald-50' : ''}`}>
                          <td className="py-1 pr-3 text-gray-600">
                            {pkg.provider}
                            {pkg.isPreferred && <span className="ml-1 inline-flex rounded-full bg-cyan-100 px-1.5 py-0.5 text-[9px] font-medium text-cyan-700">Preferred</span>}
                            {pkg.excludedFromAutoPick && <span className="ml-1 inline-flex rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-medium text-gray-500">Excluded</span>}
                          </td>
                          <td className="py-1 pr-3 text-gray-900 truncate max-w-[200px]">{pkg.name}</td>
                          <td className={`py-1 pr-3 text-right font-mono ${pkg.isCheapest ? 'text-emerald-700 font-medium' : 'text-gray-600'}`}>
                            ${parseFloat(pkg.costPrice).toFixed(2)} {pkg.isCheapest ? '←' : ''}
                          </td>
                          <td className="py-1 pr-3 text-right font-mono text-gray-600">
                            {pkg.sellingPrice ? `$${parseFloat(pkg.sellingPrice).toFixed(2)}` : '—'}
                          </td>
                          <td className={`py-1 pr-3 ${pkg.configurationStatus === 'UNCONFIGURED' ? 'text-amber-600' : 'text-gray-500'}`}>
                            {pkg.configurationStatus || '—'}
                          </td>
                          <td className="py-1">{pkg.publishStatus || '—'}</td>
                          <td className="py-1">
                            <div className="flex gap-1">
                              {pkg.isPreferred ? (
                                <form action={unmarkPreferredPackage.bind(null, pkg.id)}>
                                  <button type="submit" className="text-[10px] text-amber-600 hover:text-amber-700">Unmark Pref</button>
                                </form>
                              ) : (
                                <form action={markPreferred.bind(null, pkg.id)}>
                                  <button type="submit" className="text-[10px] text-cyan-600 hover:text-cyan-700">Pref</button>
                                </form>
                              )}
                              {pkg.excludedFromAutoPick ? (
                                <form action={includePackageInAutoPick.bind(null, pkg.id)}>
                                  <button type="submit" className="text-[10px] text-emerald-600 hover:text-emerald-700">Include</button>
                                </form>
                              ) : (
                                <form action={excludeFromAutoPick.bind(null, pkg.id)}>
                                  <button type="submit" className="text-[10px] text-gray-400 hover:text-gray-600">Excl</button>
                                </form>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {duplicates.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No duplicate or overlapping packages detected.</p>
          <p className="text-xs text-gray-400 mt-1">All configured/priced packages have unique country + data + validity combinations.</p>
        </div>
      )}
    </div>
  )
}
