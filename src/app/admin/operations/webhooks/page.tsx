import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

const PAGE_SIZE = 25

export default async function WebhooksQueuePage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const page = Math.max(1, parseInt(searchParams.page || '1', 10) || 1)
  const status = searchParams.status || undefined

  const where: any = {}
  if (status) where.status = status

  const [events, total] = await Promise.all([
    prisma.providerWebhookEvent.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
    }),
    prisma.providerWebhookEvent.count({ where }),
  ])

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="space-y-4 p-6">
      <div>
        <Link href="/admin/operations" className="text-sm text-cyan-600 hover:underline">&larr; Operations</Link>
        <h2 className="mt-1 text-2xl font-bold text-gray-900">Provider Webhooks</h2>
        <p className="text-sm text-gray-500">Inbound provider webhook event queue</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {['RECEIVED','PROCESSING','PROCESSED','FAILED','IGNORED'].map(s => (
          <Link key={s} href={`/admin/operations/webhooks?status=${s}`} className={`rounded-full px-2.5 py-1 text-xs font-medium ${status === s ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{s}</Link>
        ))}
        <Link href="/admin/operations/webhooks" className={`rounded-full px-2.5 py-1 text-xs font-medium ${!status ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>All</Link>
      </div>

      {events.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">No webhook events found.</div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
            <table className="w-full"><thead className="bg-gray-50"><tr>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Provider</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">External ID</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Event Type</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Status</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Received</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Error</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500"></th>
            </tr></thead>
            <tbody className="divide-y">
              {events.map(e => (
                <tr key={e.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-xs">{e.providerType}</td>
                  <td className="px-3 py-2 text-xs font-mono">{e.externalEventId?.slice(-12) || '-'}</td>
                  <td className="px-3 py-2 text-xs">{e.eventType}</td>
                  <td className="px-3 py-2 text-xs"><span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${e.status === 'FAILED' ? 'bg-red-100 text-red-700' : e.status === 'PROCESSED' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>{e.status}</span></td>
                  <td className="px-3 py-2 text-xs text-gray-400">{new Date(e.receivedAt).toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs text-red-500">{e.errorMessage?.slice(0, 60) || '-'}</td>
                  <td className="px-3 py-2 text-xs">
                    <div className="flex gap-1">
                      {['RECEIVED','FAILED'].includes(e.status) && (
                        <form action={async (fd: FormData) => { 'use server'; const { adminRequeueWebhook } = await import('@/lib/actions/operations-actions'); await adminRequeueWebhook(fd) }}>
                          <input type="hidden" name="eventId" value={e.id} />
                          <input type="hidden" name="orderId" value={e.esimId || ''} />
                          <button type="submit" className="text-xs text-cyan-600 hover:underline">Reprocess</button>
                        </form>
                      )}
                      {e.esimId && <Link href={`/admin/esims/${e.esimId}`} className="text-xs text-gray-400 hover:underline">eSIM</Link>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody></table>
          </div>
          <div className="flex justify-between text-xs text-gray-500">
            <span>Page {page}/{totalPages} ({total} total)</span>
            <div className="flex gap-2">
              {page > 1 && <Link href={`/admin/operations/webhooks?page=${page-1}${status ? `&status=${status}` : ''}`} className="rounded border px-3 py-1 hover:bg-gray-50">&larr; Prev</Link>}
              {page < totalPages && <Link href={`/admin/operations/webhooks?page=${page+1}${status ? `&status=${status}` : ''}`} className="rounded border px-3 py-1 hover:bg-gray-50">Next &rarr;</Link>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
