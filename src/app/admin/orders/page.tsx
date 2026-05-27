import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

export default async function AdminOrdersPage() {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }

  const purchases = await prisma.eSIMPurchase.findMany({
    include: {
      business: true,
      package: true,
      user: true,
      esims: {
        take: 1,
        orderBy: { createdAt: 'desc' },
        select: { providerActivationId: true, providerStatus: true },
      },
      _count: {
        select: { esims: true }
      }
    },
    orderBy: { createdAt: 'desc' }
  })

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Order Management</h2>
        <p className="text-gray-600">View and manage all eSIM purchases</p>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Order ID
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Business
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Package
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Qty
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Total
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Provider
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Date
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {purchases.map((purchase) => {
              const providerActivationId = purchase.esims[0]?.providerActivationId
              const providerStatus = purchase.providerStatus || purchase.esims[0]?.providerStatus
              return (
                <tr key={purchase.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900">
                    #{purchase.id.slice(-8)}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4">
                    <div className="text-sm font-medium text-gray-900">{purchase.business.name}</div>
                    <div className="text-sm text-gray-500">{purchase.user.name}</div>
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-900">
                    {purchase.package.name}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-900">
                    {purchase.quantity} ({purchase._count.esims} eSIMs)
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900">
                    ${purchase.totalAmount.toFixed(2)}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4">
                    <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                      purchase.status === 'COMPLETED' 
                        ? 'bg-green-100 text-green-800' 
                        : purchase.status === 'PENDING' || purchase.status === 'PENDING_ACTIVATION'
                        ? 'bg-yellow-100 text-yellow-800'
                        : purchase.status === 'FAILED'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-gray-100 text-gray-800'
                    }`}>
                      {purchase.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-6 py-4">
                    {providerStatus ? (
                      <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                        providerStatus === 'ACTIVE' || providerStatus === 'ACTIVATED'
                          ? 'bg-green-100 text-green-800'
                          : providerStatus === 'PENDING'
                          ? 'bg-yellow-100 text-yellow-800'
                          : providerStatus === 'FAILED'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}>
                        {providerStatus}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">N/A</span>
                    )}
                    {providerActivationId && (
                      <div className="text-xs text-gray-400 mt-1 font-mono">
                        {providerActivationId.slice(-12)}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                    {new Date(purchase.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              )}
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
