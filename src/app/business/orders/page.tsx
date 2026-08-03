import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

const STATUS_CONFIG: Record<string, { label: string; dot: string; bg: string }> = {
  CREATED: { label: 'Created', dot: 'bg-gray-400', bg: 'bg-gray-50 text-gray-600' },
  PAYMENT_RESERVED: { label: 'Payment Reserved', dot: 'bg-blue-400', bg: 'bg-blue-50 text-blue-600' },
  PENDING_PROVIDER: { label: 'Activating', dot: 'bg-amber-400', bg: 'bg-amber-50 text-amber-600' },
  PROVIDER_ACCEPTED: { label: 'Activating', dot: 'bg-cyan-400', bg: 'bg-cyan-50 text-cyan-600' },
  RESERVED: { label: 'Reserved', dot: 'bg-purple-400', bg: 'bg-purple-50 text-purple-600' },
  FULFILLING: { label: 'Fulfilling', dot: 'bg-indigo-400', bg: 'bg-indigo-50 text-indigo-600' },
  FULFILLED: { label: 'Ready to Install', dot: 'bg-emerald-400', bg: 'bg-emerald-50 text-emerald-600' },
  INSTALLING: { label: 'Installing', dot: 'bg-sky-400', bg: 'bg-sky-50 text-sky-600' },
  INSTALLED: { label: 'Installed', dot: 'bg-teal-400', bg: 'bg-teal-50 text-teal-600' },
  ACTIVE: { label: 'Active', dot: 'bg-green-400', bg: 'bg-green-50 text-green-600' },
  EXPIRED: { label: 'Expired', dot: 'bg-gray-400', bg: 'bg-gray-50 text-gray-500' },
  CANCELLED: { label: 'Cancelled', dot: 'bg-amber-400', bg: 'bg-amber-50 text-amber-600' },
  FAILED: { label: 'Failed', dot: 'bg-red-400', bg: 'bg-red-50 text-red-600' },
  REFUNDED: { label: 'Refunded', dot: 'bg-rose-400', bg: 'bg-rose-50 text-rose-600' },
  PROVIDER_RECONCILIATION: { label: 'Reconciling', dot: 'bg-purple-400', bg: 'bg-purple-50 text-purple-700' },
  PARTIALLY_FULFILLED: { label: 'Partial', dot: 'bg-amber-400', bg: 'bg-amber-50 text-amber-700' },
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || { label: status, dot: 'bg-gray-400', bg: 'bg-gray-50 text-gray-500' }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.bg}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  )
}

export default async function OrdersPage({ searchParams }: { searchParams?: { status?: string; search?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const businessId = session.user.businessId!
  if (!businessId) redirect('/login')

  const where: any = { businessId }

  if (searchParams?.status) {
    where.status = searchParams.status
  }

  if (searchParams?.search) {
    where.OR = [
      { id: { contains: searchParams.search, mode: 'insensitive' } },
      { esims: { some: { iccid: { contains: searchParams.search, mode: 'insensitive' } } } },
      { user: { name: { contains: searchParams.search, mode: 'insensitive' } } },
      { package: { name: { contains: searchParams.search, mode: 'insensitive' } } },
      { package: { displayName: { contains: searchParams.search, mode: 'insensitive' } } },
    ]
  }

  const purchases = await prisma.eSIMPurchase.findMany({
    where,
    include: {
      package: { select: { id: true, name: true, displayName: true, dataGB: true, validityDays: true } },
      user: { select: { name: true, email: true } },
      esims: { select: { id: true, iccid: true, qrCodeUrl: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Orders</h2>
          <p className="mt-1 text-sm text-gray-500">View your purchase history</p>
        </div>
        <Link href="/business/buy-esim" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
          New Order
        </Link>
      </div>

      {/* Status filters */}
      <div className="flex flex-wrap gap-2">
        <Link href="/business/orders" className={`rounded-full px-3 py-1 text-xs font-medium ${!searchParams?.status ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>All</Link>
        {['PENDING_PROVIDER', 'FULFILLED', 'ACTIVE', 'FAILED', 'REFUNDED'].map(s => (
          <Link key={s} href={`/business/orders?status=${s}`}
            className={`rounded-full px-3 py-1 text-xs font-medium ${searchParams?.status === s ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {STATUS_CONFIG[s]?.label || s}
          </Link>
        ))}
      </div>

      {/* Search */}
      <form action="/business/orders" method="GET">
        <input type="text" name="search" placeholder="Search by Order ID, ICCID, package, or customer..."
          defaultValue={searchParams?.search || ''}
          className="w-full max-w-md rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
        {searchParams?.status && <input type="hidden" name="status" value={searchParams.status} />}
      </form>

      {purchases.length > 0 ? (
        <div className="space-y-3">
          {purchases.map(purchase => {
            const esim = purchase.esims[0]
            const hasQR = !!esim?.qrCodeUrl
            return (
              <Link key={purchase.id} href={`/business/orders/${purchase.id}`} className="block rounded-xl border border-gray-100 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-base font-semibold text-gray-900">
                        {purchase.package.displayName || purchase.package.name}
                      </h3>
                      <StatusBadge status={purchase.status} />
                      {hasQR && (
                        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                          QR Ready
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-sm text-gray-500">
                      <span>#{purchase.id.slice(-8)}</span>
                      <span className="text-gray-300">·</span>
                      <span>Qty: {purchase.quantity}</span>
                      <span className="text-gray-300">·</span>
                      <span>{purchase.package.dataGB} GB / {purchase.package.validityDays}d</span>
                      {esim?.iccid && <><span className="text-gray-300">·</span><span className="font-mono text-xs text-gray-400">ICCID: {esim.iccid.slice(-8)}</span></>}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-400">
                      Ordered by {purchase.user.name || purchase.user.email} · {new Date(purchase.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="ml-4 text-right shrink-0">
                    <p className="text-lg font-bold text-gray-900">${Number(purchase.totalAmount).toFixed(2)}</p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {purchase.esims.length} / {purchase.quantity} eSIMs
                    </p>
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      ) : (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">
            {searchParams?.status || searchParams?.search
              ? 'No orders match your filter. Try adjusting your search or filter.'
              : 'No orders yet. Start by purchasing your first eSIM package!'}
          </p>
          {!searchParams?.status && !searchParams?.search && (
            <Link href="/business/buy-esim" className="mt-4 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
              Buy eSIMs
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
