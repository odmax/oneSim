import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { assignESIM, unassignESIM, markAsSent, sendToCustomer, syncEsimStatusAction, shareEsimViaEmail, createShareToken } from '@/lib/actions/esim'
import CopyButton from '@/components/CopyButton'
import ShareActions from './ShareActions'

function StatusPill({ status }: { status: string }) {
  const config: Record<string, { label: string; bg: string; dot: string }> = {
    ACTIVE: { label: 'Activated on device', bg: 'bg-emerald-50 text-emerald-600', dot: 'bg-emerald-400' },
    PENDING_ACTIVATION: { label: 'Ready to install', bg: 'bg-amber-50 text-amber-600', dot: 'bg-amber-400' },
    PENDING: { label: 'Ready to install', bg: 'bg-amber-50 text-amber-600', dot: 'bg-amber-400' },
    FAILED: { label: 'Provisioning failed', bg: 'bg-red-50 text-red-600', dot: 'bg-red-400' },
    EXPIRED: { label: 'Expired', bg: 'bg-red-50 text-red-600', dot: 'bg-red-400' },
    SUSPENDED: { label: 'Suspended', bg: 'bg-orange-50 text-orange-600', dot: 'bg-orange-400' },
    INACTIVE: { label: 'Inactive', bg: 'bg-gray-50 text-gray-500', dot: 'bg-gray-400' },
  }
  const c = config[status] || { label: status, bg: 'bg-gray-50 text-gray-600', dot: 'bg-gray-400' }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${c.bg}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  )
}

function DeliveryPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
      status === 'SENT' ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-50 text-gray-500'
    }`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === 'SENT' ? 'bg-emerald-400' : 'bg-gray-400'}`} />
      {status === 'SENT' ? 'Sent' : 'Not sent'}
    </span>
  )
}

