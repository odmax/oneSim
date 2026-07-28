import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getJobAnalytics } from '@/lib/services/operations/operations-service'

export default async function OpsJobsPage() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/admin')

  const [analytics, recentJobs] = await Promise.all([
    getJobAnalytics(),
    prisma.backgroundJob.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
  ])

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-gray-900 mb-4">Background Job Monitor</h1>

      <div className="grid grid-cols-4 gap-3 mb-6">
        {Object.entries(analytics.byStatus).map(([status, count]) => (
          <div key={status} className="rounded-lg border bg-white p-4">
            <div className="text-xs text-gray-500">{status}</div>
            <div className="text-2xl font-bold text-gray-900">{count}</div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border bg-white shadow-sm">
        <div className="px-6 py-3 border-b">
          <h2 className="text-sm font-semibold text-gray-900">Recent Jobs ({recentJobs.length})</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Type</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Status</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Attempts</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Created</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {recentJobs.map(j => (
                <tr key={j.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-xs">{j.type}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${j.status === 'COMPLETED' ? 'bg-green-100 text-green-700' : j.status === 'FAILED' ? 'bg-red-100 text-red-700' : j.status === 'PROCESSING' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>{j.status}</span>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">{j.attempts}/{j.maxAttempts}</td>
                  <td className="px-4 py-2 text-xs text-gray-400">{j.createdAt.toLocaleString()}</td>
                  <td className="px-4 py-2 text-xs text-red-500 max-w-xs truncate">{j.lastError || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
