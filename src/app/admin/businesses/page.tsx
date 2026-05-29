import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { updateBusinessStatus } from '@/lib/actions/business'

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    APPROVED: 'bg-emerald-50 text-emerald-600',
    PENDING: 'bg-amber-50 text-amber-600',
    SUSPENDED: 'bg-red-50 text-red-600',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[status] || 'bg-gray-50 text-gray-500'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${
        status === 'APPROVED' ? 'bg-emerald-400' :
        status === 'PENDING' ? 'bg-amber-400' : 'bg-red-400'
      }`} />
      {status}
    </span>
  )
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
    </div>
  )
}

export default async function AdminBusinessesPage({
  searchParams
}: {
  searchParams: { error?: string; success?: string; q?: string; status?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const q = searchParams?.q?.trim()
  const statusFilter = searchParams?.status

  const where: any = {}

  if (statusFilter && ['APPROVED', 'PENDING', 'SUSPENDED'].includes(statusFilter)) {
    where.status = statusFilter
  }

  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { contactEmail: { contains: q, mode: 'insensitive' } },
      { id: { contains: q, mode: 'insensitive' } },
      { users: { some: { user: { email: { contains: q, mode: 'insensitive' } } } } },
    ]
  }

  const [businesses, totalCount, approvedCount, pendingCount, suspendedCount, walletAgg] = await Promise.all([
    prisma.business.findMany({
      where,
      include: {
        users: { include: { user: true } },
        _count: { select: { purchases: true, users: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.business.count(),
    prisma.business.count({ where: { status: 'APPROVED' } }),
    prisma.business.count({ where: { status: 'PENDING' } }),
    prisma.business.count({ where: { status: 'SUSPENDED' } }),
    prisma.business.aggregate({ _sum: { walletBalance: true } }),
  ])

  const totalWallet = walletAgg._sum.walletBalance
    ? parseFloat(walletAgg._sum.walletBalance.toString()).toFixed(2)
    : '0.00'

  const hasFilters = !!q || !!statusFilter

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Businesses</h2>
          <p className="mt-1 text-sm text-gray-500">Manage registered businesses</p>
        </div>
        <Link href="/admin/businesses/new" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
          Add Business
        </Link>
      </div>

      {/* Stats row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total" value={String(totalCount)} color="text-gray-900" />
        <StatCard label="Approved" value={String(approvedCount)} color="text-emerald-600" />
        <StatCard label="Pending" value={String(pendingCount)} color="text-amber-600" />
        <StatCard label="Suspended" value={String(suspendedCount)} color="text-red-600" />
        <StatCard label="Wallet Total" value={`$${totalWallet}`} color="text-blue-600" />
      </div>

      {/* Search & Filter */}
      <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
        <form method="GET" action="/admin/businesses" className="flex flex-wrap gap-3 items-end">
          <div className="min-w-[280px] flex-1">
            <label htmlFor="q" className="block text-xs font-medium text-gray-500 mb-1">Search</label>
            <input
              id="q"
              name="q"
              type="text"
              defaultValue={q || ''}
              placeholder="Search by name, email, or ID..."
              className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label htmlFor="status" className="block text-xs font-medium text-gray-500 mb-1">Status</label>
            <select
              id="status"
              name="status"
              defaultValue={statusFilter || ''}
              className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              <option value="">All Statuses</option>
              <option value="APPROVED">Approved</option>
              <option value="PENDING">Pending</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>
          <button type="submit" className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
            Search
          </button>
          {hasFilters && (
            <Link href="/admin/businesses" className="rounded-lg border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">
              Clear
            </Link>
          )}
        </form>
      </div>

      {/* Messages */}
      {searchParams.success && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">
          {searchParams.success === 'business_created' && 'Business account created successfully.'}
          {searchParams.success === 'business_created_invited' && 'Business created. Invite email sent.'}
          {searchParams.success === 'status_updated' && 'Business status updated successfully.'}
          {searchParams.success === 'invite_resent' && 'Invite email resent successfully.'}
        </div>
      )}
      {searchParams.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {searchParams.error === 'status_update_failed' && 'Failed to update business status.'}
        </div>
      )}

      {/* Results count */}
      <p className="text-sm text-gray-500">
        {hasFilters ? `${businesses.length} result${businesses.length !== 1 ? 's' : ''} found` : `${businesses.length} business${businesses.length !== 1 ? 'es' : ''}`}
      </p>

      {/* Table */}
      {businesses.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No businesses found.</p>
          {hasFilters && <Link href="/admin/businesses" className="mt-3 inline-block text-sm font-medium text-emerald-600 hover:text-emerald-700">Clear filters →</Link>}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Company</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Contact</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Users</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Orders</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Wallet</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {businesses.map((business) => (
                  <tr key={business.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="whitespace-nowrap px-5 py-4">
                      <div className="text-sm font-medium text-gray-900">{business.name}</div>
                      <div className="text-xs text-gray-400">{business.country}</div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <div className="text-sm text-gray-700">{business.users[0]?.user.name || '—'}</div>
                      <div className="text-xs text-gray-400">{business.contactEmail}</div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <StatusBadge status={business.status} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-gray-700">{business._count.users}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-gray-700">{business._count.purchases}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm font-medium text-gray-900">${business.walletBalance.toFixed(2)}</td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <div className="flex flex-wrap gap-1.5">
                        <Link href={`/admin/businesses/${business.id}`} className="rounded-md bg-gray-50 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100">
                          View
                        </Link>
                        <Link href={`/admin/businesses/${business.id}/edit`} className="rounded-md bg-gray-50 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100">
                          Edit
                        </Link>
                        <Link href={`/admin/businesses/${business.id}/wallet/credit`} className="rounded-md bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-600 hover:bg-emerald-100">
                          Credit
                        </Link>
                        <Link href={`/admin/businesses/${business.id}/wallet/debit`} className="rounded-md bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-600 hover:bg-amber-100">
                          Debit
                        </Link>
                        {business.status === 'PENDING' && (
                          <form action={updateBusinessStatus.bind(null, business.id, 'APPROVED')} className="inline">
                            <button type="submit" className="rounded-md bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-600 hover:bg-emerald-100">
                              Approve
                            </button>
                          </form>
                        )}
                        {business.status === 'APPROVED' && (
                          <form action={updateBusinessStatus.bind(null, business.id, 'SUSPENDED')} className="inline">
                            <button type="submit" className="rounded-md bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">
                              Suspend
                            </button>
                          </form>
                        )}
                        {business.status === 'SUSPENDED' && (
                          <form action={updateBusinessStatus.bind(null, business.id, 'APPROVED')} className="inline">
                            <button type="submit" className="rounded-md bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-600 hover:bg-emerald-100">
                              Reactivate
                            </button>
                          </form>
                        )}
                      </div>
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
