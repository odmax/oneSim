import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

function TxTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    PURCHASE: 'bg-blue-50 text-blue-600',
    TOPUP: 'bg-emerald-50 text-emerald-600',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[type] || 'bg-gray-50 text-gray-500'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${type === 'TOPUP' ? 'bg-emerald-400' : 'bg-blue-400'}`} />
      {type}
    </span>
  )
}

function TopUpStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    PENDING: 'bg-amber-50 text-amber-600',
    APPROVED: 'bg-emerald-50 text-emerald-600',
    REJECTED: 'bg-red-50 text-red-600',
    CANCELLED: 'bg-gray-50 text-gray-500',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[status] || 'bg-gray-50 text-gray-500'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${
        status === 'APPROVED' ? 'bg-emerald-400' :
        status === 'REJECTED' ? 'bg-red-400' :
        status === 'PENDING' ? 'bg-amber-400' : 'bg-gray-400'
      }`} />
      {status}
    </span>
  )
}

export default async function WalletPage({
  searchParams
}: {
  searchParams: { error?: string; success?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const business = await prisma.business.findUnique({
    where: { id: session.user.businessId! },
    include: {
      transactions: { orderBy: { createdAt: 'desc' }, take: 50 },
      topUpRequests: { orderBy: { createdAt: 'desc' }, take: 20 },
    }
  })

  if (!business) redirect('/login')

  const totalSpent = business.transactions
    .filter(tx => parseFloat(tx.amount.toString()) < 0)
    .reduce((sum, tx) => sum + Math.abs(parseFloat(tx.amount.toString())), 0)

  const pendingTopUps = business.topUpRequests.filter(r => r.status === 'PENDING')
  const completedTopUps = business.topUpRequests.filter(r => r.status === 'APPROVED')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Wallet</h2>
          <p className="mt-1 text-sm text-gray-500">Manage your wallet balance and transactions</p>
        </div>
        <Link href="/business/wallet/top-up">
          <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
            Top Up Wallet
          </button>
        </Link>
      </div>

      {searchParams?.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {searchParams.error === 'invalid_amount' && 'Invalid amount. Please enter a valid positive number.'}
          {searchParams.error === 'topup_failed' && 'Top-up failed. Please try again.'}
        </div>
      )}
      {searchParams?.success && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">
          {searchParams.success === 'topup' && 'Wallet topped up successfully!'}
        </div>
      )}

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-5 shadow-sm">
          <p className="text-xs font-medium text-emerald-600 uppercase tracking-wider">Current Balance</p>
          <p className="mt-2 text-3xl font-bold text-gray-900">${business.walletBalance.toFixed(2)}</p>
        </div>
        <div className="rounded-xl border border-red-100 bg-gradient-to-br from-red-50 to-white p-5 shadow-sm">
          <p className="text-xs font-medium text-red-600 uppercase tracking-wider">Total Spent</p>
          <p className="mt-2 text-3xl font-bold text-gray-900">${totalSpent.toFixed(2)}</p>
        </div>
        <div className="rounded-xl border border-amber-100 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm">
          <p className="text-xs font-medium text-amber-600 uppercase tracking-wider">Pending Top-Ups</p>
          <p className="mt-2 text-3xl font-bold text-gray-900">{pendingTopUps.length}</p>
        </div>
      </div>

      {/* Pending top-ups */}
      {pendingTopUps.length > 0 && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-800">
            {pendingTopUps.length} top-up request{pendingTopUps.length > 1 ? 's' : ''} pending admin confirmation.
          </p>
        </div>
      )}

      {/* Top-up history */}
      {business.topUpRequests.length > 0 && (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-gray-50 px-5 py-4">
            <h3 className="text-base font-semibold text-gray-900">Top-Up History</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Date</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Reference</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Amount</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {business.topUpRequests.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-5 py-4 text-sm text-gray-500">{new Date(r.createdAt).toLocaleDateString()}</td>
                    <td className="px-5 py-4 text-sm font-mono text-gray-700">{r.paymentReference}</td>
                    <td className="px-5 py-4 text-sm font-medium text-gray-900">${r.amount.toString()}</td>
                    <td className="px-5 py-4"><TopUpStatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Transaction history */}
      <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-gray-50 px-5 py-4">
          <h3 className="text-base font-semibold text-gray-900">Transaction History</h3>
        </div>
        {business.transactions.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Date</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Type</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Amount</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {business.transactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-gray-500">
                      {new Date(tx.createdAt).toLocaleDateString()}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <TxTypeBadge type={tx.type} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm font-medium">
                      <span className={parseFloat(tx.amount.toString()) > 0 ? 'text-emerald-600' : 'text-red-600'}>
                        {parseFloat(tx.amount.toString()) > 0 ? '+' : '-'}${Math.abs(parseFloat(tx.amount.toString())).toFixed(2)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-gray-500">{tx.description || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-10 text-center">
            <p className="text-gray-500">No transactions yet</p>
          </div>
        )}
      </div>
    </div>
  )
}
