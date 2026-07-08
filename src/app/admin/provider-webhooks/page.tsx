import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { processProviderWebhookEvent } from '@/lib/services/webhooks/provider-webhook-processor'
import Link from 'next/link'

export default async function AdminProviderWebhooksPage({ searchParams }: { searchParams: { page?: string; status?: string; providerType?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PROVIDERS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const page = parseInt(searchParams.page || '1')
  const limit = 50
  const statusFilter = searchParams.status
  const providerTypeFilter = searchParams.providerType

  const where: any = {}
  if (statusFilter) where.status = statusFilter
  if (providerTypeFilter) where.providerType = providerTypeFilter

  const [events, total] = await Promise.all([
    prisma.providerWebhookEvent.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      take: limit,
      skip: (page - 1) * limit,
    }),
    prisma.providerWebhookEvent.count({ where }),
  ])

  const totalPages = Math.ceil(total / limit)

  async function retryEvent(formData: FormData) {
    'use server'
    const eventId = formData.get('eventId') as string
    if (eventId) {
      await processProviderWebhookEvent(eventId)
    }
    redirect('/admin/provider-webhooks')
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Provider Webhook Events</h2>
          <p className="text-sm text-gray-600">Monitor inbound webhook events from providers like Choice and iBASIS</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 rounded-lg border bg-white p-4 shadow-sm">
        <form className="flex flex-wrap gap-3">
          <div className="min-w-[160px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">Provider</label>
            <select name="providerType" defaultValue={providerTypeFilter} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
              <option value="">All Providers</option>
              <option value="CHOICE">Choice</option>
              <option value="IBASIS">iBASIS</option>
              <option value="GENERIC">Generic</option>
            </select>
          </div>
          <div className="min-w-[160px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
            <select name="status" defaultValue={statusFilter} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
              <option value="">All Statuses</option>
              <option value="RECEIVED">Received</option>
              <option value="PROCESSED">Processed</option>
              <option value="FAILED">Failed</option>
              <option value="IGNORED">Ignored</option>
            </select>
          </div>
          <div className="flex items-end">
            <button type="submit" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700">Filter</button>
          </div>
        </form>
      </div>

      {/* Summary Cards */}
      <div className="mb-6 grid grid-cols-5 gap-3">
        {['RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED'].map((st) => (
          <div key={st} className="rounded-lg border bg-white p-3 text-center shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{st}</p>
            <p className="mt-1 text-xl font-bold text-gray-900">
              {st === 'RECEIVED' ? events.filter(e => e.status === 'RECEIVED').length :
               st === 'PROCESSED' ? events.filter(e => e.status === 'PROCESSED').length :
               st === 'FAILED' ? events.filter(e => e.status === 'FAILED').length :
               events.filter(e => e.status === 'IGNORED').length}
            </p>
          </div>
        ))}
        <div className="rounded-lg border bg-white p-3 text-center shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Total</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{total}</p>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Received</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Provider</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Event Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">ICCID/IMSI</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Error</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {events.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400">No webhook events received yet.</td></tr>
            ) : events.map((ev) => (
              <tr key={ev.id} className="hover:bg-gray-50">
                <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-600">{new Date(ev.receivedAt).toLocaleString()}</td>
                <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">{ev.providerType}</td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium">{ev.eventType}</span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs font-mono text-gray-600">
                  {ev.iccid && <div>{ev.iccid}</div>}
                  {ev.imsi && <div className="text-gray-400">{ev.imsi}</div>}
                  {!ev.iccid && !ev.imsi && <span className="text-gray-400 italic">—</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                    ev.status === 'PROCESSED' ? 'bg-green-100 text-green-800' :
                    ev.status === 'RECEIVED' ? 'bg-yellow-100 text-yellow-800' :
                    ev.status === 'FAILED' ? 'bg-red-100 text-red-800' :
                    'bg-gray-100 text-gray-800'
                  }`}>{ev.status}</span>
                </td>
                <td className="max-w-[200px] truncate px-4 py-3 text-xs text-red-600">{ev.errorMessage || '—'}</td>
                <td className="whitespace-nowrap px-4 py-3 text-xs">
                  <details className="inline-block">
                    <summary className="cursor-pointer text-cyan-600 hover:underline">View</summary>
                    <pre className="absolute z-10 mt-1 max-h-48 max-w-md overflow-auto rounded border bg-gray-900 p-2 text-xs text-green-300">{JSON.stringify(ev.payload, null, 2)}</pre>
                  </details>
                  {ev.status === 'FAILED' && (
                    <form action={retryEvent} className="ml-2 inline">
                      <input type="hidden" name="eventId" value={ev.id} />
                      <button type="submit" className="text-cyan-600 hover:underline">Retry</button>
                    </form>
                  )}
                  {ev.esimId && (
                    <Link href={`/admin/esims/${ev.esimId}`} className="ml-2 text-cyan-600 hover:underline">eSIM</Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex justify-center gap-2">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <Link key={p} href={`/admin/provider-webhooks?page=${p}${statusFilter ? `&status=${statusFilter}` : ''}${providerTypeFilter ? `&providerType=${providerTypeFilter}` : ''}`}
              className={`rounded px-3 py-1 text-sm ${p === page ? 'bg-cyan-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
              {p}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}