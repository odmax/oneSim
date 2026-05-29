import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createTopUpRequest } from '@/lib/actions/wallet-topup'
import CopyButton from '@/components/CopyButton'

export default async function TopUpPage({
  searchParams,
}: {
  searchParams?: { error?: string; success?: string; ref?: string; amount?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const businessId = session.user.businessId!
  const business = await prisma.business.findUnique({ where: { id: businessId } })
  if (!business) redirect('/login')

  const isSuccess = searchParams?.success === 'true'
  const creditRef = searchParams?.ref
  const amount = searchParams?.amount

  return (
    <div className="space-y-6">
      <Link href="/business/wallet" className="text-sm text-gray-500 hover:text-gray-700">← Back to Wallet</Link>

      {isSuccess && creditRef && amount ? (
        /* Confirmation view */
        <>
          <div className="rounded-xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
                <span className="text-2xl text-emerald-600">✓</span>
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">Credit Request Submitted</h2>
                <p className="text-sm text-gray-500">Your request is pending admin confirmation.</p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
            <h3 className="text-base font-semibold text-gray-900 mb-4">Request Details</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3">
                <span className="text-sm text-gray-500">Amount</span>
                <span className="text-lg font-bold text-gray-900">${parseFloat(amount).toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3">
                <span className="text-sm text-gray-500">Reference</span>
                <div className="flex items-center gap-2">
                  <code className="text-sm font-mono font-medium text-gray-900">{creditRef}</code>
                  <CopyButton text={creditRef} label="Copy ref" />
                </div>
              </div>
            </div>

            <div className="mt-5 rounded-lg bg-blue-50 p-4">
              <p className="text-sm text-blue-700">
                Your wallet will be credited once the admin processes this request.
              </p>
            </div>

            <Link
              href="/business/wallet"
              className="mt-5 inline-block rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm"
            >
              Back to Wallet
            </Link>
          </div>
        </>
      ) : (
        /* Request form */
        <>
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Request Credit</h2>
            <p className="mt-1 text-sm text-gray-500">Request additional credit for your account. An admin will process your request.</p>
          </div>

          {searchParams?.error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {searchParams.error === 'invalid_amount' && 'Please enter a valid positive amount.'}
              {searchParams.error === 'amount_too_large' && 'Amount exceeds maximum ($100,000).'}
            </div>
          )}

          <div className="max-w-lg">
            <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
              <div className="mb-5">
                <p className="text-sm text-gray-500">Current Balance</p>
                <p className="text-2xl font-bold text-gray-900">${business.walletBalance.toFixed(2)}</p>
              </div>

              <form action={createTopUpRequest} className="space-y-4">
                <div>
                  <label htmlFor="amount" className="block text-sm font-medium text-gray-700">Amount (USD)</label>
                  <div className="mt-1 relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                    <input
                      id="amount"
                      name="amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      max="100000"
                      required
                      placeholder="0.00"
                      className="block w-full rounded-lg border border-gray-200 pl-7 pr-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm"
                >
                  Submit Request
                </button>
              </form>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
