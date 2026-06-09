import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import SyncButton from '@/components/SyncButton'
import { getPackageDisplayName } from '@/lib/packages/snapshot-utils'

export default async function AdminESIMsPage({
  searchParams
}: {
  searchParams: { 
    businessId?: string;
    customerId?: string;
    iccid?: string;
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
  
  if (searchParams.iccid) {
    where.iccid = { contains: searchParams.iccid }
  }
  
  if (searchParams.status) {
    where.status = searchParams.status
  }

  const esims = await prisma.eSIM.findMany({
    where,
    include: {
      purchase: {
        include: {
          business: true,
          package: true
        }
      },
      customer: true
    },
    orderBy: { createdAt: 'desc' },
    take: 100
  })

  // Get businesses for filter dropdown
  const businesses = await prisma.business.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' }
  })

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">All eSIMs</h2>
        <p className="text-gray-600">Monitor all provisioned eSIMs - OneSim → Business Client → End Customer → eSIM</p>
      </div>

      {/* Filters */}
      <div className="mb-6 rounded-lg border bg-white p-4">
        <form className="flex flex-wrap gap-4">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">Search ICCID</label>
            <input
              type="text"
              name="iccid"
              placeholder="Search by ICCID..."
              defaultValue={searchParams.iccid}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
            />
          </div>
          
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
              <option value="SUSPENDED">Suspended</option>
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

      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                ICCID
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Business Client
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                End Customer
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Package
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Delivery Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Provider Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Activated
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Expires
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {esims.map((esim) => (
              <tr key={esim.id} className="hover:bg-gray-50">
                <td className="whitespace-nowrap px-6 py-4 text-sm font-mono text-gray-900">
                  {esim.iccid}
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-900">
                  <div className="font-medium">{esim.purchase.business.name}</div>
                  <div className="text-xs text-gray-500">{esim.purchase.business.contactEmail}</div>
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-900">
                  {esim.customer ? (
                    <div>
                      <div className="font-medium">{esim.customer.name}</div>
                      <div className="text-xs text-gray-500">{esim.customer.email}</div>
                    </div>
                  ) : (
                    <span className="text-gray-400 italic">Unassigned</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                  {getPackageDisplayName(esim)}
                </td>
                <td className="whitespace-nowrap px-6 py-4">
                  <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                    esim.deliveryStatus === 'SENT' 
                      ? 'bg-green-100 text-green-800' 
                      : 'bg-gray-100 text-gray-800'
                  }`}>
                    {esim.deliveryStatus}
                  </span>
                  {esim.deliveredAt && (
                    <div className="text-xs text-gray-500">
                      {new Date(esim.deliveredAt).toLocaleDateString()}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-6 py-4">
                  <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                    esim.status === 'ACTIVE' ? 'bg-green-100 text-green-800' :
                    esim.status === 'PENDING_ACTIVATION' ? 'bg-yellow-100 text-yellow-800' :
                    esim.status === 'PENDING' ? 'bg-yellow-100 text-yellow-800' :
                    esim.status === 'EXPIRED' ? 'bg-red-100 text-red-800' :
                    esim.status === 'SUSPENDED' ? 'bg-orange-100 text-orange-800' :
                    esim.status === 'FAILED' ? 'bg-red-100 text-red-800' :
                    'bg-gray-100 text-gray-800'
                  }`}>
                    {esim.status === 'PENDING_ACTIVATION' ? 'Ready to install' :
                     esim.status === 'ACTIVE' ? 'Activated on device' :
                     esim.status === 'EXPIRED' ? 'Expired' :
                     esim.status === 'SUSPENDED' ? 'Suspended' :
                     esim.status === 'FAILED' ? 'Provisioning failed' :
                     esim.status}
                  </span>
                </td>
                <td className="whitespace-nowrap px-6 py-4">
                  {esim.providerStatus ? (
                    <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                      esim.providerStatus === 'ACTIVE' ? 'bg-green-100 text-green-800' :
                      esim.providerStatus === 'PENDING' ? 'bg-yellow-100 text-yellow-800' :
                      esim.providerStatus === 'FAILED' ? 'bg-red-100 text-red-800' :
                      'bg-gray-100 text-gray-800'
                    }`}>
                      {esim.providerStatus}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">N/A</span>
                  )}
                  {esim.providerActivationId && (
                    <div className="text-xs text-gray-400 mt-1 font-mono">
                      {esim.providerActivationId.slice(-12)}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                  {esim.activatedAt 
                    ? new Date(esim.activatedAt).toLocaleDateString()
                    : 'Not activated'
                  }
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                  {esim.expiresAt 
                    ? new Date(esim.expiresAt).toLocaleDateString()
                    : 'N/A'
                  }
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm">
                  <Link href={`/admin/esims/${esim.id}`} className="text-cyan-600 hover:text-cyan-800 font-medium mr-3">
                    View SIM
                  </Link>
                  {esim.providerActivationId && (
                    <SyncButton esimId={esim.id} providerActivationId={esim.providerActivationId} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
