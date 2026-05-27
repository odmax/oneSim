import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { assignESIM, sendToCustomer } from '@/lib/actions/esim'
import CopyButton from '@/components/CopyButton'

export default async function CustomerDetailPage({
  params,
  searchParams
}: {
  params: { id: string }
  searchParams: { success?: string; error?: string }
}) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  // Get business ID for current user
  const businessUser = await prisma.businessUser.findFirst({
    where: { userId: session.user.id },
    select: { businessId: true, role: true }
  })

  if (!businessUser) {
    redirect('/login')
  }

  const isAdmin = businessUser.role === 'ADMIN'

  const customer = await prisma.customer.findFirst({
    where: { 
      id: params.id,
      businessId: businessUser.businessId
    },
    include: {
      esims: {
        include: {
          purchase: {
            include: {
              package: true
            }
          },
          usageRecords: true
        }
      }
    }
  })

  if (!customer) {
    redirect('/business/customers')
  }

  // Get unassigned eSIMs for this business (for assignment)
  const unassignedESIMs = isAdmin ? await prisma.eSIM.findMany({
    where: {
      customerId: null,
      purchase: {
        businessId: businessUser.businessId
      }
    },
    include: {
      purchase: {
        include: {
          package: true
        }
      }
    },
    take: 50
  }) : []

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{customer.name}</h2>
          <p className="text-gray-600">End Customer Details</p>
        </div>
        <Link
          href="/business/customers"
          className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
        >
          Back to Customers
        </Link>
      </div>

      {searchParams.success && (
        <div className="mb-6 rounded-lg bg-green-50 p-4">
          <p className="text-sm text-green-800">
            {searchParams.success === 'assigned' && 'eSIM assigned successfully'}
            {searchParams.success === 'sent' && 'Activation details sent to customer'}
          </p>
        </div>
      )}

      {searchParams.error && (
        <div className="mb-6 rounded-lg bg-red-50 p-4">
          <p className="text-sm text-red-800">
            {searchParams.error === 'assignment_failed' && 'Failed to assign eSIM. Please try again.'}
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Customer Info */}
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Customer Information</h3>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm font-medium text-gray-500">Email</dt>
              <dd className="text-sm text-gray-900">{customer.email}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Phone</dt>
              <dd className="text-sm text-gray-900">{customer.phone || 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Country</dt>
              <dd className="text-sm text-gray-900">{customer.country}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Status</dt>
              <dd>
                <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                  customer.status === 'ACTIVE' 
                    ? 'bg-green-100 text-green-800' 
                    : 'bg-red-100 text-red-800'
                }`}>
                  {customer.status}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Customer Since</dt>
              <dd className="text-sm text-gray-900">
                {new Date(customer.createdAt).toLocaleDateString()}
              </dd>
            </div>
          </dl>
        </div>

        {/* Assigned eSIMs */}
        <div className="lg:col-span-2">
          {/* Usage Summary */}
          <div className="mb-6 grid gap-4 md:grid-cols-3">
            <div className="rounded-lg border bg-white p-4 shadow-sm">
              <p className="text-sm text-gray-500">Total eSIMs</p>
              <p className="text-2xl font-bold text-gray-900">{customer.esims.length}</p>
            </div>
            <div className="rounded-lg border bg-white p-4 shadow-sm">
              <p className="text-sm text-gray-500">Total Data Used</p>
              <p className="text-2xl font-bold text-cyan-600">
                {(customer.esims.reduce((sum, esim) => 
                  sum + esim.usageRecords.reduce((s, r) => s + r.dataUsedMB, 0), 0) / 1024).toFixed(2)} GB
              </p>
            </div>
            <div className="rounded-lg border bg-white p-4 shadow-sm">
              <p className="text-sm text-gray-500">Total Data Available</p>
              <p className="text-2xl font-bold text-green-600">
                {customer.esims.reduce((sum, esim) => 
                  sum + esim.purchase.package.dataGB, 0)} GB
              </p>
            </div>
          </div>

          <div className="rounded-lg border bg-white shadow-sm">
            <div className="border-b px-6 py-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Assigned eSIMs & Usage History</h3>
              {isAdmin && unassignedESIMs.length > 0 && (
                <span className="text-sm text-gray-500">{unassignedESIMs.length} available to assign</span>
              )}
            </div>
            <div className="p-6">
              {customer.esims.length === 0 ? (
                <p className="text-center text-sm text-gray-500">No eSIMs assigned yet.</p>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="pb-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">ICCID</th>
                      <th className="pb-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Package</th>
                      <th className="pb-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Delivery Status</th>
                      <th className="pb-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                      <th className="pb-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Usage</th>
                      {isAdmin && <th className="pb-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {customer.esims.map((esim) => {
                      const totalUsage = esim.usageRecords.reduce((sum, r) => sum + r.dataUsedMB, 0)
                      const usagePercentage = ((totalUsage / 1024) / esim.purchase.package.dataGB) * 100
                      return (
                        <tr key={esim.id} className="hover:bg-gray-50">
                          <td className="whitespace-nowrap py-3 text-sm text-gray-900">
                            <div className="font-mono text-xs">{esim.iccid}</div>
                            <CopyButton text={esim.iccid} label="Copy ICCID" />
                          </td>
                          <td className="whitespace-nowrap py-3 text-sm text-gray-900">
                            {esim.purchase.package.name}
                          </td>
                          <td className="whitespace-nowrap py-3">
                            <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                              esim.deliveryStatus === 'SENT' 
                                ? 'bg-green-100 text-green-800' 
                                : 'bg-gray-100 text-gray-800'
                            }`}>
                              {esim.deliveryStatus}
                            </span>
                          </td>
                          <td className="whitespace-nowrap py-3">
                            <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                              esim.status === 'ACTIVE' ? 'bg-green-100 text-green-800' :
                              esim.status === 'PENDING' ? 'bg-yellow-100 text-yellow-800' :
                              'bg-red-100 text-red-800'
                            }`}>
                              {esim.status}
                            </span>
                          </td>
                          <td className="py-3">
                            <div className="text-sm text-gray-900">
                              {(totalUsage / 1024).toFixed(2)} / {esim.purchase.package.dataGB} GB
                            </div>
                            <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-gray-200">
                              <div 
                                className="h-full rounded-full bg-cyan-600" 
                                style={{ width: `${Math.min(usagePercentage, 100)}%` }}
                              />
                            </div>
                          </td>
                          {isAdmin && (
                            <td className="whitespace-nowrap py-3 text-sm">
                              <div className="flex flex-col gap-1">
                                {esim.qrCodeUrl && (
                                  <a
                                    href={esim.qrCodeUrl}
                                    target="_blank"
                                    className="text-xs text-cyan-600 hover:text-cyan-900"
                                  >
                                    View QR Code
                                  </a>
                                )}
                                {esim.deliveryStatus === 'NOT_SENT' ? (
                                  <form action={sendToCustomer}>
                                    <input type="hidden" name="esimId" value={esim.id} />
                                    <input type="hidden" name="redirectTo" value={`/business/customers/${customer.id}`} />
                                    <button type="submit" className="text-xs text-green-600 hover:text-green-900">
                                      Send to Customer
                                    </button>
                                  </form>
                                ) : (
                                  <span className="text-xs text-gray-400">
                                    Sent {esim.deliveredAt ? new Date(esim.deliveredAt).toLocaleDateString() : ''}
                                  </span>
                                )}
                              </div>
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Assign eSIM Section (Admin Only) */}
          {isAdmin && unassignedESIMs.length > 0 && (
            <div className="mt-6 rounded-lg border bg-white p-6 shadow-sm">
              <h3 className="mb-4 text-lg font-semibold text-gray-900">Assign eSIM to this Customer</h3>
              <form action={assignESIM} className="space-y-4">
                <input type="hidden" name="customerId" value={customer.id} />
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Select eSIM to Assign
                  </label>
                  <select name="esimId" required className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-cyan-500 focus:outline-none">
                    <option value="">Choose an unassigned eSIM...</option>
                    {unassignedESIMs.map((esim) => (
                      <option key={esim.id} value={esim.id}>
                        {esim.iccid.slice(0, 19)}... - {esim.purchase.package.name} ({esim.purchase.package.dataGB}GB)
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="submit"
                  className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
                >
                  Assign eSIM
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
