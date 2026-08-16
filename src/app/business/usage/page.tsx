import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { generateUsageReport } from '@/lib/actions/usage'
import { deriveUsageMetrics } from '@/components/admin/esims/UsageBar'

export default async function UsagePage({
  searchParams
}: {
  searchParams: { 
    customerId?: string;
    status?: string;
    packageId?: string;
  }
}) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  // Build filter conditions
  const where: any = {
    esim: {
      purchase: {
        businessId: session.user.businessId!
      }
    }
  }

  if (searchParams.customerId) {
    where.esim.customerId = searchParams.customerId
  }

  if (searchParams.status) {
    where.esim.status = searchParams.status
  }

  if (searchParams.packageId) {
    where.esim.purchase.packageId = searchParams.packageId
  }

  // Get eSIMs with usage for summary
  const esims = await prisma.eSIM.findMany({
    where: {
      purchase: {
        businessId: session.user.businessId!
      },
      ...(searchParams.customerId && { customerId: searchParams.customerId }),
      ...(searchParams.status && { status: searchParams.status }),
      ...(searchParams.packageId && { 
        purchase: { 
          businessId: session.user.businessId!,
          packageId: searchParams.packageId 
        }
      })
    },
    include: {
      purchase: {
        include: { package: true }
      },
      customer: true,
      usageRecords: true
    }
  })

  // CURRENT usage derives from canonical ESIM snapshot columns; UsageRecord is
  // HISTORICAL (see "Recent Usage Records"). "Total Data Used" is the sum of
  // the current snapshot usage — never a reconstruction from historical rows.
  const totalDataSold = esims.reduce((sum, esim) => sum + (esim.purchase.package.dataGB * 1024), 0)
  const totalDataUsed = esims.reduce((sum, esim) => sum + (esim.dataUsedMB || 0), 0)
  const remainingData = totalDataSold - totalDataUsed
  const activeEsims = esims.filter(e => e.status === 'ACTIVE').length

  // Get customers for filter
  const customers = await prisma.customer.findMany({
    where: { businessId: session.user.businessId! },
    select: { id: true, name: true }
  })

  // Get packages for filter
  const packages = await prisma.eSIMPackage.findMany({
    where: { source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    select: { id: true, name: true }
  })

  // Get usage records with filters
  const usageRecords = await prisma.usageRecord.findMany({
    where,
    include: {
      esim: {
        include: {
          purchase: {
            include: { package: true }
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
          <h2 className="text-2xl font-bold text-gray-900">Usage Tracking</h2>
          <p className="text-gray-600">Monitor data consumption by eSIM, customer, and package</p>
        </div>
        <div className="flex gap-2">
          <form action={generateUsageReport}>
            <button
              type="submit"
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
            >
              Sync Usage
            </button>
          </form>
          <form action="/api/export/business-usage" method="GET">
            <input type="hidden" name="data" value={JSON.stringify(
              usageRecords.map(r => ({
                date: new Date(r.timestamp).toLocaleDateString(),
                iccid: r.esim.iccid,
                customer: r.esim.customer?.name || 'Unassigned',
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
      </div>

      {/* Summary Cards */}
      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-gray-500">Total Data Sold</p>
          <p className="text-3xl font-bold text-gray-900">{(totalDataSold / 1024).toFixed(2)} GB</p>
        </div>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-gray-500">Total Data Used</p>
          <p className="text-3xl font-bold text-cyan-600">{(totalDataUsed / 1024).toFixed(2)} GB</p>
        </div>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-gray-500">Remaining Data</p>
          <p className="text-3xl font-bold text-green-600">{(remainingData / 1024).toFixed(2)} GB</p>
        </div>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-gray-500">Active eSIMs</p>
          <p className="text-3xl font-bold text-gray-900">{activeEsims}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 rounded-lg border bg-white p-4">
        <form className="flex flex-wrap gap-4">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">Filter by Customer</label>
            <select
              name="customerId"
              defaultValue={searchParams.customerId}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
            >
              <option value="">All Customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
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
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border bg-white shadow-sm">
          <div className="border-b p-4">
            <h3 className="text-lg font-semibold text-gray-900">Usage by eSIM</h3>
          </div>
          {esims.length > 0 ? (
            <div className="divide-y">
              {esims.map((esim) => {
                const current = deriveUsageMetrics(esim.dataUsedMB, esim.dataTotalMB, esim.dataRemainingMB)
                return (
                  <div key={esim.id} className="p-4 hover:bg-gray-50">
                    <div className="mb-2 flex items-center justify-between">
                      <div>
                        <p className="font-mono text-sm text-gray-900">{esim.iccid}</p>
                        <p className="text-xs text-gray-500">
                          {esim.customer?.name || 'Unassigned'} • {esim.purchase.package.name}
                        </p>
                      </div>
                      <div className="text-right">
                        {current.hasSnapshot ? (
                          <>
                            <p className="text-sm font-medium text-gray-900">
                              {(current.used / 1024).toFixed(2)} / {current.total > 0 ? `${(current.total / 1024).toFixed(2)}` : '—'} GB
                            </p>
                            <p className="text-xs text-gray-500">
                              {current.total > 0 ? `${((current.used / current.total) * 100).toFixed(1)}% used` : '—'}
                            </p>
                          </>
                        ) : (
                          <p className="text-sm font-medium text-gray-400">Usage unavailable</p>
                        )}
                      </div>
                    </div>
                    {current.hasSnapshot && current.total > 0 ? (
                      <div className="h-2 overflow-hidden rounded-full bg-gray-200">
                        <div
                          className="h-full rounded-full bg-cyan-600"
                          style={{ width: `${Math.min((current.used / current.total) * 100, 100)}%` }}
                        />
                      </div>
                    ) : null}
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
          <div className="border-b p-4">
            <h3 className="text-lg font-semibold text-gray-900">Historical Usage Records</h3>
          </div>
          {usageRecords.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">ICCID</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Customer</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Data Used</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {usageRecords.slice(0, 50).map((record) => (
                    <tr key={record.id} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                        {new Date(record.timestamp).toLocaleDateString()}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-gray-900">
                        {record.esim.iccid.slice(0, 19)}...
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                        {record.esim.customer?.name || 'Unassigned'}
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
    </div>
  )
}
