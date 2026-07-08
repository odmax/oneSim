import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

export default async function AdminUsageAnalyticsPage({ searchParams }: { searchParams: { businessId?: string; status?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.VIEW_ANALYTICS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const esimWhere: any = {}
  if (searchParams.businessId) esimWhere.purchase = { businessId: searchParams.businessId }
  if (searchParams.status) esimWhere.status = searchParams.status

  const [esims, businesses, totalEsims] = await Promise.all([
    prisma.eSIM.findMany({
      where: esimWhere,
      include: {
        purchase: {
          include: {
            business: { select: { id: true, name: true, contactEmail: true } },
            package: { select: { id: true, name: true, displayName: true, dataGB: true, providerId: true } },
          },
        },
        usageRecords: { orderBy: { timestamp: 'desc' }, take: 1 },
      },
      orderBy: { dataUsedMB: 'desc' },
      take: 200,
    }),
    prisma.business.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.eSIM.count({ where: esimWhere }),
  ])

  const totalDataUsed = esims.reduce((sum, e) => sum + (e.dataUsedMB || 0), 0)
  const activeCount = esims.filter((e) => e.status === 'ACTIVE').length
  const failedCount = esims.filter((e) => e.status === 'FAILED').length
  const totalPurchases = await prisma.eSIMPurchase.count()

  // Usage by business
  const usageByBusiness = new Map<string, { name: string; esimCount: number; dataUsedMB: number }>()
  for (const esim of esims) {
    const bId = esim.purchase.business.id
    const existing = usageByBusiness.get(bId) || { name: esim.purchase.business.name, esimCount: 0, dataUsedMB: 0 }
    existing.esimCount++
    existing.dataUsedMB += esim.dataUsedMB || 0
    usageByBusiness.set(bId, existing)
  }
  const topBusinesses = [...usageByBusiness.entries()]
    .sort((a, b) => b[1].dataUsedMB - a[1].dataUsedMB)
    .slice(0, 10)

  // Usage by provider
  const usageByProvider = new Map<string, { esimCount: number; dataUsedMB: number }>()
  for (const esim of esims) {
    const pId = esim.purchase.package.providerId || 'unknown'
    const existing = usageByProvider.get(pId) || { esimCount: 0, dataUsedMB: 0 }
    existing.esimCount++
    existing.dataUsedMB += esim.dataUsedMB || 0
    usageByProvider.set(pId, existing)
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Usage Analytics</h2>
        <p className="text-gray-600">Monitor data consumption across all businesses and providers</p>
      </div>

      {/* Summary Cards */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Total Data Used</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{(totalDataUsed / 1024).toFixed(1)} GB</p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Active eSIMs</p>
          <p className="mt-1 text-2xl font-bold text-emerald-600">{activeCount}<span className="text-sm font-normal text-gray-400 ml-1">/ {totalEsims}</span></p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Failed eSIMs</p>
          <p className="mt-1 text-2xl font-bold text-red-600">{failedCount}</p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Total Purchases</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{totalPurchases}</p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Avg MB/eSIM</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{totalEsims > 0 ? Math.round(totalDataUsed / totalEsims) : 0}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 rounded-lg border bg-white p-4 shadow-sm">
        <form className="flex flex-wrap gap-3">
          <div className="min-w-[200px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">Business</label>
            <select name="businessId" defaultValue={searchParams.businessId} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
              <option value="">All Businesses</option>
              {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div className="min-w-[160px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
            <select name="status" defaultValue={searchParams.status} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="PENDING_ACTIVATION">Pending</option>
              <option value="FAILED">Failed</option>
              <option value="EXPIRED">Expired</option>
            </select>
          </div>
          <div className="flex items-end">
            <button type="submit" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700">Filter</button>
          </div>
        </form>
      </div>

      {/* Top Consuming Businesses */}
      <div className="mb-6 rounded-lg border bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-semibold text-gray-900">Top Consuming Businesses</h3>
        <div className="space-y-2">
          {topBusinesses.map(([id, data], i) => (
            <div key={id} className="flex items-center gap-3">
              <span className="w-6 text-sm font-bold text-gray-400">#{i + 1}</span>
              <div className="flex-1">
                <Link href={`/admin/businesses/${id}`} className="text-sm font-medium text-cyan-600 hover:underline">{data.name}</Link>
                <div className="text-xs text-gray-400">{data.esimCount} eSIMs</div>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold text-gray-900">{(data.dataUsedMB / 1024).toFixed(1)} GB</p>
              </div>
            </div>
          ))}
          {topBusinesses.length === 0 && <p className="text-sm text-gray-400">No usage data available.</p>}
        </div>
      </div>

      {/* eSIM Data Table */}
      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Business</th>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">ICCID</th>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Package</th>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Data Used</th>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Expires</th>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Last Sync</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {esims.length === 0 ? (
              <tr><td colSpan={7} className="px-5 py-12 text-center text-sm text-gray-400">No eSIMs found.</td></tr>
            ) : esims.map((esim) => (
              <tr key={esim.id} className="hover:bg-gray-50">
                <td className="whitespace-nowrap px-5 py-3 text-sm">
                  <Link href={`/admin/businesses/${esim.purchase.business.id}`} className="font-medium text-cyan-600 hover:underline">
                    {esim.purchase.business.name}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-sm font-mono text-gray-900">{esim.iccid}</td>
                <td className="whitespace-nowrap px-5 py-3 text-sm text-gray-700">{esim.purchase.package.displayName || esim.purchase.package.name}</td>
                <td className="whitespace-nowrap px-5 py-3 text-sm text-gray-900">{esim.dataUsedMB ? `${(esim.dataUsedMB / 1024).toFixed(2)} GB` : '0 MB'}</td>
                <td className="whitespace-nowrap px-5 py-3">
                  <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                    esim.status === 'ACTIVE' ? 'bg-green-100 text-green-800' :
                    esim.status === 'PENDING_ACTIVATION' ? 'bg-yellow-100 text-yellow-800' :
                    esim.status === 'FAILED' ? 'bg-red-100 text-red-800' :
                    'bg-gray-100 text-gray-800'
                  }`}>{esim.status}</span>
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-sm text-gray-600">
                  {esim.expiresAt ? new Date(esim.expiresAt).toLocaleDateString() : '—'}
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-xs text-gray-400">
                  {esim.lastUsageSyncAt ? new Date(esim.lastUsageSyncAt).toLocaleString() : 'Never'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}