export default async function ESIMsPage({ searchParams }: { searchParams: { success?: string; error?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') { redirect('/login') }

  const businessUser = await prisma.businessUser.findFirst({
    where: { userId: session.user.id, businessId: session.user.businessId! },
    select: { role: true },
  })
  const isAdmin = businessUser?.role === 'ADMIN'

  const esims = await prisma.eSIM.findMany({
    where: { purchase: { businessId: session.user.businessId! } },
    include: { purchase: { include: { package: true } }, customer: true },
    orderBy: { createdAt: 'desc' },
  })

  const customers = isAdmin ? await prisma.customer.findMany({
    where: { businessId: session.user.businessId! },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  }) : []

  const getAppUrl = () => process.env.NEXT_PUBLIC_APP_URL || 'https://staging.onetelecom.cloud'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">eSIM Inventory</h2>
          <p className="mt-1 text-sm text-gray-500">Manage your eSIMs, assign to customers, and share activation details</p>
        </div>
        <Link href="/business/buy-esim">
          <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">Buy eSIMs</button>
        </Link>
      </div>

      {searchParams.success && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">
          {searchParams.success === 'assigned' && 'eSIM assigned successfully'}
          {searchParams.success === 'unassigned' && 'eSIM unassigned successfully'}
          {searchParams.success === 'sent' && 'Activation details sent to customer'}
          {searchParams.success === 'refreshed' && 'eSIM status refreshed'}
          {searchParams.success === 'activated' && 'eSIM activation detected! Status updated to Active.'}
          {searchParams.success === 'shared' && 'eSIM shared successfully'}
        </div>
      )}
      {searchParams.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {searchParams.error === 'permission' && 'You do not have permission to perform this action'}
          {searchParams.error === 'assignment_failed' && 'Failed to assign eSIM. Please make sure a customer is selected and try again.'}
          {searchParams.error === 'sync_failed' && 'Failed to sync eSIM status. Please try again later.'}
          {searchParams.error !== 'permission' && searchParams.error !== 'assignment_failed' && searchParams.error !== 'sync_failed' && searchParams.error}
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
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Customer</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Delivery</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Expires</th>
                  {isAdmin && <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {esims.map((esim) => {
                  const pkg = esim.purchase.package
                  const shareMsg = encodeURIComponent(
                    `Your eSIM is ready!\n\nPackage: ${pkg.displayName || pkg.name}\nICCID: ${esim.iccid}${esim.activationCode ? `\nActivation Code: ${esim.activationCode}` : ''}\n${esim.qrCodeUrl ? `\nQR Code: ${esim.qrCodeUrl}` : ''}\n\nInstall: Settings → Cellular → Add eSIM\n\n— OneSim Africa`
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
                        {pkg.displayName || pkg.name}
                        <span className="ml-1.5 text-xs text-gray-400">({pkg.dataGB}GB)</span>
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm">
                        {esim.customer ? (
                          <div>
                            <div className="font-medium text-gray-900">{esim.customer.name}</div>
                            <div className="text-xs text-gray-500">{esim.customer.email}</div>
                          </div>
                        ) : (
                          <span className="text-gray-400 italic">Unassigned</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-5 py-4">
                        <DeliveryPill status={esim.deliveryStatus} />
                      </td>
                      <td className="whitespace-nowrap px-5 py-4">
                        <StatusPill status={esim.status} />
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm text-gray-500">
                        {esim.expiresAt ? new Date(esim.expiresAt).toLocaleDateString() : '—'}
                      </td>
                      {isAdmin && (
                        <td className="whitespace-nowrap px-5 py-4">
                          <div className="flex flex-col gap-1.5">
                            {/* Top Up */}
                            {['ACTIVE', 'PENDING_ACTIVATION', 'PENDING'].includes(esim.status) && esim.iccid && (
                              <Link href={`/business/esims/${esim.id}/top-up`} className="text-xs font-medium text-emerald-600 hover:text-emerald-700">Top Up</Link>
                            )}
                            {/* Refresh Status */}
                            <form action={syncEsimStatusAction.bind(null, esim.id)}>
                              <button type="submit" className="text-xs font-medium text-cyan-600 hover:text-cyan-700">Refresh Status</button>
                            </form>
                            {/* Share Actions */}
                            <ShareActions
                              esimId={esim.id}
                              iccid={esim.iccid}
                              activationCode={esim.activationCode}
                              qrCodeUrl={esim.qrCodeUrl}
                              packageName={pkg.displayName || pkg.name}
                              whatsAppUrl={whatsAppUrl}
                              customerEmail={esim.customer?.email}
                            />
                            {/* Assign / Manage */}
                            {esim.customer ? (
                              <>
                                {esim.qrCodeUrl && (
                                  <a href={esim.qrCodeUrl} target="_blank" className="text-xs font-medium text-emerald-600 hover:text-emerald-700">View QR Code</a>
                                )}
                                <CopyButton text={`ICCID: ${esim.iccid}\nPackage: ${pkg.displayName || pkg.name}\nData: ${pkg.dataGB}GB\nValidity: ${pkg.validityDays} days`} label="Copy Details" />
                                {esim.deliveryStatus === 'NOT_SENT' ? (
                                  <form action={sendToCustomer}>
                                    <input type="hidden" name="esimId" value={esim.id} />
                                    <button type="submit" className="text-xs font-medium text-emerald-600 hover:text-emerald-700">Send to Customer</button>
                                  </form>
                                ) : (
                                  <span className="text-xs text-gray-400">Sent {esim.deliveredAt ? new Date(esim.deliveredAt).toLocaleDateString() : ''}</span>
                                )}
                              </>
                            ) : (
                              <form action={assignESIM} className="flex gap-1.5">
                                <input type="hidden" name="esimId" value={esim.id} />
                                <select name="customerId" required className="rounded-md border border-gray-200 px-2 py-1 text-xs">
                                  <option value="">Assign to...</option>
                                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                </select>
                                <button type="submit" className="text-xs font-medium text-emerald-600 hover:text-emerald-700">Assign</button>
                              </form>
                            )}
                          </div>
                        </td>
                      )}
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
