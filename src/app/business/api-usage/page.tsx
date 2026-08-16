import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { getBusinessApiUsage } from '@/lib/actions/api-logs'

export default async function BusinessApiUsagePage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const businessId = session.user.businessId!
  // Tenant-scoped access: the action derives businessId from the authenticated
  // session and never accepts a caller-supplied tenant id.
  const { logs, requestsToday, failedToday, rateLimitHits } = await getBusinessApiUsage()

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { rateLimitPerMinute: true },
  })
  const rateLimit = business?.rateLimitPerMinute || 60

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">API Usage</h2>
        <p className="text-gray-600">Monitor your API request activity and rate limit status</p>
      </div>

      {/* Summary Cards */}
      <div className="mb-6 grid grid-cols-4 gap-4">
        <div className="rounded-lg border bg-blue-50 p-4">
          <p className="text-sm text-gray-600">Requests Today</p>
          <p className="text-2xl font-bold text-blue-700">{requestsToday}</p>
        </div>
        <div className="rounded-lg border bg-red-50 p-4">
          <p className="text-sm text-gray-600">Failed Requests</p>
          <p className="text-2xl font-bold text-red-700">{failedToday}</p>
        </div>
        <div className="rounded-lg border bg-yellow-50 p-4">
          <p className="text-sm text-gray-600">Rate Limited</p>
          <p className="text-2xl font-bold text-yellow-700">{rateLimitHits}</p>
        </div>
        <div className="rounded-lg border bg-green-50 p-4">
          <p className="text-sm text-gray-600">Rate Limit</p>
          <p className="text-2xl font-bold text-green-700">{rateLimit}/min</p>
        </div>
      </div>

      {/* API Requests Log */}
      <div className="rounded-lg border bg-white shadow-sm">
        <div className="border-b p-4">
          <h3 className="text-lg font-semibold text-gray-900">Recent API Requests</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Time</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Method</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Path</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Duration</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">
                    No API requests yet.
                  </td>
                </tr>
              ) : (
                logs.map((log: any) => (
                  <tr key={log.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-500">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono">{log.method}</span>
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-sm font-mono text-gray-600">{log.path}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <StatusCodeBadge code={log.statusCode} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">{log.durationMs}ms</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-500">{log.ipAddress || '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function StatusCodeBadge({ code }: { code: number }) {
  const color = code < 300 ? 'bg-green-100 text-green-800' : code < 400 ? 'bg-blue-100 text-blue-800' : code < 500 ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{code}</span>
}
