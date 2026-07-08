import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    PAID: 'bg-emerald-50 text-emerald-600',
    DRAFT: 'bg-gray-50 text-gray-600',
    PENDING: 'bg-amber-50 text-amber-600',
    OVERDUE: 'bg-red-50 text-red-600',
    CANCELLED: 'bg-gray-100 text-gray-400',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[status] || 'bg-gray-50 text-gray-500'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${
        status === 'PAID' ? 'bg-emerald-400' :
        status === 'DRAFT' ? 'bg-gray-400' :
        status === 'OVERDUE' || status === 'CANCELLED' ? 'bg-red-400' : 'bg-amber-400'
      }`} />
      {status}
    </span>
  )
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
    </div>
  )
}

export default async function AdminInvoicesPage({ searchParams }: {
  searchParams?: { q?: string; status?: string; error?: string; success?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.VIEW_FINANCE)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const q = searchParams?.q?.trim()
  const statusFilter = searchParams?.status

  const where: any = {}
  if (statusFilter && ['DRAFT', 'PENDING', 'PAID', 'OVERDUE', 'CANCELLED'].includes(statusFilter)) {
    where.status = statusFilter
  }
  if (q) {
    where.OR = [
      { invoiceNumber: { contains: q, mode: 'insensitive' } },
      { id: { contains: q, mode: 'insensitive' } },
      { business: { name: { contains: q, mode: 'insensitive' } } },
    ]
  }

  const [invoices, totalAmount, paidAmount, pendingAmount, countAll] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: { business: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.invoice.aggregate({ _sum: { amount: true } }),
    prisma.invoice.aggregate({ where: { status: 'PAID' }, _sum: { amount: true } }),
    prisma.invoice.aggregate({ where: { status: { in: ['DRAFT', 'PENDING'] } }, _sum: { amount: true } }),
    prisma.invoice.count(),
  ])

  const hasFilters = !!q || !!statusFilter

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Invoices</h2>
          <p className="mt-1 text-sm text-gray-500">Manage billing and invoices</p>
        </div>
        <Link href="/admin/invoices/new" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
          Generate Invoice
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total Invoiced" value={`$${(totalAmount._sum.amount?.toString() || '0')}`} color="text-gray-900" />
        <StatCard label="Paid" value={`$${(paidAmount._sum.amount?.toString() || '0')}`} color="text-emerald-600" />
        <StatCard label="Pending" value={`$${(pendingAmount._sum.amount?.toString() || '0')}`} color="text-amber-600" />
        <StatCard label="Invoice Count" value={String(countAll)} color="text-blue-600" />
        <StatCard label="Overdue" value="—" color="text-red-600" />
      </div>

      <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
        <form method="GET" action="/admin/invoices" className="flex flex-wrap gap-3 items-end">
          <div className="min-w-[240px] flex-1">
            <label className="block text-xs font-medium text-gray-500 mb-1">Search</label>
            <input name="q" type="text" defaultValue={q || ''} placeholder="Invoice ID, business name..."
              className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
            <select name="status" defaultValue={statusFilter || ''}
              className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
              <option value="">All</option>
              <option value="DRAFT">Draft</option>
              <option value="PENDING">Pending</option>
              <option value="PAID">Paid</option>
              <option value="OVERDUE">Overdue</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          <button type="submit" className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">Search</button>
          {hasFilters && <Link href="/admin/invoices" className="rounded-lg border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Clear</Link>}
        </form>
      </div>

      {searchParams?.error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>}
      {searchParams?.success && <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">{decodeURIComponent(searchParams.success)}</div>}

      <p className="text-sm text-gray-500">{hasFilters ? `${invoices.length} result${invoices.length !== 1 ? 's' : ''} found` : `${invoices.length} invoice${invoices.length !== 1 ? 's' : ''}`}</p>

      {invoices.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No invoices found.</p>
          {hasFilters && <Link href="/admin/invoices" className="mt-3 inline-block text-sm font-medium text-emerald-600 hover:text-emerald-700">Clear filters →</Link>}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Invoice</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Business</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Type</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Amount</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Issued</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Due</th>
                  <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-5 py-4 text-sm font-mono text-gray-900">{inv.invoiceNumber || `#${inv.id.slice(-8)}`}</td>
                    <td className="px-5 py-4 text-sm text-gray-700">{inv.business.name}</td>
                    <td className="px-5 py-4 text-sm text-gray-500">{inv.type}</td>
                    <td className="px-5 py-4 text-sm font-semibold text-gray-900">${inv.amount.toString()}</td>
                    <td className="px-5 py-4"><StatusBadge status={inv.status} /></td>
                    <td className="px-5 py-4 text-sm text-gray-500">{new Date(inv.createdAt).toLocaleDateString()}</td>
                    <td className="px-5 py-4 text-sm text-gray-500">{inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : '—'}</td>
                    <td className="px-5 py-4">
                      <Link href={`/admin/invoices/${inv.id}`} className="rounded-md bg-gray-50 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
