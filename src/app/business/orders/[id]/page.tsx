import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { UsageSummary } from '@/components/admin/esims/UsageBar'
import { refreshEsimStatusAction, refreshEsimUsageAction } from '@/lib/actions/esim-lifecycle'
import { OrderStatusPoller } from './OrderStatusPoller'
import { orderStatusLabel, orderEventLabel } from '@/lib/status-labels'

export default async function BusinessOrderDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const businessId = session.user.businessId!
  if (!businessId) redirect('/login')

  const order = await prisma.eSIMPurchase.findFirst({
    where: { id: params.id, businessId },
    include: {
      package: { select: { id: true, name: true, dataGB: true, validityDays: true } },
      user: { select: { name: true, email: true } },
      esims: true,
      events: { orderBy: { createdAt: 'desc' } },
    },
  })
  if (!order) redirect('/business/orders')

  const esim = order.esims[0]

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <Link href="/business/orders" className="text-sm text-gray-500 hover:text-gray-700">← Back to Orders</Link>

      <OrderStatusPoller orderId={order.id} initialStatus={order.status} />

      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Order #{order.id.slice(-8)}</h2>
          <p className="text-sm text-gray-500">{new Date(order.createdAt).toLocaleString()}</p>
        </div>
        <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${orderStatusLabel(order.status).bg}`}>
          {orderStatusLabel(order.status).label}
        </span>
      </div>

      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Package Details</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between"><dt className="text-gray-500">Package</dt><dd className="font-medium text-gray-900">{order.package.name}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Data</dt><dd className="font-medium text-gray-900">{order.package.dataGB}GB</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Validity</dt><dd className="font-medium text-gray-900">{order.package.validityDays} days</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Total Charged</dt><dd className="font-semibold text-gray-900">${Number(order.totalAmount).toFixed(2)}</dd></div>
        </dl>
      </div>

      {esim && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">eSIM Details</h3>
          <div className="space-y-4">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">ICCID</dt><dd className="font-mono text-sm text-gray-900">{esim.iccid}</dd></div>
              {esim.activationCode && <div className="flex justify-between"><dt className="text-gray-500">Activation Code</dt><dd className="font-mono text-xs text-gray-900 break-all">{esim.activationCode}</dd></div>}
              {esim.qrCodeUrl && (
                <div className="flex justify-center mt-4">
                  <img src={esim.qrCodeUrl} alt="eSIM QR Code" className="w-48 h-48 rounded-lg border" />
                </div>
              )}
            </dl>
            <div className="rounded-lg bg-blue-50 p-4">
              <p className="text-sm font-medium text-blue-800 mb-2">Installation Instructions</p>
              <ol className="text-xs text-blue-700 space-y-1 list-decimal ml-4">
                <li>Open your device Settings</li>
                <li>Go to Cellular / Mobile Data</li>
                <li>Tap &ldquo;Add eSIM&rdquo;</li>
                <li>Scan the QR code shown above</li>
                <li>Follow on-screen instructions to activate</li>
                {esim.activationCode && <li className="mt-2">Or enter code manually: <code className="font-mono text-blue-800">{esim.activationCode}</code></li>}
              </ol>
            </div>
          </div>
        </div>
      )}

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
            <form action={async () => { 'use server'; await refreshEsimUsageAction(esim.id); }}>
              <button type="submit" className="rounded-lg border border-cyan-300 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-50">Refresh Usage</button>
            </form>
            <form action={async () => { 'use server'; await refreshEsimStatusAction(esim.id); }}>
              <button type="submit" className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">Refresh Status</button>
            </form>
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Timeline</h3>
        {order.events.length === 0 ? (
          <p className="text-sm text-gray-400">No events</p>
        ) : (
          <div className="space-y-3">
            {order.events.map(ev => (
              <div key={ev.id} className="flex gap-3 text-sm">
                <div className="w-2 h-2 mt-1.5 rounded-full bg-gray-300 shrink-0" />
                <div>
                  <p className="text-xs font-medium text-gray-900">{orderEventLabel(ev.eventType)}</p>
                  <p className="text-xs text-gray-500">{ev.message || (ev.newStatus ? orderStatusLabel(ev.newStatus).label : '')}</p>
                  <p className="text-xs text-gray-400">{new Date(ev.createdAt).toLocaleString()}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">
        Need help? <Link href="/business/support" className="text-cyan-600 hover:underline">Contact Support</Link>
      </div>
    </div>
  )
}
