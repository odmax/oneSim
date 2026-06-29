import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

const STATUS_COLORS: Record<string, string> = {
  CREATED: 'bg-gray-100 text-gray-700', PAYMENT_RESERVED: 'bg-blue-100 text-blue-700',
  PENDING_PROVIDER: 'bg-amber-100 text-amber-700', PROVIDER_ACCEPTED: 'bg-cyan-100 text-cyan-700',
  RESERVED: 'bg-purple-100 text-purple-700', FULFILLING: 'bg-indigo-100 text-indigo-700',
  FULFILLED: 'bg-emerald-100 text-emerald-700', INSTALLING: 'bg-sky-100 text-sky-700',
  INSTALLED: 'bg-teal-100 text-teal-700', ACTIVE: 'bg-green-100 text-green-700',
  EXPIRED: 'bg-gray-100 text-gray-700', CANCELLED: 'bg-amber-100 text-amber-700',
  FAILED: 'bg-red-100 text-red-700', REFUNDED: 'bg-rose-100 text-rose-700',
}

function WalletBadge({ orderId, status }: { orderId: string; status: string }) {
  if (['CANCELLED', 'REFUNDED'].includes(status)) return <span className="text-[10px] text-gray-400">Released</span>
  if (status === 'FAILED') return <span className="text-[10px] text-red-500">Released</span>
  if (status === 'CREATED') return <span className="text-[10px] text-gray-400">Not reserved</span>
  if (['PAYMENT_RESERVED', 'PENDING_PROVIDER'].includes(status)) return <span className="text-[10px] text-amber-600">Reserved</span>
  if (['FULFILLED', 'ACTIVE', 'INSTALLING', 'INSTALLED'].includes(status)) return <span className="text-[10px] text-emerald-600">Captured</span>
  return <span className="text-[10px] text-gray-400">—</span>
}

function RetryableBadge({ status, retryCount, maxRetries }: { status: string; retryCount: number; maxRetries: number }) {
  if (status !== 'FAILED') return null
  if (retryCount >= maxRetries) return <span className="text-[10px] text-red-500">Exhausted</span>
  return <span className="text-[10px] text-amber-600">{maxRetries - retryCount} left</span>
}

export default async function AdminOrdersPage({ searchParams }: { searchParams?: { status?: string; search?: string; retryable?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const where: any = {}
  if (searchParams?.status) where.status = searchParams.status
  if (searchParams?.retryable === '1') {
    where.status = 'FAILED'
    where.retryCount = { lt: 3 }
  }
  if (searchParams?.search) {
    where.OR = [
      { id: { contains: searchParams.search, mode: 'insensitive' } },
      { esims: { some: { iccid: { contains: searchParams.search, mode: 'insensitive' } } } },
      { user: { name: { contains: searchParams.search, mode: 'insensitive' } } },
      { business: { name: { contains: searchParams.search, mode: 'insensitive' } } },
    ]
  }

  const purchases = await prisma.eSIMPurchase.findMany({
    where,
    include: {
      business: { select: { name: true } },
      package: { select: { name: true } },
      user: { select: { name: true } },
      esims: { take: 1, orderBy: { createdAt: 'desc' }, select: { iccid: true, status: true } },
      provider: { select: { name: true, id: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Order Management</h2>
          <p className="text-gray-600">View and manage all eSIM purchases</p>
        </div>
        <div className="flex items-center gap-3">
          {searchParams?.retryable === '1' ? (
            <Link href="/admin/orders" className="text-xs text-gray-500 hover:text-gray-700">Clear filter</Link>
          ) : (
            <Link href="/admin/orders?retryable=1" className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50">Failed / Retryable</Link>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/admin/orders" className={`rounded-full px-3 py-1 text-xs font-medium ${!searchParams?.status ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>All</Link>
        {['PENDING_PROVIDER', 'FAILED', 'ACTIVE', 'CANCELLED', 'REFUNDED'].map(s => (
          <Link key={s} href={`/admin/orders?status=${s}`} className={`rounded-full px-3 py-1 text-xs font-medium ${searchParams?.status === s ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{s.replace('_', ' ')}</Link>
        ))}
      </div>

      <div className="mb-4">
        <form action="/admin/orders" method="GET">
          <input type="text" name="search" placeholder="Search by ICCID, order ID, customer, business..." defaultValue={searchParams?.search || ''}
            className="w-full max-w-md rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
        </form>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Order</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Business</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Package</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Amount</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Status</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Provider</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Wallet</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Retry</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">eSIM</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {purchases.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-gray-400">No orders found.</td></tr>
            ) : purchases.map(p => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="px-3 py-3">
                  <Link href={`/admin/orders/${p.id}`} className="font-mono text-xs text-cyan-600 hover:underline">#{p.id.slice(-8)}</Link>
                  {p.status === 'PENDING_PROVIDER' && <div className="text-[10px] text-amber-600 mt-0.5">In flight</div>}
                  {p.status === 'FAILED' && p.failureReason && (
                    <div className="text-[10px] text-red-500 mt-0.5 max-w-[120px] truncate" title={p.failureReason}>{p.failureReason}</div>
                  )}
                </td>
                <td className="px-3 py-3">
                  <div className="text-sm font-medium text-gray-900">{p.business.name}</div>
                  <div className="text-xs text-gray-500">{p.user.name}</div>
                </td>
                <td className="px-3 py-3 text-sm text-gray-900">{p.package.name}</td>
                <td className="px-3 py-3 text-sm font-medium text-gray-900">${Number(p.totalAmount).toFixed(2)}</td>
                <td className="px-3 py-3">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[p.status] || 'bg-gray-100 text-gray-700'}`}>{p.status}</span>
                  {p.providerErrorCode && (
                    <span className="block text-[10px] text-red-500 mt-0.5" title={p.providerErrorMessage || ''}>Error: {p.providerErrorCode}</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <div className="text-sm text-gray-600">{p.provider?.name || '—'}</div>
                  {p.provider?.id && (
                    <Link href={`/admin/providers/${p.provider.id}`} className="text-[10px] text-cyan-600 hover:underline">View provider</Link>
                  )}
                </td>
                <td className="px-3 py-3">
                  <WalletBadge orderId={p.id} status={p.status} />
                </td>
                <td className="px-3 py-3">
                  <div className="text-xs text-gray-500">{p.retryCount > 0 ? `${p.retryCount}/${p.maxRetries}` : '—'}</div>
                  <RetryableBadge status={p.status} retryCount={p.retryCount} maxRetries={p.maxRetries} />
                </td>
                <td className="px-3 py-3 text-xs text-gray-500">
                  {p.esims[0]?.iccid ? (
                    <><span className="font-mono">{p.esims[0].iccid.slice(-8)}</span><br /><span className="text-gray-400">{p.esims[0].status}</span></>
                  ) : '—'}
                </td>
                <td className="px-3 py-3 text-sm text-gray-500">{new Date(p.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
