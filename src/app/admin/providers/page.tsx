import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { toggleProviderStatus } from '@/lib/actions/providers'
import { restoreProvider } from '@/lib/actions/provider-lifecycle'
import { inferProviderCapabilities } from '@/lib/providers/capabilities'
import { ProviderSearchBar } from '@/components/admin/providers/ProviderSearchBar'
import { ProviderBalanceCell } from '@/components/admin/providers/ProviderBalanceCell'

function maskApiToken(token: string | null): string {
  if (!token || token.length <= 4) return token ? '••••' + token.slice(-4) : ''
  return '••••••••' + token.slice(-4)
}

function getAuthStatus(provider: { apiToken: string | null; lastSuccessfulConnection: Date | null; lastFailedConnection: Date | null; errorCount: number | null; lastError: string | null; config?: any }): { label: string; color: string; dot: string } {
  const hasLegacyToken = !!provider.apiToken
  const configToken = !!(provider.config as any)?.apiToken || !!(provider.config as any)?.token
  const hasAnyToken = hasLegacyToken || configToken

  if (provider.lastSuccessfulConnection && (!provider.lastFailedConnection || provider.lastSuccessfulConnection > provider.lastFailedConnection) && (provider.errorCount ?? 0) === 0) {
    return { label: 'Connected', color: 'text-green-700 bg-green-50', dot: '🟢' }
  }
  if (!hasAnyToken && !provider.lastSuccessfulConnection) {
    return { label: 'Not Configured', color: 'text-gray-600 bg-gray-100', dot: '⚪' }
  }
  if (provider.lastError?.includes('token') || provider.lastError?.includes('expired') || provider.lastError?.includes('401')) {
    return { label: 'Token Expired', color: 'text-red-700 bg-red-50', dot: '🔴' }
  }
  if (provider.lastFailedConnection) {
    return { label: 'Failed', color: 'text-red-700 bg-red-50', dot: '🔴' }
  }
  return { label: 'Configured', color: 'text-yellow-700 bg-yellow-50', dot: '🟡' }
}

export default async function AdminProvidersPage({ searchParams }: { searchParams?: { error?: string; success?: string; search?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PROVIDERS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const search = searchParams?.search?.trim().toLowerCase()
  const where = search ? {
    OR: [
      { name: { contains: search, mode: 'insensitive' as const } },
      { code: { contains: search, mode: 'insensitive' as const } },
      { adapterStrategy: { contains: search, mode: 'insensitive' as const } },
    ],
  } : {}
  const providers = await prisma.provider.findMany({ where, orderBy: { priority: 'asc' } })

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Providers</h2>
          <p className="text-gray-600">Manage eSIM provider integrations</p>
        </div>
        <div className="flex items-center gap-4">
          <ProviderSearchBar />
          <Link
            href="/admin/providers/new"
            className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
          >
            Add Provider
          </Link>
        </div>
      </div>

      {searchParams?.error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{decodeURIComponent(searchParams.error)}</div>
      )}
      {searchParams?.success && (
        <div className="mb-6 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">{decodeURIComponent(searchParams.success)}</div>
      )}

      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Priority</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Code</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Type</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Auth</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Environment</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Capabilities</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Balance</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Health</th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {providers.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-6 py-8 text-center text-sm text-gray-500">{search ? 'No providers match your search.' : 'No providers configured yet.'}</td>
              </tr>
            ) : providers.map((p) => {
              const auth = getAuthStatus(p)
              return (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-700">
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-gray-900">{p.priority}</span>
                    {p.isDefaultFallback && <span className="inline-flex rounded bg-amber-100 px-1.5 text-xs text-amber-700" title="Default Fallback Provider">DF</span>}
                  </div>
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm font-mono font-medium text-gray-900">{p.code}</td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-700">
                  <Link href={`/admin/providers/${p.id}`} className="text-cyan-600 hover:text-cyan-800 hover:underline">{p.name}</Link>
                </td>
                <td className="whitespace-nowrap px-6 py-4">
                  <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                    'bg-blue-100 text-blue-800'
                  }`}>{p.type}</span>
                </td>
                <td className="whitespace-nowrap px-6 py-4">
                  <span className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                    p.status === 'ACTIVE' ? 'bg-green-100 text-green-800' :
                    p.status === 'DEGRADED' ? 'bg-orange-100 text-orange-800' :
                    p.status === 'TESTING' ? 'bg-blue-100 text-blue-800' :
                    p.status === 'MAINTENANCE' ? 'bg-purple-100 text-purple-800' :
                    p.status === 'ARCHIVED' ? 'bg-gray-100 text-gray-800' :
                    'bg-red-100 text-red-800'
                  }`}>{p.status}</span>
                </td>
                <td className="whitespace-nowrap px-6 py-4">
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${auth.color}`}>
                    <span>{auth.dot}</span>
                    <span>{auth.label}</span>
                  </span>
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">{p.environment}</td>
                <td className="whitespace-nowrap px-6 py-4">
                  <div className="flex gap-1 flex-wrap">
                    {(() => {
                      const caps = inferProviderCapabilities(p)
                      const tags: { key: string; label: string; yes: boolean }[] = [
                        { key: 'eSIM', label: 'eSIM', yes: caps.supportsESIM },
                        { key: 'QR', label: 'QR', yes: caps.supportsQRCode },
                        { key: 'TopUp', label: 'TopUp', yes: caps.supportsTopUp },
                        { key: 'Usage', label: 'Usage', yes: caps.supportsUsage },
                        { key: 'Suspend', label: 'Suspend', yes: caps.supportsSuspend },
                        { key: 'Wallet', label: 'Wallet', yes: caps.supportsWallet },
                        { key: 'Renewals', label: 'Renew', yes: caps.supportsRenewals },
                      ]
                      return tags.filter(t => t.yes).map(t => (
                        <span key={t.key} className="inline-flex rounded bg-green-50 px-1.5 text-xs text-green-700">{t.label}</span>
                      ))
                    })()}
                  </div>
                </td>
                <td className="whitespace-nowrap px-6 py-4">
                  <ProviderBalanceCell providerId={p.id} providerCode={p.code} showCapability />
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm">
                  <div className="flex flex-col gap-0.5">
                    {p.lastSuccessfulConnection && <span className="text-xs text-green-600" title={`Last OK: ${p.lastSuccessfulConnection.toISOString()}`}>OK {p.lastSuccessfulConnection.toLocaleDateString()}</span>}
                    {p.errorCount != null && p.errorCount > 0 && <span className="text-xs text-red-600">{p.errorCount} errors</span>}
                    {!p.lastSuccessfulConnection && !p.errorCount && <span className="text-xs text-gray-400">No data</span>}
                  </div>
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm">
                  <div className="flex items-center gap-2">
                    <Link href={`/admin/providers/${p.id}`} className="text-cyan-600 hover:text-cyan-800 font-medium">View</Link>
                    <Link href={`/admin/providers/${p.id}/edit`} className="text-blue-600 hover:text-blue-800 font-medium">Edit</Link>
                    {p.status !== 'ARCHIVED' ? (
                      <form action={toggleProviderStatus.bind(null, p.id)} className="inline">
                        <button type="submit" className="font-medium text-gray-600 hover:text-gray-800">Cycle</button>
                      </form>
                    ) : (
                      <form action={restoreProvider} className="inline">
                        <input type="hidden" name="providerId" value={p.id} />
                        <button type="submit" className="font-medium text-emerald-600 hover:text-emerald-800">Restore</button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            )})}
          </tbody>
        </table>
      </div>
    </div>
  )
}
