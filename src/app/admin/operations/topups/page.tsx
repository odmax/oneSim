import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { TopUpReviewActions } from '@/components/admin/topups/TopUpReviewActions'

const PAGE_SIZE = 50

export default async function TopUpReviewPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const page = Math.max(1, parseInt(searchParams.page || '1', 10) || 1)
  const escalatedOnly = searchParams.escalated === '1'

  const where: any = { status: 'PENDING_REVIEW' }
  if (escalatedOnly) where.reconciliationEscalatedAt = { not: null }
  else where.reconciliationEscalatedAt = null

  const [rows, total] = await Promise.all([
    prisma.eSIMTopUp.findMany({
      where,
      include: {
        business: { select: { id: true, name: true } },
        esim: { select: { id: true, iccid: true } },
      },
      orderBy: escalatedOnly
        ? [{ reconciliationEscalatedAt: 'desc' as const }]
        : [{ reconciliationAttempts: 'asc' as const }, { createdAt: 'asc' as const }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.eSIMTopUp.count({ where }),
  ])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const now = Date.now()

  return (
    <div className="space-y-4 p-6">
      <div>
        <Link href="/admin/operations" className="text-sm text-cyan-600 hover:underline">&larr; Operations</Link>
        <h2 className="mt-1 text-2xl font-bold text-gray-900">Top-Up Review Queue</h2>
        <p className="text-sm text-gray-500">PENDING_REVIEW top-ups awaiting automated outcome reconciliation. Funds stay reserved until a confirmed result.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href="/admin/operations/topups" className={`rounded-full px-3 py-1 text-xs font-medium ${!escalatedOnly ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>Active</Link>
        <Link href="/admin/operations/topups?escalated=1" className={`rounded-full px-3 py-1 text-xs font-medium ${escalatedOnly ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>Escalated (manual review)</Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">
          No top-ups requiring review.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
            <table className="w-full">
              <thead className="bg-gray-50"><tr>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">TopUp</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Business</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">eSIM</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Amount</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Age</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Attempts</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Last Reconcile</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Last Error</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-gray-500">Action</th>
              </tr></thead>
              <tbody className="divide-y">
                {rows.map(r => (
                  <tr key={r.id} className={`hover:bg-gray-50 ${r.reconciliationEscalatedAt ? 'bg-red-50/50' : ''}`}>
                    <td className="px-3 py-2 text-xs font-mono">{r.id.slice(-8)}</td>
                    <td className="px-3 py-2 text-xs">{r.business?.name || '-'}</td>
                    <td className="px-3 py-2 text-xs font-mono">{r.esim?.iccid || r.esimId}</td>
                    <td className="px-3 py-2 text-xs">{Number(r.amount)} {r.currency}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.reconciliationEscalatedAt ? (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">ESCALATED</span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">PENDING_REVIEW</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{Math.floor((now - r.createdAt.getTime()) / 60000)}m</td>
                    <td className="px-3 py-2 text-xs">{r.reconciliationAttempts}</td>
                    <td className="px-3 py-2 text-xs">{r.lastReconcileAt ? new Date(r.lastReconcileAt).toISOString().slice(11, 19) + 'Z' : '-'}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{r.lastReconcileErrorCode || '-'}</td>
                    <td className="px-3 py-2 text-xs"><TopUpReviewActions topUpId={r.id} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>Page {page} of {totalPages} ({total} top-ups)</span>
            <div className="flex gap-2">
              {page > 1 && <Link href={`/admin/operations/topups?page=${page - 1}${escalatedOnly ? '&escalated=1' : ''}`} className="rounded border px-3 py-1 hover:bg-gray-50">&larr; Previous</Link>}
              {page < totalPages && <Link href={`/admin/operations/topups?page=${page + 1}${escalatedOnly ? '&escalated=1' : ''}`} className="rounded border px-3 py-1 hover:bg-gray-50">Next &rarr;</Link>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
