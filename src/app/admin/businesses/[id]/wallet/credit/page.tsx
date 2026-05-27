import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { adminCreditWallet } from '@/lib/actions/wallet'

export default async function CreditWalletPage({
  params,
}: {
  params: { id: string }
}) {
  const session = await getServerSession(authOptions)

  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }

  const business = await prisma.business.findUnique({
    where: { id: params.id },
    select: { id: true, name: true, walletBalance: true },
  })

  if (!business) {
    redirect('/admin/businesses')
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link
          href={`/admin/businesses/${business.id}`}
          className="text-sm text-blue-600 hover:underline"
        >
          ← Back to {business.name}
        </Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Credit Wallet</h2>
        <p className="text-gray-600">{business.name} — Current balance: ${Number(business.walletBalance).toFixed(2)}</p>
      </div>

      <div className="max-w-lg rounded-lg border bg-white p-6 shadow-sm">
        <form action={adminCreditWallet} className="space-y-4">
          <input type="hidden" name="businessId" value={business.id} />

          <div>
            <label htmlFor="amount" className="block text-sm font-medium text-gray-700">
              Amount ($)
            </label>
            <input
              id="amount"
              name="amount"
              type="number"
              step="0.01"
              min="0.01"
              required
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
              placeholder="0.00"
            />
          </div>

          <div>
            <label htmlFor="reason" className="block text-sm font-medium text-gray-700">
              Reason / Notes
            </label>
            <textarea
              id="reason"
              name="reason"
              required
              rows={3}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
              placeholder="Reason for crediting wallet"
            />
          </div>

          <div className="flex gap-4 pt-2">
            <button
              type="submit"
              className="rounded-lg bg-green-600 px-6 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              Credit Wallet
            </button>
            <Link
              href={`/admin/businesses/${business.id}`}
              className="rounded-lg bg-gray-100 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  )
}
