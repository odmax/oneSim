import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getChangeHistory, getChangeSetDetails, rollbackChangeSet } from '@/lib/actions/catalog-history'
import { RollbackButton } from './RollbackButton'

export default async function CatalogHistoryPage({ searchParams }: { searchParams?: { view?: string; page?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const page = parseInt(searchParams?.page || '1')
  const { sets, total, totalPages, limit } = await getChangeHistory(page)

  const details = searchParams?.view ? await getChangeSetDetails(searchParams.view) : null

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Catalog History</h2>
          <p className="text-gray-600">Audit trail of all bulk catalog changes</p>
        </div>
        <Link href="/admin/provider-catalog" className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
          ← Back to Catalog
        </Link>
      </div>

      {/* Details view */}
      {details && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold">{details.actionType}</h3>
            <div className="flex gap-2">
              <Link href="/admin/provider-catalog/history" className="rounded border border-gray-200 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50">Close</Link>
              {details.actionType !== 'ROLLBACK' && (
                <RollbackButton changeSetId={details.id} label={`Rollback ${details.totalChanged} packages?`} />
              )}
            </div>
          </div>
          <p className="text-xs text-gray-500 mb-3">By {details.createdBy?.name || 'Unknown'} · {new Date(details.createdAt).toLocaleString()} · {details.totalChanged} packages</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-gray-500"><th className="pb-1">Provider</th><th className="pb-1">Package</th><th className="pb-1">Data</th><th className="pb-1">Changes</th></tr></thead>
              <tbody>
                {details.items.map(item => {
                  const before = item.before as Record<string, any> || {}
                  const after = item.after as Record<string, any> || {}
                  const changes = Object.keys(before).filter(k => String(before[k]) !== String(after[k]))
                  return (
                    <tr key={item.id} className="border-t">
                      <td className="py-1 pr-2 text-gray-600">{item.pkg?.provider?.name || '—'}</td>
                      <td className="py-1 pr-2 text-gray-900">{item.pkg?.name || item.providerPackageId.slice(-8)}</td>
                      <td className="py-1 pr-2 text-gray-500">{item.pkg?.dataGB || '—'}GB /{item.pkg?.validityDays || '—'}d</td>
                      <td className="py-1">
                        {changes.length > 0 ? changes.map(f => (
                          <div key={f} className="text-gray-700">
                            <span className="text-gray-400">{f}:</span>{' '}
                            <span className="line-through text-red-400">{String(before[f])}</span>{' → '}
                            <span className="text-emerald-600">{String(after[f])}</span>
                          </div>
                        )) : <span className="text-gray-400">No changes</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* History list */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Action</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Description</th>
              <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Changed</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">By</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Date</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {sets.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-gray-400">No changes recorded yet.</td></tr>
            ) : sets.map(set => (
              <tr key={set.id} className="hover:bg-gray-50">
                <td className="px-3 py-3 text-sm font-medium text-gray-900">{set.actionType}</td>
                <td className="px-3 py-3 text-xs text-gray-500">{set.description || '—'}</td>
                <td className="px-3 py-3 text-xs text-center text-gray-600">{set.totalChanged}</td>
                <td className="px-3 py-3 text-xs text-gray-500">{set.createdBy?.name || '—'}</td>
                <td className="px-3 py-3 text-xs text-gray-500">{new Date(set.createdAt).toLocaleString()}</td>
                <td className="px-3 py-3">
                  <div className="flex gap-2">
                    <Link href={`/admin/provider-catalog/history?view=${set.id}`} className="text-xs text-cyan-600 hover:text-cyan-700">View</Link>
                    {set.actionType !== 'ROLLBACK' && (
                      <RollbackButton changeSetId={set.id} label="Rollback?" />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-gray-500">{total} changes · Page {page}/{totalPages}</span>
            <div className="flex gap-2">
              {page > 1 && <Link href={`/admin/provider-catalog/history?page=${page - 1}${searchParams?.view ? `&view=${searchParams.view}` : ''}`} className="rounded-lg border px-3 py-1 text-gray-600 hover:bg-gray-50">Prev</Link>}
              {page < totalPages && <Link href={`/admin/provider-catalog/history?page=${page + 1}${searchParams?.view ? `&view=${searchParams.view}` : ''}`} className="rounded-lg border px-3 py-1 text-gray-600 hover:bg-gray-50">Next</Link>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
