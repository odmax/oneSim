import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { retryFailedOrder, cancelOrder, refundOrder } from '@/lib/actions/order-actions'
import { UsageBar, UsageSummary } from '@/components/admin/esims/UsageBar'

const STATUS_COLORS: Record<string, string> = {
  CREATED: 'bg-gray-100 text-gray-700', PAYMENT_RESERVED: 'bg-blue-100 text-blue-700',
  PENDING_PROVIDER: 'bg-amber-100 text-amber-700', PROVIDER_ACCEPTED: 'bg-cyan-100 text-cyan-700',
  RESERVED: 'bg-purple-100 text-purple-700', FULFILLING: 'bg-indigo-100 text-indigo-700',
  FULFILLED: 'bg-emerald-100 text-emerald-700', INSTALLING: 'bg-sky-100 text-sky-700',
  INSTALLED: 'bg-teal-100 text-teal-700', ACTIVE: 'bg-green-100 text-green-700',
  EXPIRED: 'bg-gray-100 text-gray-700', CANCELLED: 'bg-amber-100 text-amber-700',
  FAILED: 'bg-red-100 text-red-700', REFUNDED: 'bg-rose-100 text-rose-700',
  PROVIDER_RECONCILIATION: 'bg-purple-50 text-purple-700',
  PARTIALLY_FULFILLED: 'bg-amber-50 text-amber-700',
}

