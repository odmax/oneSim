import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { getApiLogs, getApiLogSummary } from '@/lib/actions/api-logs'

export default async function AdminApiLogsPage({
  searchParams,
}: {
  searchParams?: { page?: string; businessId?: string; statusCode?: string; method?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const page = parseInt(searchParams?.page || '1', 10)
  const filters = {
    page,
    pageSize: 50,
    businessId: searchParams?.businessId || undefined,
    statusCode: searchParams?.statusCode ? parseInt(searchParams.statusCode) : undefined,
    method: searchParams?.method || undefined,
  }

  const { logs, total } = await getApiLogs(filters)
  const summary = await getApiLogSummary()

  const businesses = await prisma.business.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">API Request Logs</h2>
        <p className="text-gray-600">Monitor external API usage across businesses</p>
      </div>

      {/* Summary Cards */}
      <div className="mb-6 grid grid-cols-4 gap-4">
        <div className="rounded-lg border bg-blue-50 p-4">
          <p className="text-sm text-gray-600">Requests Today</p>
          <p className="text-2xl font-bold text-blue-700">{summary.requestsToday}</p>
        </div>
        <div className="rounded-lg border bg-red-50 p-4">
          <p className="text-sm text-gray-600">Failed Requests</p>
          <p className="text-2xl font-bold text-red-700">{summary.failedRequests}</p>
        </div>
        <div className="rounded-lg border bg-yellow-50 p-4">
          <p className="text-sm text-gray-600">Rate Limit Hits</p>
          <p className="text-2xl font-bold text-yellow-700">{summary.rateLimitHits}</p>
        </div>
        <div className="rounded-lg border bg-green-50 p-4">
          <p className="text-sm text-gray-600">Top Business</p>
          <p className="text-lg font-bold text-green-700 truncate">
            {summary.topBusinessList[0]?.name || '-'}
          </p>
          <p className="text-xs text-green-600">
            {summary.topBusinessList[0]?.count || 0} requests
          </p>
        </div>
      </div>

      {/* Top Businesses */}
      <div className="mb-6 rounded-lg border bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-700">Top Businesses by API Calls (Today)</h3>
        <div className="space-y-2">
          {summary.topBusinessList.map((b, i) => (
            <div key={b.businessId} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-gray-400">#{i + 1}</span>
                <span className="text-sm text-gray-900">{b.name}</span>
              </div>
              <span className="text-sm font-medium text-gray-700">{b.count} requests</span>
            </div>
          ))}
          {summary.topBusinessList.length === 0 && (
            <p className="text-sm text-gray-500">No API requests today.</p>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-3">
        <form className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-600">Business</label>
            <select name="businessId" className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm">
              <option value="">All</option>
              {businesses.map(b => (
                <option key={b.id} value={b.id} selected={filters.businessId === b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Status Code</label>
            <select name="statusCode" className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm">
              <option value="">All</option>
              <option value="200" selected={filters.statusCode === 200}>200 Success</option>
              <option value="400" selected={filters.statusCode === 400}>400 Bad Request</option>
              <option value="401" selected={filters.statusCode === 401}>401 Unauthorized</option>
              <option value="402" selected={filters.statusCode === 402}>402 Insufficient Balance</option>
              <option value="404" selected={filters.statusCode === 404}>404 Not Found</option>
              <option value="429" selected={filters.statusCode === 429}>429 Rate Limited</option>
              <option value="500" selected={filters.statusCode === 500}>500 Server Error</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Method</label>
            <select name="method" className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm">
              <option value="">All</option>
              <option value="GET" selected={filters.method === 'GET'}>GET</option>
              <option value="POST" selected={filters.method === 'POST'}>POST</option>
            </select>
          </div>
          <button type="submit" className="rounded bg-cyan-600 px-3 py-1.5 text-sm text-white hover:bg-cyan-700">Filter</button>
        </form>
      </div>

      {/* Logs Table */}
      <div className="rounded-lg border bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Time</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Business</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Method</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Path</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Duration</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">IP</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {logs.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-gray-500">No API logs yet.</td></tr>
              ) : (
                logs.map((log: any) => (
                  <tr key={log.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-500">{new Date(log.createdAt).toLocaleString()}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-sm text-gray-900">{log.business?.name || 'Unknown'}</td>
                    <td className="whitespace-nowrap px-3 py-2"><span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono">{log.method}</span></td>
                    <td className="max-w-xs truncate px-3 py-2 text-sm font-mono text-gray-600">{log.path}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <StatusCodeBadge code={log.statusCode} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-sm text-gray-600">{log.durationMs}ms</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-500">{log.ipAddress || '-'}</td>
                    <td className="max-w-xs truncate px-3 py-2 text-xs text-red-600">{log.errorMessage || '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-4 text-sm text-gray-500">{total} total log entries.</p>
    </div>
  )
}

function StatusCodeBadge({ code }: { code: number }) {
  const color = code < 300 ? 'bg-green-100 text-green-800' : code < 400 ? 'bg-blue-100 text-blue-800' : code < 500 ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{code}</span>
}
