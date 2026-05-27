import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { approveTopUpRequest, rejectTopUpRequest } from '@/lib/actions/wallet-topup'

function StatusBadge({ status }: { status: string }) {
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

export default async function AdminWalletTopupsPage({
  searchParams,
}: {
  searchParams?: { error?: string; success?: string; status?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const statusFilter = searchParams?.status
  const where: any = {}
  if (statusFilter && ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(statusFilter)) {
    where.status = statusFilter
  }

  const requests = await prisma.walletTopUpRequest.findMany({
    where,
    include: {
      business: { select: { id: true, name: true } },
      requestedBy: { select: { id: true, name: true, email: true } },
      approvedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Wallet Top-Ups</h2>
        <p className="mt-1 text-sm text-gray-500">Manage wallet top-up requests from businesses</p>
      </div>

      {searchParams?.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>
      )}
      {searchParams?.success && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">{decodeURIComponent(searchParams.success)}</div>
      )}

      {/* Status filter tabs */}
      <div className="flex gap-2">
        {['', 'PENDING', 'APPROVED', 'REJECTED'].map((s) => (
          <Link
            key={s}
            href={s ? `/admin/wallet-topups?status=${s}` : '/admin/wallet-topups'}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              (statusFilter || '') === s
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {s || 'All'}
          </Link>
        ))}
      </div>

      {requests.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No top-up requests found.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Business</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Requested By</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Reference</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Amount</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Date</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {requests.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-5 py-4">
                      <Link href={`/admin/businesses/${r.business.id}`} className="text-sm font-medium text-emerald-600 hover:text-emerald-700">
                        {r.business.name}
                      </Link>
                    </td>
                    <td className="px-5 py-4 text-sm text-gray-700">
                      {r.requestedBy.name || r.requestedBy.email}
                    </td>
                    <td className="px-5 py-4 text-sm font-mono text-gray-700">{r.paymentReference}</td>
                    <td className="px-5 py-4 text-sm font-semibold text-gray-900">${r.amount.toString()}</td>
                    <td className="px-5 py-4"><StatusBadge status={r.status} /></td>
                    <td className="px-5 py-4 text-sm text-gray-500">{new Date(r.createdAt).toLocaleDateString()}</td>
                    <td className="px-5 py-4">
                      {r.status === 'PENDING' ? (
                        <div className="flex gap-1.5">
                          <form action={approveTopUpRequest.bind(null, r.id)}>
                            <input type="hidden" name="adminNote" value="" />
                            <button type="submit" className="rounded bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-100">
                              Approve
                            </button>
                          </form>
                          <form action={rejectTopUpRequest.bind(null, r.id)}>
                            <input type="hidden" name="adminNote" value="" />
                            <button type="submit" className="rounded bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-100">
                              Reject
                            </button>
                          </form>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">
                          {r.approvedBy?.name ? `by ${r.approvedBy.name}` : '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
