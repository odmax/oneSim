import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getPackageDisplayName, getPackageDataGB, getPackageValidityDays } from '@/lib/packages/snapshot-utils'
import { UsageSummary } from '@/components/admin/esims/UsageBar'
import { QrCodeButton } from '@/components/business/QrCodeModal'
import { getEsimStatusLabel } from '@/lib/providers/capabilities/esim-action-availability'
import { syncEsimStatusAction } from '@/lib/actions/esim'

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between py-1.5">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={`text-xs text-gray-900 max-w-[180px] truncate text-right ${mono ? 'font-mono' : ''}`}>{value || '\u2014'}</dd>
    </div>
  )
}

export default async function BusinessEsimDetailPage({ params, searchParams }: {
  params: { id: string }
  searchParams?: { error?: string; success?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const esim = await prisma.eSIM.findFirst({
    where: {
      id: params.id,
      purchase: { businessId: session.user.businessId! },
    },
    include: {
      purchase: { include: { package: true } },
      usageRecords: { orderBy: { timestamp: 'desc' }, take: 20 },
    },
  })

  if (!esim) notFound()

  const pkg = esim.purchase.package
  const statusLabel = getEsimStatusLabel(esim.status)
  const toneClasses =
    statusLabel.tone === 'success' ? 'bg-green-100 text-green-800'
    : statusLabel.tone === 'warn' ? 'bg-yellow-100 text-yellow-800'
    : statusLabel.tone === 'danger' ? 'bg-red-100 text-red-800'
    : 'bg-gray-100 text-gray-700'

  const hasUsageSnapshot = esim.dataTotalMB != null || esim.dataRemainingMB != null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/business/esims" className="text-sm text-cyan-600 hover:underline">&larr; Back to eSIM Inventory</Link>
          <h2 className="mt-1 text-2xl font-bold text-gray-900">eSIM Detail</h2>
        </div>
      </div>

      {searchParams?.success && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">
          {searchParams.success === 'refreshed' && 'eSIM status refreshed'}
          {searchParams.success === 'activated' && 'eSIM activation detected! Status updated to Active.'}
        </div>
      )}
      {searchParams?.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {searchParams.error === 'sync_failed' && 'Failed to sync eSIM status'}
          {searchParams.error !== 'sync_failed' && searchParams.error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* eSIM Information */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-base font-semibold text-gray-900">eSIM Information</h3>
          <dl className="space-y-1">
            <DetailRow label="ICCID" value={esim.iccid} mono />
            {esim.imsi && <DetailRow label="IMSI" value={esim.imsi} mono />}
            <div className="flex justify-between py-1.5">
              <dt className="text-xs text-gray-500">Status</dt>
              <dd><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${toneClasses}`}>{statusLabel.label}</span></dd>
            </div>
            <div className="flex justify-between py-1.5">
              <dt className="text-xs text-gray-500">Package</dt>
              <dd className="text-xs font-medium text-gray-900 text-right">{getPackageDisplayName(esim)}</dd>
            </div>
            <DetailRow label="Data" value={`${getPackageDataGB(esim)} GB`} />
            <DetailRow label="Validity" value={`${getPackageValidityDays(esim)} days`} />
            {esim.activatedAt && <DetailRow label="Activated" value={esim.activatedAt.toLocaleDateString()} />}
            {esim.expiresAt && <DetailRow label="Expires" value={esim.expiresAt.toLocaleDateString()} />}
          </dl>
        </div>

        {/* QR Code & Usage */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-base font-semibold text-gray-900">QR Code &amp; Usage</h3>

          {esim.qrCodeUrl ? (
            <div className="mb-4 text-center">
              <img src={esim.qrCodeUrl} alt="eSIM QR Code" className="mx-auto h-36 w-36 rounded-lg border" />
              <a href={esim.qrCodeUrl} target="_blank" className="mt-2 inline-block text-xs text-cyan-600 hover:underline">Open QR Code</a>
            </div>
          ) : esim.activationCode ? (
            <div className="mb-4 rounded-lg bg-cyan-50 border border-cyan-100 p-4 text-center">
              <p className="text-sm font-medium text-cyan-700">eSIM Ready</p>
              <p className="mt-1 text-xs text-cyan-600">Activation code is available. Use the QR button to view details.</p>
            </div>
          ) : (
            <p className="mb-4 text-xs text-gray-400">No QR code available yet.</p>
          )}

          {hasUsageSnapshot ? (
            <div className="mb-4 rounded-lg bg-gray-50 p-4">
              <UsageSummary
                dataUsedMB={esim.dataUsedMB}
                dataTotalMB={esim.dataTotalMB}
                dataRemainingMB={esim.dataRemainingMB}
                lastUsageAt={esim.lastUsageAt}
                lastUsageSyncAt={esim.lastUsageSyncAt}
                expiresAt={esim.expiresAt}
                status={esim.status}
              />
            </div>
          ) : (
            <p className="mb-4 text-xs text-gray-400">Usage data is not yet available.</p>
          )}
        </div>
      </div>

      {/* Actions — business-safe only */}
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <h3 className="mb-4 text-base font-semibold text-gray-900">Actions</h3>
        <div className="flex flex-wrap gap-3 items-center">
          {(esim.status === 'ACTIVE' || esim.status === 'PENDING_ACTIVATION' || esim.status === 'PENDING') && (
            <Link href={`/business/esims/${esim.id}/top-up`}
              className="rounded-lg border border-emerald-300 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 dark-hover:bg-emerald-50/80">
              Top Up
            </Link>
          )}
          <form action={syncEsimStatusAction.bind(null, esim.id)}>
            <button type="submit" className="rounded-lg border border-cyan-300 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50">
              Refresh Status
            </button>
          </form>
          <QrCodeButton esim={{
            esimId: esim.id, iccid: esim.iccid,
            activationCode: esim.activationCode, qrCodeUrl: esim.qrCodeUrl,
            providerResponse: esim.providerResponse,
            status: esim.status,
            customerName: null,
          }} />
          <Link href="/business/esims"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Back to Inventory
          </Link>
        </div>
      </div>
    </div>
  )
}
