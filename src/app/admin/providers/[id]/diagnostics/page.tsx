import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { runProviderDiagnostics, type DiagnosticResult } from '@/lib/actions/provider-diagnostics'

export default async function ProviderDiagnosticsPage({
  params,
  searchParams,
}: {
  params: { id: string }
  searchParams?: { run?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const provider = await prisma.provider.findUnique({ where: { id: params.id } })
  if (!provider) redirect('/admin/providers?error=Provider+not+found')

  let results: DiagnosticResult[] | null = null
  if (searchParams?.run === 'true') {
    results = await runProviderDiagnostics(provider.id)
  }

  const passCount = results ? results.filter(r => r.status === 'pass').length : 0
  const failCount = results ? results.filter(r => r.status === 'fail' || r.status === 'error').length : 0

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href={`/admin/providers/${provider.id}`} className="text-sm text-cyan-600 hover:underline">← Back to Provider</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Diagnostics: {provider.name}</h2>
        <p className="text-gray-600">Run connection and capability tests</p>
      </div>

      <div className="mb-6 flex items-center gap-4">
        <Link
          href={`/admin/providers/${provider.id}/diagnostics?run=true`}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Run Diagnostics
        </Link>
        {results && (
          <div className="flex gap-3 text-sm">
            <span className="text-green-700">{passCount} passed</span>
            {failCount > 0 && <span className="text-red-700">{failCount} failed</span>}
            <span className="text-gray-500">{results.length} total tests</span>
          </div>
        )}
      </div>

      {results && results.length > 0 && (
        <div className="space-y-3">
          {results.map((r, i) => (
            <div key={i} className={`rounded-lg border p-4 ${
              r.status === 'pass' ? 'border-green-200 bg-green-50' :
              r.status === 'fail' ? 'border-red-200 bg-red-50' :
              r.status === 'error' ? 'border-red-300 bg-red-100' :
              'border-gray-200 bg-gray-50'
            }`}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                    r.status === 'pass' ? 'bg-green-500 text-white' :
                    r.status === 'fail' || r.status === 'error' ? 'bg-red-500 text-white' :
                    'bg-gray-400 text-white'
                  }`}>
                    {r.status === 'pass' ? '✓' : r.status === 'skip' ? '→' : '✕'}
                  </span>
                  <div>
                    <p className="font-medium text-gray-900">{r.test}</p>
                    <p className="text-sm text-gray-600">{r.message}</p>
                  </div>
                </div>
                {r.latencyMs !== undefined && (
                  <span className="text-xs text-gray-500">{r.latencyMs}ms</span>
                )}
              </div>
              {r.details && (
                <pre className="mt-2 overflow-x-auto rounded bg-white/50 p-2 text-xs font-mono text-gray-600">
                  {JSON.stringify(r.details, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}

      {!results && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-8 text-center">
          <p className="text-gray-500">Click "Run Diagnostics" to test this provider's connectivity and capabilities.</p>
        </div>
      )}
    </div>
  )
}
