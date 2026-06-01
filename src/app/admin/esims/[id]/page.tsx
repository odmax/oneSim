import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { syncEsimStatus, syncEsimUsage, getQrCode, suspendEsim, resumeEsim } from '@/lib/actions/esim-sync'
import { syncESIMStatus as enhancedSyncStatus } from '@/lib/services/esims/sync-esim-status'
import { getPackageDisplayName, getPackageDataGB, getPackageValidityDays } from '@/lib/packages/snapshot-utils'

export default async function AdminEsimDetailPage({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string; success?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const esim = await prisma.eSIM.findUnique({
    where: { id: params.id },
    include: {
      purchase: { include: { business: true, package: true } },
      customer: true,
      usageRecords: { orderBy: { timestamp: 'desc' }, take: 20 },
    },
  })
  if (!esim) redirect('/admin/esims')

  const latestUsage = esim.usageRecords[0]
  const totalUsage = esim.usageRecords.reduce((sum, r) => sum + r.dataUsedMB, 0)
  const provider = esim.purchase.package.providerId
    ? await prisma.provider.findUnique({ where: { id: esim.purchase.package.providerId } })
    : null

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href="/admin/esims" className="text-sm text-cyan-600 hover:underline">← Back to All eSIMs</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">eSIM Detail</h2>
        <p className="font-mono text-sm text-gray-600">{esim.iccid}</p>
      </div>

      {searchParams?.error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{decodeURIComponent(searchParams.error)}</div>}
      {searchParams?.success && <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">{decodeURIComponent(searchParams.success)}</div>}

      <div className="grid gap-6 lg:grid-cols-2 mb-6">
        {/* eSIM Details */}
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">eSIM Information</h3>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">ICCID</dt><dd className="font-mono font-medium text-gray-900">{esim.iccid}</dd></div>
            {esim.imsi && <div className="flex justify-between"><dt className="text-gray-500">IMSI</dt><dd className="font-mono font-medium text-gray-900">{esim.imsi}</dd></div>}
            {esim.activationCode && <div className="flex justify-between"><dt className="text-gray-500">Activation Code</dt><dd className="font-mono font-medium text-gray-900 break-all">{esim.activationCode}</dd></div>}
            <div className="flex justify-between"><dt className="text-gray-500">Status</dt><dd><span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${esim.status === 'ACTIVE' ? 'bg-green-100 text-green-800' : esim.status === 'SUSPENDED' ? 'bg-orange-100 text-orange-800' : esim.status === 'PENDING_ACTIVATION' || esim.status === 'PENDING' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'}`}>{esim.status === 'PENDING_ACTIVATION' ? 'Ready to install' : esim.status === 'ACTIVE' ? 'Activated on device' : esim.status === 'EXPIRED' ? 'Expired' : esim.status === 'SUSPENDED' ? 'Suspended' : esim.status === 'FAILED' ? 'Provisioning failed' : esim.status}</span></dd></div>
            {esim.providerStatus && <div className="flex justify-between"><dt className="text-gray-500">Provider Status</dt><dd className="font-medium text-gray-900">{esim.providerStatus}</dd></div>}
            {esim.providerActivationId && <div className="flex justify-between"><dt className="text-gray-500">Provider Activation ID</dt><dd className="font-mono text-xs text-gray-600">{esim.providerActivationId}</dd></div>}
            <div className="flex justify-between"><dt className="text-gray-500">Package</dt><dd className="font-medium text-gray-900">{getPackageDisplayName(esim)}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Data</dt><dd className="font-medium text-gray-900">{getPackageDataGB(esim)} GB</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Validity</dt><dd className="font-medium text-gray-900">{getPackageValidityDays(esim)} days</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Business</dt><dd className="font-medium text-gray-900">{esim.purchase.business.name}</dd></div>
            {esim.customer && <div className="flex justify-between"><dt className="text-gray-500">Customer</dt><dd className="font-medium text-gray-900">{esim.customer.name} ({esim.customer.email})</dd></div>}
            {esim.activatedAt && <div className="flex justify-between"><dt className="text-gray-500">Activated</dt><dd className="text-gray-600">{esim.activatedAt.toLocaleString()}</dd></div>}
            {esim.expiresAt && <div className="flex justify-between"><dt className="text-gray-500">Expires</dt><dd className="text-gray-600">{esim.expiresAt.toLocaleDateString()}</dd></div>}
            {esim.lastSyncAt && <div className="flex justify-between"><dt className="text-gray-500">Last Synced</dt><dd className="text-gray-600">{esim.lastSyncAt.toLocaleString()}</dd></div>}
          </dl>
        </div>

        {/* QR Code & Usage */}
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">QR Code &amp; Usage</h3>
          {esim.qrCodeUrl ? (
            <div className="mb-4 text-center">
              <img src={esim.qrCodeUrl} alt="eSIM QR Code" className="mx-auto h-40 w-40 rounded-lg border" />
              <a href={esim.qrCodeUrl} target="_blank" className="mt-2 inline-block text-sm text-cyan-600 hover:underline">Open QR Code</a>
            </div>
          ) : (
            <p className="mb-4 text-sm text-gray-500">No QR code available.</p>
          )}

          <div className="mb-4 rounded-lg bg-gray-50 p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Data Usage</p>
            <p className="text-2xl font-bold text-gray-900">{totalUsage} <span className="text-sm font-normal text-gray-500">MB total</span></p>
            {latestUsage && <p className="text-xs text-gray-400 mt-1">Last recorded: {latestUsage.timestamp.toLocaleString()} — {latestUsage.dataUsedMB} MB</p>}
            {!latestUsage && <p className="text-xs text-gray-400 mt-1">No usage data recorded yet.</p>}
          </div>

          {esim.usageRecords.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium text-gray-500 uppercase tracking-wider">Usage History</p>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {esim.usageRecords.map((r, i) => (
                  <div key={i} className="flex justify-between text-xs text-gray-600">
                    <span>{r.timestamp.toLocaleString()}</span>
                    <span className="font-medium">{r.dataUsedMB} MB</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Capabilities & Actions */}
      {provider && (
        <div className="mb-6 rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Provider Actions</h3>
          <div className="flex flex-wrap gap-3">
            <form action={async () => { 'use server'; const r = await enhancedSyncStatus(esim.id); if (r.success) { const msg = r.activated ? 'Activation+detected' : 'Status+synced'; redirect(`/admin/esims/${esim.id}?success=${msg}`) } else { redirect(`/admin/esims/${esim.id}?error=${encodeURIComponent(r.error || 'Failed')}`) } }}>
              <button type="submit" className="rounded-lg border border-cyan-300 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50">Refresh Status</button>
            </form>
            <form action={async () => { 'use server'; const r = await syncEsimUsage(esim.id); const err = String(r.error || 'Failed'); if (r.success) redirect(`/admin/esims/${esim.id}?success=Usage+synced`); else redirect(`/admin/esims/${esim.id}?error=${encodeURIComponent(err)}`) }}>
              <button type="submit" className="rounded-lg border border-cyan-300 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50">Sync Usage</button>
            </form>
            <form action={async () => { 'use server'; const r = await getQrCode(esim.id); const err = String(r.error || 'Failed'); if (r.success) redirect(`/admin/esims/${esim.id}?success=QR+code+retrieved`); else redirect(`/admin/esims/${esim.id}?error=${encodeURIComponent(err)}`) }}>
              <button type="submit" className="rounded-lg border border-purple-300 px-4 py-2 text-sm font-medium text-purple-700 hover:bg-purple-50">Get QR Code</button>
            </form>
            <form action={async () => { 'use server'; const r = await suspendEsim(esim.id); const err = String(r.error || 'Failed'); if (r.success) redirect(`/admin/esims/${esim.id}?success=eSIM+suspended`); else redirect(`/admin/esims/${esim.id}?error=${encodeURIComponent(err)}`) }}>
              <button type="submit" className="rounded-lg border border-orange-300 px-4 py-2 text-sm font-medium text-orange-700 hover:bg-orange-50">Suspend eSIM</button>
            </form>
            <form action={async () => { 'use server'; const r = await resumeEsim(esim.id); const err = String(r.error || 'Failed'); if (r.success) redirect(`/admin/esims/${esim.id}?success=eSIM+resumed`); else redirect(`/admin/esims/${esim.id}?error=${encodeURIComponent(err)}`) }}>
              <button type="submit" className="rounded-lg border border-green-300 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-50">Resume eSIM</button>
            </form>
            {esim.iccid && ['ACTIVE', 'PENDING_ACTIVATION', 'PENDING'].includes(esim.status) && (
              <Link href={`/admin/esims/${esim.id}/top-up`} className="inline-block rounded-lg border border-emerald-300 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50">
                Top Up
              </Link>
            )}
          </div>
          {provider && <p className="mt-3 text-xs text-gray-400">Powered by: {provider.name}</p>}
        </div>
      )}

      {/* Delivery Information */}
      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Delivery</h3>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between"><dt className="text-gray-500">Delivery Status</dt><dd><span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${esim.deliveryStatus === 'SENT' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>{esim.deliveryStatus}</span></dd></div>
          {esim.deliveredAt && <div className="flex justify-between"><dt className="text-gray-500">Delivered At</dt><dd className="text-gray-600">{esim.deliveredAt.toLocaleString()}</dd></div>}
        </dl>
      </div>

      {/* Provider Raw Data */}
      {esim.providerResponse && (
        <details className="mt-6 rounded-lg border bg-white p-4">
          <summary className="cursor-pointer text-sm font-medium text-gray-700">Provider Raw Response</summary>
          <pre className="mt-2 overflow-x-auto text-xs text-gray-600">{JSON.stringify(esim.providerResponse, null, 2)}</pre>
        </details>
      )}
    </div>
  )
}
