import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { stripPackageProviderFields } from '@/lib/analytics/safe-fields'
import { requiresTravelDateForPackage } from '@/lib/providers/travel-date-utils'
import { PackageBuyCard } from './PackageBuyCard'
import { SearchablePackageGrid } from './SearchablePackageGrid'

export default async function BuyESIMPage({
  searchParams
}: {
  searchParams: { error?: string }
}) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const packages = await prisma.eSIMPackage.findMany({
    where: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    orderBy: { priceUSD: 'asc' }
  })

  const providerPackageIds = [...new Set(packages.map(p => p.providerPackageId).filter((id): id is string => !!id))]
  const providerPackages = providerPackageIds.length
    ? await prisma.providerPackage.findMany({
        where: { id: { in: providerPackageIds } },
        select: { id: true, providerRawData: true },
      })
    : []
  const requiresTravelDateByPackage = new Map(providerPackages.map(pp => [pp.id, requiresTravelDateForPackage(pp)]))
  const packagesWithRequirement = packages.map(pkg => ({
    ...stripPackageProviderFields(pkg),
    requiresTravelDate: pkg.providerPackageId ? (requiresTravelDateByPackage.get(pkg.providerPackageId) ?? false) : false,
  }))

  const business = await prisma.business.findUnique({
    where: { id: session.user.businessId! },
    select: { walletBalance: true }
  })

  const walletBalance = parseFloat(business?.walletBalance.toString() || '0')

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Buy eSIM</h2>
        <p className="mt-1 text-sm text-gray-500">Choose a data plan that fits your needs</p>
      </div>

      {searchParams.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {searchParams.error === 'invalid_input' && 'Invalid quantity or package selection.'}
          {searchParams.error === 'package_not_found' && 'This package is no longer available.'}
          {searchParams.error === 'insufficient_balance' && 'Insufficient wallet balance. Please request credit before buying.'}
          {searchParams.error === 'business_suspended' && 'Your business account is suspended. Please contact support.'}
          {searchParams.error === 'travel_date_required' && 'This package requires a Travel Date. Please enter a valid date in YYYY-MM-DD format.'}
          {searchParams.error === 'invalid_travel_date' && 'Travel Date must be a valid date in YYYY-MM-DD format.'}
          {searchParams.error === 'provider_failed' && 'Provider could not provision this eSIM right now. Please contact support or try again later.'}
          {searchParams.error === 'purchase_failed' && 'Purchase failed. Please try again.'}
        </div>
      )}

      {/* Wallet summary */}
      <div className="rounded-xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-emerald-600 uppercase tracking-wider">Wallet Balance</p>
            <p className="mt-1 text-2xl font-bold text-gray-900">${walletBalance.toFixed(2)}</p>
          </div>
          <div className="rounded-full bg-emerald-100 px-4 py-2 text-xs font-medium text-emerald-700">
            {packages.length} packages available
          </div>
        </div>
      </div>

      {/* Package grid */}
      <SearchablePackageGrid packages={packagesWithRequirement} walletBalance={walletBalance} />
    </div>
  )
}
