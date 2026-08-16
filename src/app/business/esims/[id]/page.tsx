import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getPackageDisplayName, getPackageDataGB, getPackageValidityDays } from '@/lib/packages/snapshot-utils'
import { UsageSummary } from '@/components/admin/esims/UsageBar'
import { QrCodeButton } from '@/components/business/QrCodeModal'
import { QrImage } from '@/components/business/QrImage'
import { getEsimStatusLabel } from '@/lib/providers/capabilities/esim-action-availability'
import { syncEsimStatusAction } from '@/lib/actions/esim'
import { getEsimClientCapabilities } from '@/lib/esim/client-capabilities'
import { hasUsableInstallData, buildInstallationPresentation } from '@/lib/esim/installation-data'

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between py-1.5">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={`text-xs text-gray-900 max-w-[180px] truncate text-right ${mono ? 'font-mono' : ''}`}>{value || '\u2014'}</dd>
    </div>
  )
}

function timeAgo(date: Date): string {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} minute${mins > 1 ? 's' : ''} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days > 1 ? 's' : ''} ago`
}

function safeProviderLPA(raw: any): { lpaValue?: string; smdpAddress?: string } | null {
  if (!raw) return null
  try { const d = typeof raw === 'string' ? JSON.parse(raw) : raw; return d && typeof d === 'object' ? { lpaValue: d.lpa || d.LPA || undefined, smdpAddress: d.smdp || d.SMDP || undefined } : null } catch { return null }
}

const INSTALL_MESSAGES: Record<string, string> = {
  PENDING: 'Installation details are being prepared automatically.',
  FAILED: 'Installation details could not be retrieved. Please contact support.',
  STALE: 'Installation details could not be retrieved. Please contact support.',
}

export default async function BusinessEsimDetailPage({ params, searchParams }: {
  params: { id: string }
  searchParams?: { error?: string; success?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const esim = await prisma.eSIM.findFirst({
    where: { id: params.id, purchase: { businessId: session.user.businessId! } },
    include: {
      purchase: { include: { package: { select: { id: true, name: true, displayName: true, dataGB: true, validityDays: true, providerId: true } } } },
      usageRecords: { orderBy: { timestamp: 'desc' }, take: 20 },
    },
  })

  if (!esim) notFound()

  const pkg = esim.purchase.package
  const providerId = pkg.providerId
  const caps = await getEsimClientCapabilities(providerId)
  const statusLabel = getEsimStatusLabel(esim.status)
  const toneClasses = statusLabel.tone === 'success' ? 'bg-green-100 text-green-800' : statusLabel.tone === 'warn' ? 'bg-yellow-100 text-yellow-800' : statusLabel.tone === 'danger' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-700'
  const hasUsageSnapshot = esim.dataTotalMB != null || esim.dataRemainingMB != null
  const installStatus = esim.installationStatus || 'READY'
  const installFields = { activationCode: esim.activationCode, qrCodeUrl: esim.qrCodeUrl, qrCode: esim.qrCode, smdpAddress: esim.smdpAddress, matchingId: esim.matchingId }
  const hasInstallData = hasUsableInstallData(installFields)
  const install = buildInstallationPresentation(installFields)
  const lpa = safeProviderLPA(esim.providerResponse)
  const displaySmdp = install.smdpAddress || lpa?.smdpAddress

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
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{searchParams.error}</div>
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
            {esim.lastStatusSyncAt && <DetailRow label="Last Updated" value={timeAgo(esim.lastStatusSyncAt)} />}
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

        {/* Installation */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-base font-semibold text-gray-900">Installation</h3>
          {installStatus === 'READY' && hasInstallData ? (
            <>
              {(install.qrImageUrl || install.qrPayload) ? (
                <div className="mb-4 text-center">
                  <QrImage payload={install.qrPayload} imageUrl={install.qrImageUrl} alt="eSIM QR Code" className="mx-auto h-36 w-36 rounded-lg border" />
                  {install.qrImageUrl ? (
                    <a href={install.qrImageUrl} target="_blank" className="mt-2 inline-block text-xs text-cyan-600 hover:underline">Open QR Code</a>
                  ) : null}
                </div>
              ) : null}
              {install.activationCode && (
                <div className="mb-4 rounded-lg bg-gray-50 p-3">
                  <p className="text-[10px] text-gray-400 mb-1">Activation Code</p>
                  <p className="font-mono text-xs text-gray-900 break-all">{install.activationCode}</p>
                </div>
              )}
              {displaySmdp && (
                <div className="mb-4 rounded-lg bg-gray-50 p-3">
                  <p className="text-[10px] text-gray-400 mb-1">SM-DP+ Address</p>
                  <p className="font-mono text-xs text-gray-900 break-all">{displaySmdp}</p>
                </div>
              )}
              {install.matchingId && (
                <div className="mb-4 rounded-lg bg-gray-50 p-3">
                  <p className="text-[10px] text-gray-400 mb-1">Matching ID</p>
                  <p className="font-mono text-xs text-gray-900 break-all">{install.matchingId}</p>
                </div>
              )}
              {!install.qrImageUrl && !install.qrPayload && install.activationCode && (
                <p className="text-xs text-gray-500">Use the activation code above for manual eSIM installation.</p>
              )}
            </>
          ) : (
            <p className="text-xs text-gray-400">{INSTALL_MESSAGES[installStatus] || `Installation status: ${installStatus}`}</p>
          )}
        </div>
      </div>

      {/* Usage */}
      {caps.canViewUsage && (
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-base font-semibold text-gray-900">Usage</h3>
          {hasUsageSnapshot ? (
            <>
            <UsageSummary
              dataUsedMB={esim.dataUsedMB}
              dataTotalMB={esim.dataTotalMB}
              dataRemainingMB={esim.dataRemainingMB}
              lastUsageAt={esim.lastUsageAt}
              lastUsageSyncAt={esim.lastUsageSyncAt}
              expiresAt={esim.expiresAt}
              status={esim.status}
            />
            {esim.lastUsageSyncAt && <p className="mt-2 text-[10px] text-gray-400">Last updated {timeAgo(esim.lastUsageSyncAt)}</p>}
            </>
          ) : (
            <p className="text-xs text-gray-400">Usage data has not been retrieved yet.</p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <h3 className="mb-4 text-base font-semibold text-gray-900">Actions</h3>
        <div className="flex flex-wrap gap-3 items-center">
          {caps.canRefreshStatus && (
            <form action={syncEsimStatusAction.bind(null, esim.id)}>
              <button type="submit" className="rounded-lg border border-cyan-300 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-50">Refresh Status</button>
            </form>
          )}
          {caps.canTopUp && (esim.status === 'ACTIVE' || esim.status === 'PENDING_ACTIVATION' || esim.status === 'PENDING') && (
            <Link href={`/business/esims/${esim.id}/top-up`} className="rounded-lg border border-emerald-300 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50">Top Up</Link>
          )}
          {hasInstallData && (
            <QrCodeButton esim={{
              esimId: esim.id, iccid: esim.iccid,
              activationCode: install.activationCode ?? null, qrCodeUrl: install.qrImageUrl ?? null,
              qrCode: install.qrPayload, lpaValue: install.qrPayload ?? undefined,
              smdpAddress: displaySmdp, matchingId: install.matchingId ?? null,
              status: esim.status, customerName: null,
            }} />
          )}
          <Link href="/business/esims" className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Back to Inventory</Link>
        </div>
      </div>
    </div>
  )
}
