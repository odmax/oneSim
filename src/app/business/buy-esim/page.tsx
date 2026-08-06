import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { stripPackageProviderFields } from '@/lib/analytics/safe-fields'
import { requiresTravelDateForPackage } from '@/lib/providers/travel-date-utils'
import { CountrySearchPage } from './CountrySearchPage'
import { buildPackageSearchText } from '@/lib/packages/search-text'
import { queryPurchasablePackages } from '@/lib/packages/query-purchasable'

export default async function BuyESIMPage({
  searchParams
}: {
  searchParams: { error?: string }
}) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  // Shared query — identical to /api/v1/packages
  const readyPackages = await queryPurchasablePackages()

  const packagesWithRequirement = readyPackages.map(pkg => {
    const searchText = buildPackageSearchText(pkg)
    const requiresTravelDate = pkg.providerPackage ? requiresTravelDateForPackage(pkg.providerPackage) : false
    const stripped = stripPackageProviderFields(pkg)
    delete (stripped as any).providerPackage
    // Use snapshot-based selling price — authoritative source of truth
    const snapshotPrice = pkg.providerPackage?.sellingPrice
    const unitPrice = snapshotPrice ? Number(snapshotPrice) : parseFloat(pkg.priceUSD.toString())
    return { ...stripped, _searchText: searchText, requiresTravelDate, unitPrice, currency: pkg.currency || 'USD' }
  })

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
          {searchParams.error === 'package_pricing_unavailable' && 'This eSIM package is not yet available for purchase.'}
          {searchParams.error === 'quote_required' && 'Please refresh the package price and try again.'}
          {searchParams.error === 'quote_expired' && 'Your quote has expired. Please try again.'}
          {searchParams.error === 'quote_already_used' && 'This purchase request has already been processed.'}
          {searchParams.error === 'temporarily_unavailable' && 'This eSIM package is temporarily unavailable.'}
          {searchParams.error === 'order_creation_failed' && 'We could not create the order. Please try again.'}
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
            {readyPackages.length} packages available
          </div>
        </div>
      </div>

      {/* Package grid */}
      <CountrySearchPage packages={packagesWithRequirement} walletBalance={walletBalance} />
    </div>
  )
}