export default async function AdminOrderDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const order = await prisma.eSIMPurchase.findUnique({
    where: { id: params.id },
    include: {
      business: true, user: true, package: true, provider: true,
      esims: true, events: { orderBy: { createdAt: 'desc' } },
    },
  })
  if (!order) redirect('/admin/orders')

  // Wallet ledger is keyed by a plain orderId string (covers purchases AND top-ups),
  // not a relation on the order.
  const walletTransactions = await prisma.walletTransaction.findMany({
    where: { orderId: params.id },
    orderBy: { createdAt: 'desc' },
  })

  const esim = order.esims[0]
  const canRetry = order.status === 'FAILED' && order.retryCount < order.maxRetries
  const canCancel = ['CREATED', 'PAYMENT_RESERVED', 'PENDING_PROVIDER', 'FAILED'].includes(order.status)
  const canRefund = ['CANCELLED', 'FAILED', 'EXPIRED'].includes(order.status)

  // Find compatible top-up packages if eSIM is active
  const topUpPkgs = esim && ['ACTIVE', 'PENDING_ACTIVATION'].includes(esim.status)
    ? await prisma.eSIMPackage.findMany({
        where: {
          isActive: true,
          productType: { in: ['TOP_UP', 'BOTH'] },
          providerId: order.providerId || order.package.providerId || undefined,
        },
        orderBy: { priceUSD: 'asc' },
        take: 5,
      })
    : []

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <Link href="/admin/orders" className="text-sm text-gray-500 hover:text-gray-700">← Back to Orders</Link>

      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Order #{order.id.slice(-8)}</h2>
          <p className="text-sm text-gray-500">{new Date(order.createdAt).toLocaleString()}</p>
        </div>
        <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLORS[order.status] || 'bg-gray-100 text-gray-700'}`}>
          {order.status}
        </span>
      </div>
      <div className="mt-2">
        <Link href={`/admin/operations/orders/${order.id}`} className="text-xs text-cyan-600 hover:underline">
          Open Operations View &rarr;
        </Link>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Order Info</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">Business</dt><dd className="font-medium text-gray-900">{order.business.name}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Customer</dt><dd className="font-medium text-gray-900">{order.user.name}<br/><span className="text-xs text-gray-500">{order.user.email}</span></dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Package</dt><dd className="font-medium text-gray-900">{order.package.name}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Quantity</dt><dd className="font-medium text-gray-900">{order.quantity}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Total</dt><dd className="font-semibold text-gray-900">${Number(order.totalAmount).toFixed(2)}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Provider</dt><dd className="font-medium text-gray-900">{order.provider?.name || '—'}</dd></div>
          </dl>
        </div>

        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">eSIM Details</h3>
          {esim ? (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">ICCID</dt><dd className="font-mono text-xs text-gray-900">{esim.iccid}</dd></div>
              {esim.imsi && <div className="flex justify-between"><dt className="text-gray-500">IMSI</dt><dd className="font-mono text-xs text-gray-900">{esim.imsi}</dd></div>}
              {esim.activationCode && <div className="flex justify-between"><dt className="text-gray-500">Activation Code</dt><dd className="font-mono text-xs text-gray-900 break-all">{esim.activationCode}</dd></div>}
              {esim.qrCodeUrl && <div className="flex justify-between"><dt className="text-gray-500">QR Code</dt><dd><a href={esim.qrCodeUrl} target="_blank" className="text-xs text-cyan-600 hover:underline">Open QR</a></dd></div>}
              <div className="flex justify-between"><dt className="text-gray-500">eSIM Status</dt><dd className="font-medium text-gray-900">{esim.status}</dd></div>
              {esim.expiresAt && <div className="flex justify-between"><dt className="text-gray-500">Expires</dt><dd className="text-sm text-gray-600">{new Date(esim.expiresAt).toLocaleDateString()}</dd></div>}
              {esim.lastUsageSyncAt ? <div className="flex justify-between"><dt className="text-gray-500">Usage Refreshed</dt><dd className="text-xs text-gray-500">{new Date(esim.lastUsageSyncAt).toLocaleString()}</dd></div> : null}
              <div className="pt-2">
                <Link href={`/admin/esims/${esim.id}`} className="text-xs text-cyan-600 hover:underline">View eSIM Detail →</Link>
              </div>
            </dl>
          ) : <p className="text-sm text-gray-400">No eSIM data</p>}
        </div>
      </div>

      {/* Usage Section */}
      {esim && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Data Usage</h3>
          <UsageSummary
            dataUsedMB={esim.dataUsedMB}
            dataTotalMB={esim.dataTotalMB}
            dataRemainingMB={esim.dataRemainingMB}
            lastUsageAt={esim.lastUsageAt}
            lastUsageSyncAt={esim.lastUsageSyncAt}
            expiresAt={esim.expiresAt}
            status={esim.status}
          />
          <div className="mt-3 flex gap-2">
            <form action={async () => { 'use server'; const { refreshEsimUsageAction } = await import('@/lib/actions/esim-lifecycle'); await refreshEsimUsageAction(esim.id); }}>
              <button type="submit" className="rounded-lg border border-cyan-300 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-50">Refresh Usage</button>
            </form>
            <form action={async () => { 'use server'; const { refreshEsimStatusAction } = await import('@/lib/actions/esim-lifecycle'); await refreshEsimStatusAction(esim.id); }}>
              <button type="submit" className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">Refresh Status</button>
            </form>
          </div>
        </div>
      )}

      {/* Top-up Section */}
      {topUpPkgs.length > 0 && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Top-Up Available</h3>
          <div className="space-y-2">
            {topUpPkgs.map(pkg => (
              <form key={pkg.id} action={async () => { 'use server'; const { adminTopUpEsim } = await import('@/lib/actions/esim-lifecycle'); await adminTopUpEsim(esim!.id, pkg.id, order.businessId, session!.user.id); }}>
                <button type="submit" className="flex w-full items-center justify-between rounded-lg border border-gray-100 p-3 text-sm hover:bg-gray-50">
                  <span className="font-medium text-gray-900">{pkg.displayName || pkg.name}</span>
                  <span className="text-emerald-600 font-semibold">${parseFloat(pkg.priceUSD.toString()).toFixed(2)}</span>
                </button>
              </form>
            ))}
          </div>
        </div>
      )}

      {/* Retry/Cancel/Refund actions */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Actions</h3>
        <div className="flex flex-wrap gap-2">
          {canRetry && (
            <form action={async () => { 'use server'; await retryFailedOrder(order.id) }}>
              <button type="submit" className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700">Retry ({order.retryCount}/{order.maxRetries})</button>
            </form>
          )}
          {canCancel && (
            <form action={async () => { 'use server'; await cancelOrder(order.id) }}>
              <button type="submit" className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">Cancel Order</button>
            </form>
          )}
          {canRefund && (
            <form action={async () => { 'use server'; await refundOrder(order.id) }}>
              <button type="submit" className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700">Refund</button>
            </form>
          )}
          {!canRetry && !canCancel && !canRefund && <p className="text-sm text-gray-400">No actions available for this order status.</p>}
        </div>
        {order.retryCount > 0 && <p className="mt-2 text-xs text-gray-400">Retry count: {order.retryCount}/{order.maxRetries}{order.lastRetryAt ? ` (Last: ${new Date(order.lastRetryAt).toLocaleString()})` : ''}</p>}
        {order.failureReason && <p className="mt-2 text-xs text-red-500">Failure: {order.failureReason}</p>}
        {order.providerErrorMessage && <p className="mt-1 text-xs text-red-400">Provider: {order.providerErrorMessage}</p>}
      </div>

      {/* Wallet Ledger */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Wallet Ledger</h3>
        {walletTransactions.length === 0 ? (
          <p className="text-sm text-gray-400">No wallet transactions</p>
        ) : (
          <div className="space-y-1">
            {walletTransactions.map(wt => (
              <div key={wt.id} className="flex items-center justify-between text-sm">
                <div><span className="font-mono text-xs text-gray-500">{wt.type}</span><span className="text-gray-400 ml-2">{wt.description}</span></div>
                <span className={`font-mono text-sm ${Number(wt.amount) > 0 ? 'text-emerald-600' : 'text-red-500'}`}>{Number(wt.amount) > 0 ? '+' : ''}${Math.abs(Number(wt.amount)).toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Timeline</h3>
        {order.events.length === 0 ? (
          <p className="text-sm text-gray-400">No events</p>
        ) : (
          <div className="space-y-3">
            {order.events.map(ev => (
              <div key={ev.id} className="flex gap-3 text-sm">
                <div className="w-2 h-2 mt-1.5 rounded-full bg-gray-300 shrink-0" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-900">{ev.eventType}</span>
                    <span className="text-xs text-gray-400">{new Date(ev.createdAt).toLocaleString()}</span>
                  </div>
                  {ev.message && <p className="text-xs text-gray-500">{ev.message}</p>}
                  {ev.oldStatus && ev.newStatus && <p className="text-xs text-gray-400">{ev.oldStatus} → {ev.newStatus}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
