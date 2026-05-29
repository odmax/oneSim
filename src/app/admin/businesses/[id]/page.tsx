import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { updateBusinessStatus } from '@/lib/actions/business'
import { sendPasswordSetupEmail } from '@/lib/actions/auth-setup'
import WalletActions from './wallet-actions'
import ConfirmForm from './confirm-form'

export default async function BusinessDetailPage({ 
  params,
  searchParams
}: { 
  params: { id: string }
  searchParams: { success?: string; error?: string }
}) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }

  const business = await prisma.business.findUnique({
    where: { id: params.id },
    include: {
      users: {
        include: {
          user: true
        }
      },
      purchases: {
        include: {
          package: true,
          esims: true
        },
        orderBy: { createdAt: 'desc' },
        take: 10
      },
      transactions: {
        orderBy: { createdAt: 'desc' },
        take: 20
      },
      topUpRequests: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { requestedBy: { select: { name: true, email: true } } },
      },
      customers: {
        take: 10,
        orderBy: { createdAt: 'desc' }
      },
      _count: {
        select: {
          purchases: true,
          users: true,
          customers: true,
          transactions: true
        }
      }
    }
  })

  if (!business) {
    redirect('/admin/businesses')
  }

  return (
    <div className="space-y-6 p-6">
      {searchParams.success && (
        <div className="rounded-lg bg-green-50 p-4 border border-green-200">
          <p className="text-sm text-green-800">
            {searchParams.success === 'updated' && 'Business updated successfully.'}
            {searchParams.success === 'wallet_credited' && 'Business wallet credited successfully.'}
            {searchParams.success === 'wallet_debited' && 'Business wallet debited successfully.'}
          </p>
        </div>
      )}

      {searchParams.error && (
        <div className="rounded-lg bg-red-50 p-4 border border-red-200">
          <p className="text-sm text-red-800">
            {searchParams.error === 'invalid_amount' && 'Please enter a valid amount.'}
            {searchParams.error === 'missing_reason' && 'Reason/notes are required.'}
            {searchParams.error === 'insufficient_balance' && 'Insufficient wallet balance.'}
            {searchParams.error === 'wallet_action_failed' && 'Wallet action failed. Please try again.'}
          </p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <Link href="/admin/businesses" className="text-sm text-blue-600 hover:underline">
            ← Back to Businesses
          </Link>
          <h2 className="mt-2 text-2xl font-bold text-gray-900">{business.name}</h2>
          <p className="text-gray-600">{business.country}</p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/admin/businesses/${business.id}/edit`}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Edit
          </Link>
          {business.status === 'PENDING' && (
            <form action={updateBusinessStatus.bind(null, business.id, 'APPROVED')}>
              <button
                type="submit"
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
              >
                Approve
              </button>
            </form>
          )}
          {business.status === 'APPROVED' && (
            <ConfirmForm
              action={updateBusinessStatus.bind(null, business.id, 'SUSPENDED')}
              message="Are you sure you want to suspend this business?"
            >
              <button
                type="submit"
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Suspend
              </button>
            </ConfirmForm>
          )}
          {business.status === 'SUSPENDED' && (
            <form action={updateBusinessStatus.bind(null, business.id, 'APPROVED')}>
              <button
                type="submit"
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
              >
                Reactivate
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-semibold">Business Info</h3>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-gray-600">Status</dt>
              <dd>
                <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                  business.status === 'APPROVED' 
                    ? 'bg-green-100 text-green-800' 
                    : business.status === 'PENDING'
                    ? 'bg-yellow-100 text-yellow-800'
                    : 'bg-red-100 text-red-800'
                }`}>
                  {business.status}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-gray-600">Contact Email</dt>
              <dd className="text-sm font-medium text-gray-900">{business.contactEmail}</dd>
            </div>
            {business.contactPhone && (
              <div>
                <dt className="text-sm text-gray-600">Contact Phone</dt>
                <dd className="text-sm font-medium text-gray-900">{business.contactPhone}</dd>
              </div>
            )}
            {business.regNumber && (
              <div>
                <dt className="text-sm text-gray-600">Registration Number</dt>
                <dd className="text-sm font-medium text-gray-900">{business.regNumber}</dd>
              </div>
            )}
            {business.taxId && (
              <div>
                <dt className="text-sm text-gray-600">Tax ID</dt>
                <dd className="text-sm font-medium text-gray-900">{business.taxId}</dd>
              </div>
            )}
            {business.address && (
              <div>
                <dt className="text-sm text-gray-600">Address</dt>
                <dd className="text-sm font-medium text-gray-900">{business.address}</dd>
              </div>
            )}
            <div className="border-t pt-3">
              <dt className="text-sm text-gray-600">Wallet Balance</dt>
              <dd className="text-lg font-bold text-gray-900">${business.walletBalance.toFixed(2)}</dd>
            </div>
          </dl>
          <div className="mt-4">
            <WalletActions businessId={business.id} walletBalance={Number(business.walletBalance)} />
          </div>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <div className="rounded-lg border bg-white p-6 shadow-sm">
            <h3 className="mb-4 text-lg font-semibold">Team Members ({business._count.users})</h3>
            <div className="divide-y">
              {business.users.map((bu) => {
                const isInvited = !bu.user.passwordHash
                return (
                <div key={bu.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-medium text-gray-900">{bu.user.name}</p>
                    <p className="text-sm text-gray-600">{bu.user.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                      bu.role === 'ADMIN' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'
                    }`}>
                      {bu.role}
                    </span>
                    {isInvited ? (
                      <>
                        <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-600">Invited</span>
                        <form action={sendPasswordSetupEmail.bind(null, bu.user.id, bu.user.email, bu.user.name || '')}>
                          <button type="submit" className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-600 hover:bg-amber-100">Resend</button>
                        </form>
                      </>
                    ) : (
                      <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-600">Active</span>
                    )}
                  </div>
                </div>
              )})}
            </div>
          </div>

          <div className="rounded-lg border bg-white p-6 shadow-sm">
            <h3 className="mb-4 text-lg font-semibold">
              Customers ({business._count.customers})
            </h3>
            {business.customers.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-xs font-medium text-gray-500">
                    <th className="pb-2">Name</th>
                    <th className="pb-2">Email</th>
                    <th className="pb-2">Phone</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {business.customers.map((customer) => (
                    <tr key={customer.id}>
                      <td className="py-3 text-sm text-gray-900">{customer.name}</td>
                      <td className="py-3 text-sm text-gray-600">{customer.email || '-'}</td>
                      <td className="py-3 text-sm text-gray-600">{customer.phone || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-gray-500">No customers yet.</p>
            )}
          </div>

          <div className="rounded-lg border bg-white p-6 shadow-sm">
            <h3 className="mb-4 text-lg font-semibold">
              Recent Purchases ({business._count.purchases})
            </h3>
            {business.purchases.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-xs font-medium text-gray-500">
                    <th className="pb-2">Package</th>
                    <th className="pb-2">Qty</th>
                    <th className="pb-2">Total</th>
                    <th className="pb-2">eSIMs</th>
                    <th className="pb-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {business.purchases.map((purchase) => (
                    <tr key={purchase.id}>
                      <td className="py-3 text-sm text-gray-900">{purchase.package.name}</td>
                      <td className="py-3 text-sm text-gray-600">{purchase.quantity}</td>
                      <td className="py-3 text-sm font-medium text-gray-900">${Number(purchase.totalAmount).toFixed(2)}</td>
                      <td className="py-3 text-sm text-gray-600">{purchase.esims.length}</td>
                      <td className="py-3">
                        <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                          purchase.status === 'COMPLETED' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                        }`}>
                          {purchase.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-gray-500">No purchases yet.</p>
            )}
          </div>

          <div className="rounded-lg border bg-white p-6 shadow-sm">
            <h3 className="mb-4 text-lg font-semibold">
              Wallet Top-Up Requests
              <Link href={`/admin/wallet-topups?state=PENDING`} className="ml-2 text-sm font-normal text-emerald-600 hover:text-emerald-700">View all →</Link>
            </h3>
            {business.topUpRequests.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs font-medium text-gray-500">
                    <th className="pb-2">Reference</th>
                    <th className="pb-2">Amount</th>
                    <th className="pb-2">Status</th>
                    <th className="pb-2">Requested By</th>
                    <th className="pb-2">Date</th>
                    <th className="pb-2">Approved</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {business.topUpRequests.map((r: any) => (
                    <tr key={r.id}>
                      <td className="py-3 text-sm font-mono text-gray-700">{r.paymentReference}</td>
                      <td className="py-3 text-sm font-semibold text-gray-900">${r.amount.toString()}</td>
                      <td className="py-3">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          r.status === 'APPROVED' ? 'bg-emerald-50 text-emerald-600' :
                          r.status === 'REJECTED' ? 'bg-red-50 text-red-600' :
                          'bg-amber-50 text-amber-600'
                        }`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="py-3 text-sm text-gray-600">{r.requestedBy?.name || r.requestedBy?.email || '—'}</td>
                      <td className="py-3 text-sm text-gray-500">{new Date(r.createdAt).toLocaleDateString()}</td>
                      <td className="py-3 text-sm text-gray-500">{r.approvedAt ? new Date(r.approvedAt).toLocaleDateString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-gray-500">No top-up requests yet.</p>
            )}
          </div>

          <div className="rounded-lg border bg-white p-6 shadow-sm">
            <h3 className="mb-4 text-lg font-semibold">
              Wallet Transactions ({business._count.transactions})
            </h3>
            {business.transactions.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-xs font-medium text-gray-500">
                    <th className="pb-2">Date</th>
                    <th className="pb-2">Type</th>
                    <th className="pb-2">Amount</th>
                    <th className="pb-2">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {business.transactions.map((tx) => (
                    <tr key={tx.id}>
                      <td className="py-3 text-sm text-gray-600">
                        {tx.createdAt.toLocaleDateString()}
                      </td>
                      <td className="py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          tx.type === 'CREDIT' || tx.type === 'TOP_UP'
                            ? 'bg-green-100 text-green-800'
                            : tx.type === 'DEBIT'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}>
                          {tx.type}
                        </span>
                      </td>
                      <td className={`py-3 text-sm font-medium ${
                        Number(tx.amount) >= 0 ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {Number(tx.amount) >= 0 ? '+' : ''}${Number(tx.amount).toFixed(2)}
                      </td>
                      <td className="py-3 text-sm text-gray-600">{tx.description || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-gray-500">No transactions yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
