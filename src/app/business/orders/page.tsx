import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

function OrderStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    COMPLETED: 'bg-emerald-50 text-emerald-600',
    PENDING_ACTIVATION: 'bg-amber-50 text-amber-600',
    PENDING: 'bg-amber-50 text-amber-600',
    FAILED: 'bg-red-50 text-red-600',
  }
  const labels: Record<string, string> = {
    PENDING_ACTIVATION: 'Pending Activation',
    PENDING: 'Pending Activation',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[status] || 'bg-gray-50 text-gray-500'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${
        status === 'COMPLETED' ? 'bg-emerald-400' :
        status === 'FAILED' ? 'bg-red-400' : 'bg-amber-400'
      }`} />
      {labels[status] || status}
    </span>
  )
}

export default async function OrdersPage() {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const purchases = await prisma.eSIMPurchase.findMany({
    where: { businessId: session.user.businessId! },
    include: {
      package: true,
      user: true,
      esims: true
    },
    orderBy: { createdAt: 'desc' }
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Orders</h2>
          <p className="mt-1 text-sm text-gray-500">View your purchase history</p>
        </div>
        <Link href="/business/buy-esim">
          <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
            New Order
          </button>
        </Link>
      </div>

      {purchases.length > 0 ? (
        <div className="space-y-4">
          {purchases.map((purchase) => (
            <div key={purchase.id} className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold text-gray-900">
                      {purchase.package.displayName || purchase.package.name}
                    </h3>
                    <OrderStatusBadge status={purchase.status} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-3 text-sm text-gray-500">
                    <span>Qty: {purchase.quantity}</span>
                    <span className="text-gray-300">·</span>
                    <span>{purchase.package.dataGB} GB</span>
                    <span className="text-gray-300">·</span>
                    <span>{purchase.package.validityDays} days</span>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-400">
                    Ordered by {purchase.user.name || purchase.user.email} on {new Date(purchase.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="ml-4 text-right">
                  <p className="text-lg font-bold text-gray-900">${purchase.totalAmount.toString()}</p>
                  <p className="mt-0.5 text-xs text-gray-400">
                    {purchase.esims.length} / {purchase.quantity} eSIMs
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No orders yet. Start by purchasing your first eSIM package!</p>
          <Link href="/business/buy-esim">
            <button className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
              Buy eSIMs
            </button>
          </Link>
        </div>
      )}
    </div>
  )
}
