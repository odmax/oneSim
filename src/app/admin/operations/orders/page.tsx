import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { deriveOperationalState } from '@/lib/services/operations/operational-classifier'

const PAGE_SIZE = 25

export default async function OperationsOrderQueuePage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const page = Math.max(1, parseInt(searchParams.page || '1', 10) || 1)
  const status = searchParams.status || undefined
  const search = searchParams.search || undefined
  const partial = searchParams.partial === '1'
  const reconciliation = searchParams.reconciliation === '1'
  const actionRequired = searchParams.actionRequired === '1'

  const where: any = { status: { notIn: ['FULFILLED', 'REFUNDED'] } }
  if (status) where.status = status
  if (partial) where.status = 'PARTIALLY_FULFILLED'
  if (reconciliation) where.status = 'PROVIDER_RECONCILIATION'
  if (search) {
    where.OR = [
      { id: { contains: search, mode: 'insensitive' } },
      { purchase: { business: { name: { contains: search, mode: 'insensitive' } } } },
    ]
  }

  const [orders, total] = await Promise.all([
    prisma.eSIMPurchase.findMany({
      where,
      include: {
        business: { select: { name: true } },
        package: { select: { displayName: true, name: true } },
        provider: { select: { name: true, code: true } },
        esims: { select: { id: true, iccid: true } },
      },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.eSIMPurchase.count({ where }),
  ])

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const now = new Date()

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/admin/operations" className="text-sm text-cyan-600 hover:underline">&larr; Operations Overview</Link>
          <h2 className="mt-1 text-2xl font-bold text-gray-900">Order Work Queue</h2>
        </div>
      </div>

      {/* Quick filters */}
      <div className="flex flex-wrap gap-2">
        <Link href="/admin/operations/orders" className={`rounded-full px-3 py-1 text-xs font-medium ${!status && !partial && !reconciliation && !actionRequired ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>All Active</Link>
        <Link href="/admin/operations/orders?status=PENDING_PROVIDER" className={`rounded-full px-3 py-1 text-xs font-medium ${status === 'PENDING_PROVIDER' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Processing</Link>
        <Link href="/admin/operations/orders?reconciliation=1" className="rounded-full px-3 py-1 text-xs font-medium bg-purple-100 text-purple-700 hover:bg-purple-200">Reconciling</Link>
        <Link href="/admin/operations/orders?partial=1" className="rounded-full px-3 py-1 text-xs font-medium bg-amber-100 text-amber-700 hover:bg-amber-200">Partially Fulfilled</Link>
        <Link href="/admin/operations/orders?status=FAILED" className="rounded-full px-3 py-1 text-xs font-medium bg-red-100 text-red-700 hover:bg-red-200">Failed</Link>
        <Link href="/admin/operations/orders?actionRequired=1" className="rounded-full px-3 py-1 text-xs font-medium bg-red-200 text-red-900 hover:bg-red-300">Action Required</Link>
      </div>

      {orders.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">
          No matching orders found.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Order</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Business</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Fulfillment</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Provider</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Age</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {orders.map(o => {
                  const fulfilled = o.fulfilledQuantity ?? 0
                  const requested = o.quantity ?? 1
                  const ageMinutes = Math.round((now.getTime() - new Date(o.createdAt).getTime()) / 60000)
                  const state = deriveOperationalState({
                    orderStatus: o.status, orderAgeMinutes: ageMinutes,
                    fulfilledQuantity: fulfilled, requestedQuantity: requested,
                    esimCount: o.esims.length, walletState: 'NONE', walletAlerts: [],
                    maxRetries: o.maxRetries, retryCount: o.retryCount,
                    isReconciling: o.status === 'PROVIDER_RECONCILIATION',
                    isDeadLetteredCallback: false, hasUnprocessedWebhook: false,
                    hasProviderFulfillmentEvidence: !!(o as any).providerFulfillId,
                  })
                  return (
                    <tr key={o.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-xs font-mono text-gray-900">{o.id.slice(-8)}</td>
                      <td className="px-3 py-2 text-xs text-gray-700">{o.business?.name || '-'}</td>
                      <td className="px-3 py-2 text-xs">{o.status}</td>
                      <td className="px-3 py-2 text-xs text-gray-700">{fulfilled} / {requested}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{o.provider?.name || '-'}</td>
                      <td className="px-3 py-2 text-xs text-gray-400">{ageMinutes}m</td>
                      <td className="px-3 py-2 text-xs">
                        <Link href={`/admin/orders/${o.id}`} className="text-cyan-600 hover:underline">View</Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>Page {page} of {totalPages} ({total} orders)</span>
            <div className="flex gap-2">
              {page > 1 && <Link href={`/admin/operations/orders?page=${page - 1}${status ? `&status=${status}` : ''}${search ? `&search=${search}` : ''}`} className="rounded border px-3 py-1 hover:bg-gray-50">&larr; Previous</Link>}
              {page < totalPages && <Link href={`/admin/operations/orders?page=${page + 1}${status ? `&status=${status}` : ''}${search ? `&search=${search}` : ''}`} className="rounded border px-3 py-1 hover:bg-gray-50">Next &rarr;</Link>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
