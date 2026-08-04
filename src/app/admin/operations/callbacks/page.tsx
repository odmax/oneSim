import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

const PAGE_SIZE = 25

export default async function CallbacksQueuePage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const page = Math.max(1, parseInt(searchParams.page || '1', 10) || 1)
  const status = searchParams.status || undefined
  const business = searchParams.business || undefined
  const eventType = searchParams.eventType || undefined

  const where: any = {}
  if (status) where.status = status
  if (eventType) where.eventType = eventType
  if (business) where.businessId = business

  const [deliveries, total] = await Promise.all([
    prisma.orderCallbackDelivery.findMany({
      where,
      include: { order: { select: { id: true } }, business: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
    }),
    prisma.orderCallbackDelivery.count({ where }),
  ])

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="space-y-4 p-6">
      <div>
        <Link href="/admin/operations" className="text-sm text-cyan-600 hover:underline">&larr; Operations</Link>
        <h2 className="mt-1 text-2xl font-bold text-gray-900">Callback Deliveries</h2>
        <p className="text-sm text-gray-500">Outbound business callback queue</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {['PENDING','RETRY_SCHEDULED','PROCESSING','DELIVERED','FAILED','DEAD_LETTERED','CANCELLED'].map(s => (
          <Link key={s} href={`/admin/operations/callbacks?status=${s}`} className={`rounded-full px-2.5 py-1 text-xs font-medium ${status === s ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{s}</Link>
        ))}
        <Link href="/admin/operations/callbacks" className={`rounded-full px-2.5 py-1 text-xs font-medium ${!status ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>All</Link>
      </div>

      {deliveries.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">No callback deliveries found.</div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
            <table className="w-full"><thead className="bg-gray-50"><tr>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Order</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Business</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Event</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Destination</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Status</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Attempts</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Last HTTP</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Next</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500"></th>
            </tr></thead>
            <tbody className="divide-y">
              {deliveries.map(d => {
                const hostname = (() => { try { return new URL(d.callbackUrl).hostname } catch { return d.callbackUrl.slice(0,30) } })()
                return (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-xs font-mono">{d.orderId.slice(-8)}</td>
                    <td className="px-3 py-2 text-xs">{d.business?.name || '-'}</td>
                    <td className="px-3 py-2 text-xs">{d.eventType}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{hostname}</td>
                    <td className="px-3 py-2 text-xs"><span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${d.status === 'DEAD_LETTERED' ? 'bg-red-100 text-red-700' : d.status === 'DELIVERED' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>{d.status}</span></td>
                    <td className="px-3 py-2 text-xs">{d.attemptCount}/{d.maxAttempts}</td>
                    <td className="px-3 py-2 text-xs">{d.lastHttpStatus || '-'}</td>
                    <td className="px-3 py-2 text-xs text-gray-400">{d.nextAttemptAt ? new Date(d.nextAttemptAt).toLocaleString() : '-'}</td>
                    <td className="px-3 py-2 text-xs">
                      <div className="flex gap-1">
                        {['DEAD_LETTERED','FAILED','RETRY_SCHEDULED'].includes(d.status) && (
                          <form action={async (fd: FormData) => { 'use server'; const { adminRetryCallback } = await import('@/lib/actions/operations-actions'); await adminRetryCallback(fd) }}>
                            <input type="hidden" name="deliveryId" value={d.id} />
                            <input type="hidden" name="orderId" value={d.orderId} />
                            <button type="submit" className="text-xs text-cyan-600 hover:underline">Retry</button>
                          </form>
                        )}
                        {['PENDING','RETRY_SCHEDULED'].includes(d.status) && (
                          <form action={async (fd: FormData) => { 'use server'; const { adminCancelCallback } = await import('@/lib/actions/operations-actions'); await adminCancelCallback(fd) }}>
                            <input type="hidden" name="deliveryId" value={d.id} />
                            <input type="hidden" name="orderId" value={d.orderId} />
                            <button type="submit" className="text-xs text-red-500 hover:underline" onClick={e => { if (!confirm('Cancel this callback?')) e.preventDefault() }}>Cancel</button>
                          </form>
                        )}
                        <Link href={`/admin/operations/orders/${d.orderId}`} className="text-xs text-gray-400 hover:underline">View</Link>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody></table>
          </div>
          <div className="flex justify-between text-xs text-gray-500">
            <span>Page {page}/{totalPages} ({total} total)</span>
            <div className="flex gap-2">
              {page > 1 && <Link href={`/admin/operations/callbacks?page=${page-1}${status ? `&status=${status}` : ''}`} className="rounded border px-3 py-1 hover:bg-gray-50">&larr; Prev</Link>}
              {page < totalPages && <Link href={`/admin/operations/callbacks?page=${page+1}${status ? `&status=${status}` : ''}`} className="rounded border px-3 py-1 hover:bg-gray-50">Next &rarr;</Link>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
