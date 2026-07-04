import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { BulkConfigTable } from './BulkConfigTable'

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
          <Link href="/admin/provider-catalog?configStatus=AUTO_CONFIGURED&publishStatus=READY"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
            Ready to Publish
          </Link>
          <Link href="/admin/package-rules" className="rounded-lg border border-purple-300 px-4 py-2 text-sm font-medium text-purple-700 hover:bg-purple-50">
            Manage Rules
          </Link>
        </div>
      </div>

      {/* Quick filter tabs */}
      <div className="flex flex-wrap gap-2">
        <Link href="/admin/provider-catalog" className={`rounded-full px-3 py-1 text-xs font-medium ${!searchParams?.configStatus && !searchParams?.publishStatus ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>All</Link>
        <Link href="/admin/provider-catalog?configStatus=UNCONFIGURED" className={`rounded-full px-3 py-1 text-xs font-medium ${searchParams?.configStatus === 'UNCONFIGURED' && !searchParams?.publishStatus ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Unconfigured</Link>
        <Link href="/admin/provider-catalog?configStatus=AUTO_CONFIGURED" className={`rounded-full px-3 py-1 text-xs font-medium ${searchParams?.configStatus === 'AUTO_CONFIGURED' && !searchParams?.publishStatus ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Auto Configured</Link>
        <Link href="/admin/provider-catalog?configStatus=CONFIGURED" className={`rounded-full px-3 py-1 text-xs font-medium ${searchParams?.configStatus === 'CONFIGURED' && !searchParams?.publishStatus ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Configured</Link>
        <Link href="/admin/provider-catalog?publishStatus=PUBLISHED" className={`rounded-full px-3 py-1 text-xs font-medium ${searchParams?.publishStatus === 'PUBLISHED' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Published</Link>
        <Link href="/admin/provider-catalog?publishStatus=READY" className={`rounded-full px-3 py-1 text-xs font-medium ${searchParams?.publishStatus === 'READY' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Ready</Link>
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
        <BulkConfigTable
          initialPackages={packages.map(p => ({
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
            markupPercent: p.markupPercent,
            configurationStatus: p.configurationStatus,
            publishStatus: p.publishStatus,
            provider: p.provider ? { id: p.provider.id, name: p.provider.name, code: p.provider.code } : null,
          }))}
          total={total}
          page={page}
          totalPages={totalPages}
        />
      </div>
    </div>
  )
}
