import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import DebitForm from './debit-form'

export default async function DebitWalletPage({
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
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Debit Wallet</h2>
        <p className="text-gray-600">{business.name} — Current balance: ${Number(business.walletBalance).toFixed(2)}</p>
      </div>

      <div className="max-w-lg rounded-lg border bg-white p-6 shadow-sm">
        <DebitForm
          businessId={business.id}
          walletBalance={Number(business.walletBalance)}
        />

        <p className="mt-4 text-xs text-gray-500">
          A debit will deduct from the business wallet balance. A WalletTransaction record and AuditLog entry will be created.
        </p>
      </div>
    </div>
  )
}
