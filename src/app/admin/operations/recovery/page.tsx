import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { deriveOperationalState } from '@/lib/services/operations/operational-classifier'

const PAGE_SIZE = 25

export default async function RecoveryQueuePage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const page = Math.max(1, parseInt(searchParams.page || '1', 10) || 1)
  const classification = searchParams.classification || undefined

  const where: any = {
    status: { in: ['FAILED', 'PROVIDER_RECONCILIATION', 'PARTIALLY_FULFILLED', 'PAYMENT_RESERVED', 'PENDING_PROVIDER', 'PROVIDER_ACCEPTED', 'RESERVED', 'FULFILLING', 'CREATED'] },
  }

  const [orders, total] = await Promise.all([
    prisma.eSIMPurchase.findMany({
      where,
      include: { business: { select: { name: true } }, package: { select: { displayName: true } } },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.eSIMPurchase.count({ where }),
  ])

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="space-y-4 p-6">
      <div>
        <Link href="/admin/operations" className="text-sm text-cyan-600 hover:underline">&larr; Operations</Link>
        <h2 className="mt-1 text-2xl font-bold text-gray-900">Recovery Queue</h2>
        <p className="text-sm text-gray-500">Orders requiring recovery or reconciliation</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href="/admin/operations/recovery" className={`rounded-full px-3 py-1 text-xs font-medium ${!classification ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>All</Link>
        <Link href="/admin/operations/recovery?classification=reconcile" className="rounded-full px-3 py-1 text-xs font-medium bg-purple-100 text-purple-700">Reconciling</Link>
        <Link href="/admin/operations/recovery?classification=retry" className="rounded-full px-3 py-1 text-xs font-medium bg-orange-100 text-orange-700">Retry Exhausted</Link>
        <Link href="/admin/operations/recovery?classification=resume" className="rounded-full px-3 py-1 text-xs font-medium bg-cyan-100 text-cyan-700">Finalization Pending</Link>
      </div>

      {orders.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">
          No orders require recovery at this time.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
            <table className="w-full">
              <thead className="bg-gray-50"><tr>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Order</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Business</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Retry</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Provider Evidence</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Recommended</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500"></th>
              </tr></thead>
              <tbody className="divide-y">
                {orders.map(o => {
                  const state = deriveOperationalState({
                    orderStatus: o.status, orderAgeMinutes: 0,
                    fulfilledQuantity: o.fulfilledQuantity ?? 0, requestedQuantity: o.quantity ?? 1,
                    esimCount: 0, walletState: 'NONE', walletAlerts: [],
                    maxRetries: o.maxRetries, retryCount: o.retryCount,
                    isReconciling: o.status === 'PROVIDER_RECONCILIATION',
                    isDeadLetteredCallback: false, hasUnprocessedWebhook: false,
                    hasProviderFulfillmentEvidence: Boolean((o as any).providerFulfillId),
                  })
                  return (
                    <tr key={o.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-xs font-mono">{o.id.slice(-8)}</td>
                      <td className="px-3 py-2 text-xs">{o.business?.name || '-'}</td>
                      <td className="px-3 py-2 text-xs">{o.status}</td>
                      <td className="px-3 py-2 text-xs">{o.retryCount}/{o.maxRetries}</td>
                      <td className="px-3 py-2 text-xs">{(o as any).providerFulfillId ? 'Yes' : 'No'}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{state.actionType}</td>
                      <td className="px-3 py-2 text-xs">
                        <Link href={`/admin/operations/orders/${o.id}`} className="text-cyan-600 hover:underline">View</Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>Page {page} of {totalPages} ({total} orders)</span>
            <div className="flex gap-2">
              {page > 1 && <Link href={`/admin/operations/recovery?page=${page - 1}`} className="rounded border px-3 py-1 hover:bg-gray-50">&larr; Previous</Link>}
              {page < totalPages && <Link href={`/admin/operations/recovery?page=${page + 1}`} className="rounded border px-3 py-1 hover:bg-gray-50">Next &rarr;</Link>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
