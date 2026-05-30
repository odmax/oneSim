import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createTopUpOrder } from '@/lib/services/orders/top-up-order'

export default async function AdminTopUpPage({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string; success?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

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

  if (!esim) redirect('/admin/esims')

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

  async function handleTopUp(formData: FormData) {
    'use server'
    const pkgId = formData.get('packageId') as string
    if (!pkgId) redirect(`/admin/esims/${params.id}/top-up?error=no_package`)

    if (!esim) redirect('/admin/esims')
    const result = await createTopUpOrder({
      businessId: esim.purchase.businessId,
      userId: session!.user.id,
      esimId: params.id,
      topUpPackageId: pkgId,
      quantity: 1,
    })

    if (result.success) {
      redirect(`/admin/esims/${params.id}/top-up?success=true`)
    } else {
      let msg = 'provider_failed'
      if (result.error?.includes('wallet') || result.error?.includes('Insufficient')) msg = 'insufficient_balance'
      else if (result.error?.includes('top-up') || result.error?.includes('Top-up')) msg = 'not_available'
      redirect(`/admin/esims/${params.id}/top-up?error=${msg}`)
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href={`/admin/esims/${params.id}`} className="text-sm text-cyan-600 hover:underline">← Back to eSIM Detail</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Top Up eSIM</h2>
        <p className="text-sm text-gray-600 font-mono">{esim.iccid}</p>
      </div>

      {searchParams?.success && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">Top-up completed successfully.</div>
      )}
      {searchParams?.error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {searchParams.error === 'insufficient_balance' ? 'Insufficient wallet balance.' :
           searchParams.error === 'not_available' ? 'Top-up not available for this eSIM.' :
           'Provider failed. No amount deducted.'}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <form action={handleTopUp} className="rounded-lg border bg-white p-6 shadow-sm">
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Select Top-Up Bundle</h3>

            {topUpPackages.length === 0 ? (
              <div className="rounded-lg border-2 border-dashed border-gray-200 p-8 text-center text-sm text-gray-500">
                No compatible top-up packages found. Configure a TOP_UP or BOTH product type package with the same provider.
              </div>
            ) : (
              <div className="mb-6 space-y-3">
                {topUpPackages.map((pkg) => (
                  <label key={pkg.id} className="flex cursor-pointer items-center gap-4 rounded-lg border border-gray-200 p-4 hover:border-gray-300 transition-colors">
                    <input type="radio" name="packageId" value={pkg.id} className="h-4 w-4 text-cyan-600" />
                    <div className="flex-1">
                      <p className="font-medium text-gray-900">{pkg.displayName || pkg.name}</p>
                      <p className="text-sm text-gray-500">{pkg.dataGB} GB — {pkg.validityDays} days</p>
                    </div>
                    <p className="text-lg font-bold text-gray-900">${parseFloat(pkg.priceUSD.toString()).toFixed(2)}</p>
                  </label>
                ))}
              </div>
            )}

            <div className="mb-4 rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
              <span className="font-medium">Business:</span> {esim.purchase.business.name} &middot;
              <span className="font-medium"> Wallet Balance:</span> ${parseFloat(esim.purchase.business.walletBalance.toString()).toFixed(2)}
            </div>

            <button type="submit" disabled={topUpPackages.length === 0}
              className="w-full rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50 shadow-sm">
              Process Top-Up
            </button>
            <p className="mt-2 text-xs text-gray-400">If the provider fails, no amount will be deducted from the wallet.</p>
          </form>
        </div>

        {/* eSIM Summary */}
        <div className="rounded-lg border bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-gray-900">eSIM Summary</h3>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">ICCID</dt><dd className="font-mono text-xs text-gray-900">{esim.iccid}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Status</dt><dd><span className="inline-flex rounded-full px-2 text-xs font-semibold leading-5 bg-emerald-100 text-emerald-800">{esim.status}</span></dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Package</dt><dd className="text-gray-900">{originalPkg.name}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Data</dt><dd className="text-gray-900">{originalPkg.dataGB} GB</dd></div>
            {esim.expiresAt && <div className="flex justify-between"><dt className="text-gray-500">Expires</dt><dd className="text-gray-900">{new Date(esim.expiresAt).toLocaleDateString()}</dd></div>}
            {esim.customer && <div className="flex justify-between"><dt className="text-gray-500">Customer</dt><dd className="text-gray-900">{esim.customer.name}</dd></div>}
          </dl>
        </div>
      </div>
    </div>
  )
}