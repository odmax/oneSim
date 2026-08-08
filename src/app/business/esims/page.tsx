import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { syncEsimStatusAction } from '@/lib/actions/esim'
import { getPackageDisplayName, getPackageDataGB, isPackageArchived } from '@/lib/packages/snapshot-utils'
import CopyButton from '@/components/CopyButton'
import ShareActions from './ShareActions'
import { QrCodeButton } from '@/components/business/QrCodeModal'
import { getEsimStatusLabel } from '@/lib/providers/capabilities/esim-action-availability'

function safeProviderLPA(raw: any): { lpaValue?: string; smdpAddress?: string } | null {
  if (!raw) return null
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!data || typeof data !== 'object') return null
    const lpa = data.lpa || data.LPA || data.activationString || data.smdp
    const smdp = data.smdp || data.SMDP || data['sm-dp+'] || null
    return { lpaValue: lpa || undefined, smdpAddress: smdp || undefined }
  } catch { return null }
}

function StatusPill({ status }: { status: string }) {
  const { label, tone } = getEsimStatusLabel(status)
  const styles: Record<string, { bg: string; dot: string }> = {
    success: { bg: 'bg-emerald-50 text-emerald-600', dot: 'bg-emerald-400' },
    warn: { bg: 'bg-amber-50 text-amber-600', dot: 'bg-amber-400' },
    danger: { bg: 'bg-red-50 text-red-600', dot: 'bg-red-400' },
    neutral: { bg: 'bg-gray-50 text-gray-600', dot: 'bg-gray-400' },
  }
  const s = styles[tone] || styles.neutral
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${s.bg}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {label}
    </span>
  )
}

export default async function ESIMsPage({ searchParams }: { searchParams: { success?: string; error?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') { redirect('/login') }

  const esims = await prisma.eSIM.findMany({
    where: { purchase: { businessId: session.user.businessId! } },
    include: { purchase: { include: { package: true } } },
    orderBy: { createdAt: 'desc' },
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">eSIM Inventory</h2>
          <p className="mt-1 text-sm text-gray-500">Manage your eSIMs and share activation details</p>
        </div>
        <Link href="/business/buy-esim">
          <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">Buy eSIMs</button>
        </Link>
      </div>

      {searchParams.success && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">
          {searchParams.success === 'refreshed' && 'eSIM status refreshed'}
          {searchParams.success === 'activated' && 'eSIM activation detected! Status updated to Active.'}
          {searchParams.success === 'shared' && 'eSIM shared successfully'}
        </div>
      )}
      {searchParams.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {searchParams.error === 'permission' && 'You do not have permission to perform this action'}
          {searchParams.error === 'sync_failed' && 'Failed to sync eSIM status. Please try again later.'}
          {searchParams.error !== 'permission' && searchParams.error !== 'sync_failed' && searchParams.error}
        </div>
      )}

      {esims.length > 0 ? (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">ICCID</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Package</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Expires</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {esims.map((esim) => {
                  const pkg = esim.purchase.package
                  const snapName = getPackageDisplayName(esim)
                  const snapData = getPackageDataGB(esim)
                  const archived = pkg ? isPackageArchived(pkg) : false
                  const shareMsg = encodeURIComponent(
                    `Your eSIM is ready!\n\nPackage: ${snapName}\nICCID: ${esim.iccid}${esim.activationCode ? `\nActivation Code: ${esim.activationCode}` : ''}\n${esim.qrCodeUrl ? `\nQR Code: ${esim.qrCodeUrl}` : ''}\n\nInstall: Settings → Cellular → Add eSIM\n\n— OneSim Africa`
                  )
                  const whatsAppUrl = `https://wa.me/?text=${shareMsg}`
                  return (
                    <tr key={esim.id} className="hover:bg-gray-50/50 transition-colors">
                       <td className="whitespace-nowrap px-5 py-4">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-mono text-gray-900">{esim.iccid}</span>
                          <CopyButton text={esim.iccid} label="Copy ICCID" />
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm text-gray-700">
                        {snapName}
                        <span className="ml-1.5 text-xs text-gray-400">({snapData}GB)</span>
                        {archived && <span className="ml-1.5 text-xs text-amber-500">(discontinued)</span>}
                      </td>
                      <td className="whitespace-nowrap px-5 py-4">
                        <StatusPill status={esim.status} />
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm text-gray-500">
                        {esim.expiresAt ? new Date(esim.expiresAt).toLocaleDateString() : '\u2014'}
                      </td>
                       <td className="whitespace-nowrap px-5 py-4">
                          <div className="flex flex-col gap-1.5">
                            <Link href={`/business/esims/${esim.id}`} className="text-xs font-medium text-cyan-600 hover:text-cyan-700 underline">
                              View eSIM
                            </Link>
                            <QrCodeButton esim={{
                              esimId: esim.id, iccid: esim.iccid,
                              activationCode: esim.activationCode, qrCodeUrl: esim.qrCodeUrl,
                              providerResponse: safeProviderLPA(esim.providerResponse),
                              status: esim.status,
                              customerName: null,
                            }} />
                            <ShareActions
                              esimId={esim.id}
                              iccid={esim.iccid}
                              activationCode={esim.activationCode}
                              qrCodeUrl={esim.qrCodeUrl}
                              packageName={snapName}
                              whatsAppUrl={whatsAppUrl}
                            />
                            {['ACTIVE', 'PENDING_ACTIVATION', 'PENDING'].includes(esim.status) && esim.iccid && (
                              <Link href={`/business/esims/${esim.id}/top-up`} className="text-xs font-medium text-emerald-600 hover:text-emerald-700">Top Up</Link>
                            )}
                            <form action={syncEsimStatusAction.bind(null, esim.id)}>
                              <button type="submit" className="text-xs font-medium text-cyan-600 hover:text-cyan-700">Refresh Status</button>
                            </form>
                            <CopyButton text={`ICCID: ${esim.iccid}\nPackage: ${snapName}\nData: ${snapData}GB`} label="Copy Details" />
                          </div>
                        </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No eSIMs found. Start by purchasing your first eSIM package!</p>
          <Link href="/business/buy-esim"><button className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">Buy eSIMs</button></Link>
        </div>
      )}
    </div>
  )
}
