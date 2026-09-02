import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { stripPackageProviderFields } from '@/lib/analytics/safe-fields'
import { getEsimStatusLabel } from '@/lib/providers/capabilities/esim-action-availability'
import TopUpForm from './TopUpForm'

export default async function BusinessTopUpPage({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string; success?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const esim = await prisma.eSIM.findUnique({
    where: { id: params.id },
    include: {
      purchase: {
        include: {
          business: true,
          package: true,
        },
      },
      customer: true,
    },
  })

  if (!esim || esim.purchase.businessId !== session.user.businessId) redirect('/business/esims')

  const allowedStatuses = ['ACTIVE', 'PENDING_ACTIVATION', 'PENDING']
  const canTopUp = allowedStatuses.includes(esim.status) && !!esim.iccid

  // Find compatible top-up packages
  const originalPkg = esim.purchase.package
  const compatibleIds = originalPkg.compatibleTopUpPackageIds as string[] | null

  const topUpTypes: ('TOP_UP' | 'BOTH')[] = ['TOP_UP', 'BOTH']
  const topUpPackages = await prisma.eSIMPackage.findMany({
    where: {
      isActive: true,
      OR: [
        ...(compatibleIds?.length ? [{ id: { in: compatibleIds } }] : []),
        ...(!compatibleIds ? [
          { productType: { in: topUpTypes } },
          { providerId: originalPkg.providerId },
        ] : []),
      ],
    },
    orderBy: { priceUSD: 'asc' },
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/business/esims" className="text-sm text-emerald-600 hover:underline">← Back to eSIM Inventory</Link>
          <h2 className="mt-2 text-2xl font-bold text-gray-900">Top Up eSIM</h2>
          <p className="mt-1 text-sm text-gray-500 font-mono">{esim.iccid}</p>
        </div>
      </div>

      {searchParams?.success && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">
          Top-up successful! Your eSIM has been recharged.
        </div>
      )}

      {searchParams?.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {searchParams.error === 'insufficient_balance' && 'Insufficient wallet balance. Please request credit first.'}
          {searchParams.error === 'not_available' && 'Top-up is not available for this eSIM yet.'}
          {searchParams.error === 'provider_failed' && 'Provider could not process the top-up. No amount was deducted.'}
          {searchParams.error === 'invalid_package' && 'Selected package is not a valid top-up option.'}
          {searchParams.error !== 'insufficient_balance' && searchParams.error !== 'not_available' && searchParams.error !== 'provider_failed' && searchParams.error !== 'invalid_package' && searchParams.error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {canTopUp ? (
            <TopUpForm esimId={params.id} topUpPackages={JSON.parse(JSON.stringify(topUpPackages.map(stripPackageProviderFields)))} />
          ) : (
            <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-12 text-center">
              <p className="text-gray-500">Top-up is not available for this eSIM.</p>
              <p className="mt-1 text-xs text-gray-400">eSIM status must be ACTIVE or PENDING and must have an ICCID assigned.</p>
              <Link href="/business/esims" className="mt-4 inline-block text-sm font-medium text-emerald-600 hover:underline">
                Back to eSIM Inventory
              </Link>
            </div>
          )}
        </div>

        {/* eSIM Summary Card */}
        <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-gray-900">eSIM Summary</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Status</dt>
              <dd><span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${esim.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{getEsimStatusLabel(esim.status).label}</span></dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Package</dt>
              <dd className="font-medium text-gray-900">{originalPkg.displayName || originalPkg.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Data</dt>
              <dd className="font-medium text-gray-900">{originalPkg.dataGB} GB</dd>
            </div>
            {esim.expiresAt && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Expires</dt>
                <dd className="text-gray-900">{new Date(esim.expiresAt).toLocaleDateString()}</dd>
              </div>
            )}
            {esim.customer && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Customer</dt>
                <dd className="font-medium text-gray-900">{esim.customer.name}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </div>
  )
}