import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { generateUsageReport } from '@/lib/actions/usage'

export default async function AdminUsagePage({
  searchParams
}: {
  searchParams: { 
    businessId?: string;
    customerId?: string;
    packageId?: string;
    status?: string;
  }
}) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }

  // Build filter conditions
  const where: any = {}

  if (searchParams.businessId) {
    where.purchase = { businessId: searchParams.businessId }
  }

  if (searchParams.customerId) {
    where.customerId = searchParams.customerId
  }

  if (searchParams.status) {
    where.status = searchParams.status
  }

  if (searchParams.packageId) {
    where.purchase = { 
      ...where.purchase,
      packageId: searchParams.packageId 
    }
  }

  // Get all eSIMs with filters for summary
  const esims = await prisma.eSIM.findMany({
    where,
    include: {
      purchase: {
        include: { 
          business: true,
          package: true 
        }
      },
      customer: true,
      usageRecords: true
    }
  })

  // Calculate summary stats
  const totalBusinesses = new Set(esims.map(e => e.purchase.businessId)).size
  const totalEsims = esims.length
  const totalDataUsed = esims.reduce((sum, esim) => 
    sum + esim.usageRecords.reduce((s, r) => s + r.dataUsedMB, 0), 0
  )
  
  // Revenue estimate (based on purchase amounts)
  const revenueEstimate = esims.reduce((sum, esim) => 
    sum + Number(esim.purchase.totalAmount), 0
  )

  // Get businesses for filter
  const businesses = await prisma.business.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' }
  })

  // Get packages for filter
  const packages = await prisma.eSIMPackage.findMany({
    select: { id: true, name: true }
  })

  // Get usage records with filters
  const usageRecords = await prisma.usageRecord.findMany({
    where: {
      esim: where
    },
    include: {
      esim: {
        include: {
          purchase: {
            include: { 
              business: true,
              package: true 
            }
          },
          customer: true
        }
      }
    },
    orderBy: { timestamp: 'desc' },
    take: 100
  })

  const totalUsageDisplay = usageRecords.reduce((sum, record) => sum + record.dataUsedMB, 0)

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Usage Analytics</h2>
          <p className="text-gray-600">Monitor data usage across all businesses</p>
        </div>
        <form action={generateUsageReport}>
          <button
            type="submit"
            className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
          >
            Sync Usage
          </button>
        </form>
      </div>

      {/* Summary Cards */}
      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-gray-500">Total Businesses</p>
          <p className="text-3xl font-bold text-gray-900">{totalBusinesses}</p>
        </div>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-gray-500">Total eSIMs</p>
          <p className="text-3xl font-bold text-gray-900">{totalEsims}</p>
        </div>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-gray-500">Total Data Used</p>
          <p className="text-3xl font-bold text-cyan-600">{(totalDataUsed / 1024).toFixed(2)} GB</p>
        </div>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-gray-500">Revenue Estimate</p>
          <p className="text-3xl font-bold text-green-600">${revenueEstimate.toFixed(2)}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 rounded-lg border bg-white p-4">
        <form className="flex flex-wrap gap-4">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">Filter by Business</label>
            <select
              name="businessId"
              defaultValue={searchParams.businessId}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
            >
              <option value="">All Businesses</option>
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">Filter by Status</label>
            <select
              name="status"
              defaultValue={searchParams.status}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
            >
              <option value="">All Statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="PENDING">Pending</option>
              <option value="INACTIVE">Inactive</option>
              <option value="EXPIRED">Expired</option>
            </select>
          </div>

          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">Filter by Package</label>
            <select
              name="packageId"
              defaultValue={searchParams.packageId}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
            >
              <option value="">All Packages</option>
              {packages.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-end">
            <button
              type="submit"
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
            >
              Filter
            </button>
          </div>
        </form>
      </div>

      {/* Usage by eSIM */}
      <div className="mb-6 rounded-lg border bg-white shadow-sm">
        <div className="border-b p-4">
          <h3 className="text-lg font-semibold text-gray-900">Usage by eSIM</h3>
        </div>
        {esims.length > 0 ? (
          <div className="divide-y">
            {esims.slice(0, 50).map((esim) => {
              const esimUsage = esim.usageRecords.reduce((sum, r) => sum + r.dataUsedMB, 0)
              const percentage = (esimUsage / 1024) / esim.purchase.package.dataGB * 100
              return (
                <div key={esim.id} className="p-4 hover:bg-gray-50">
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <p className="font-mono text-sm text-gray-900">{esim.iccid}</p>
                      <p className="text-xs text-gray-500">
                        {esim.purchase.business.name} • {esim.customer?.name || 'Unassigned'} • {esim.purchase.package.name}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-gray-900">
                        {(esimUsage / 1024).toFixed(2)} / {esim.purchase.package.dataGB} GB
                      </p>
                      <p className="text-xs text-gray-500">
                        {percentage.toFixed(1)}% used
                      </p>
                    </div>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-gray-200">
                    <div 
                      className="h-full rounded-full bg-cyan-600" 
                      style={{ width: `${Math.min(percentage, 100)}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="p-8 text-center">
            <p className="text-gray-500">No eSIMs found</p>
          </div>
        )}
      </div>

      {/* Recent Usage Records */}
      <div className="rounded-lg border bg-white shadow-sm">
        <div className="border-b p-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Recent Usage Records</h3>
          <form action="/api/export/admin-usage" method="GET">
            <input type="hidden" name="data" value={JSON.stringify(
              usageRecords.map(r => ({
                date: new Date(r.timestamp).toLocaleDateString(),
                business: r.esim.purchase.business.name,
                customer: r.esim.customer?.name || 'Unassigned',
                iccid: r.esim.iccid,
                package: r.esim.purchase.package.name,
                dataUsedGB: (r.dataUsedMB / 1024).toFixed(2)
              }))
            )} />
            <button
              type="submit"
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              Export CSV
            </button>
          </form>
        </div>
        {usageRecords.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Date</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Business</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Customer</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">ICCID</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Data Used</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {usageRecords.map((record) => (
                  <tr key={record.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                      {new Date(record.timestamp).toLocaleDateString()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                      {record.esim.purchase.business.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                      {record.esim.customer?.name || 'Unassigned'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-gray-900">
                      {record.esim.iccid.slice(0, 19)}...
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                      {(record.dataUsedMB / 1024).toFixed(2)} GB
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-center">
            <p className="text-gray-500">No usage records yet</p>
          </div>
        )}
      </div>
    </div>
  )
}
