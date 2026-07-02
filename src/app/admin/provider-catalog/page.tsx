import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

const PUBLISH_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  READY: 'bg-blue-100 text-blue-700',
  PUBLISHED: 'bg-emerald-100 text-emerald-700',
  HIDDEN: 'bg-amber-100 text-amber-700',
  ARCHIVED: 'bg-red-100 text-red-600',
}

const CONFIG_COLORS: Record<string, string> = {
  UNCONFIGURED: 'bg-gray-100 text-gray-600',
  PARTIAL: 'bg-amber-100 text-amber-700',
  CONFIGURED: 'bg-blue-100 text-blue-700',
  AUTO_CONFIGURED: 'bg-emerald-100 text-emerald-700',
}

export default async function ProviderCatalogPage({ searchParams }: { searchParams?: { provider?: string; publishStatus?: string; configStatus?: string; search?: string; country?: string; page?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const page = parseInt(searchParams?.page || '1')
  const limit = 50
  const skip = (page - 1) * limit

  const where: any = {}
  if (searchParams?.provider) where.providerId = searchParams.provider
  if (searchParams?.publishStatus) where.publishStatus = searchParams.publishStatus
  if (searchParams?.configStatus) where.configurationStatus = searchParams.configStatus
  if (searchParams?.country) where.country = searchParams.country
  if (searchParams?.search) {
    where.OR = [
      { name: { contains: searchParams.search, mode: 'insensitive' } },
      { providerPlanId: { contains: searchParams.search, mode: 'insensitive' } },
      { providerPlanCode: { contains: searchParams.search, mode: 'insensitive' } },
    ]
  }

  const [packages, total, providers, countries] = await Promise.all([
    prisma.providerPackage.findMany({
      where,
      include: { provider: { select: { id: true, name: true, code: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.providerPackage.count({ where }),
    prisma.provider.findMany({ where: { providerPackages: { some: {} } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.providerPackage.findMany({ where: { country: { not: null } }, select: { country: true }, distinct: ['country'], orderBy: { country: 'asc' } }),
  ])

  const totalPages = Math.ceil(total / limit)
  const stats = {
    total,
    configured: await prisma.providerPackage.count({ where: { ...where, configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] } } }),
    unconfigured: await prisma.providerPackage.count({ where: { ...where, configurationStatus: 'UNCONFIGURED' } }),
    published: await prisma.providerPackage.count({ where: { ...where, publishStatus: 'PUBLISHED' } }),
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Provider Catalog</h2>
          <p className="text-gray-600">Raw provider packages — configure pricing and publishing before making sellable</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
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
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <form method="GET" action="/admin/provider-catalog" className="flex flex-wrap gap-3 items-end">
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
          {(searchParams?.provider || searchParams?.publishStatus || searchParams?.configStatus || searchParams?.search || searchParams?.country) && (
            <Link href="/admin/provider-catalog" className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Clear</Link>
          )}
        </form>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Provider</th>
                <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Plan ID / Code</th>
                <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Name</th>
                <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Country</th>
                <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Data</th>
                <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Validity</th>
                <th className="px-3 py-3 text-right text-xs font-medium uppercase text-gray-500">Cost</th>
                <th className="px-3 py-3 text-right text-xs font-medium uppercase text-gray-500">Selling</th>
                <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Markup</th>
                <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Config</th>
                <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Publish</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {packages.length === 0 ? (
                <tr><td colSpan={11} className="px-4 py-12 text-center text-sm text-gray-400">No packages found.</td></tr>
              ) : packages.map(pkg => (
                <tr key={pkg.id} className="hover:bg-gray-50">
                  <td className="px-3 py-3 text-sm text-gray-900">{pkg.provider?.name || '—'}</td>
                  <td className="px-3 py-3">
                    <span className="font-mono text-xs text-gray-900">{pkg.providerPlanId}</span>
                    {pkg.providerPlanCode && <span className="block font-mono text-[10px] text-gray-400">{pkg.providerPlanCode}</span>}
                  </td>
                  <td className="px-3 py-3 text-sm text-gray-900 max-w-[200px] truncate">{pkg.name}</td>
                  <td className="px-3 py-3 text-xs text-gray-500">{pkg.country || '—'}{pkg.region ? ` · ${pkg.region}` : ''}</td>
                  <td className="px-3 py-3 text-xs text-center text-gray-600">{pkg.dataGB} GB</td>
                  <td className="px-3 py-3 text-xs text-center text-gray-600">{pkg.validityDays}d</td>
                  <td className="px-3 py-3 text-xs text-right font-medium text-gray-900">${parseFloat(pkg.costPrice.toString()).toFixed(2)}</td>
                  <td className="px-3 py-3 text-xs text-right font-medium text-gray-900">
                    {pkg.sellingPrice ? `$${parseFloat(pkg.sellingPrice.toString()).toFixed(2)}` : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-3 text-xs text-center">
                    {pkg.markupPercent ? (
                      <span className="font-medium text-emerald-600">{parseFloat(pkg.markupPercent.toString())}%</span>
                    ) : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-3 text-center">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${CONFIG_COLORS[pkg.configurationStatus || 'UNCONFIGURED']}`}>
                      {pkg.configurationStatus || 'UNCONFIGURED'}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-center">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${PUBLISH_COLORS[pkg.publishStatus || 'DRAFT']}`}>
                      {pkg.publishStatus || 'DRAFT'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-gray-500">{total} packages · Page {page} of {totalPages}</span>
            <div className="flex gap-2">
              {page > 1 && (
                <Link href={`/admin/provider-catalog?page=${page - 1}`} className="rounded-lg border px-3 py-1 text-gray-600 hover:bg-gray-50">Previous</Link>
              )}
              {page < totalPages && (
                <Link href={`/admin/provider-catalog?page=${page + 1}`} className="rounded-lg border px-3 py-1 text-gray-600 hover:bg-gray-50">Next</Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
