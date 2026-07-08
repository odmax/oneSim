import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'

export default async function AdminSupportPage({ searchParams }: { searchParams?: { status?: string; priority?: string; businessId?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.VIEW_SUPPORT)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const where: any = {}
  if (searchParams?.status) where.status = searchParams.status
  if (searchParams?.priority) where.priority = searchParams.priority
  if (searchParams?.businessId) where.businessId = searchParams.businessId

  const [tickets, openCount, urgentCount, pendingCount, resolvedToday, admins, businesses] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }],
      include: {
        business: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true } },
        _count: { select: { messages: true } },
      },
    }),
    prisma.supportTicket.count({ where: { status: 'OPEN' } }),
    prisma.supportTicket.count({ where: { priority: 'URGENT', status: { in: ['OPEN', 'PENDING'] } } }),
    prisma.supportTicket.count({ where: { status: 'PENDING' } }),
    prisma.supportTicket.count({ where: { status: 'RESOLVED', resolvedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }),
    prisma.user.findMany({ where: { role: 'INTERNAL_ADMIN', isActive: true }, select: { id: true, name: true } }),
    prisma.business.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ])

  const statusColors: Record<string, string> = { OPEN: 'bg-blue-50 text-blue-600', PENDING: 'bg-amber-50 text-amber-600', RESOLVED: 'bg-emerald-50 text-emerald-600', CLOSED: 'bg-gray-50 text-gray-500' }

  return (
    <div className="p-6 space-y-6">
      <div><h2 className="text-2xl font-bold text-gray-900">Support Queue</h2><p className="text-sm text-gray-600">Manage business support tickets</p></div>

      <div className="grid gap-4 grid-cols-4">
        <div className="rounded-lg border bg-white p-4 shadow-sm"><p className="text-xs font-medium text-gray-500 uppercase">Open</p><p className="mt-1 text-2xl font-bold text-blue-600">{openCount}</p></div>
        <div className="rounded-lg border bg-white p-4 shadow-sm"><p className="text-xs font-medium text-gray-500 uppercase">Urgent</p><p className="mt-1 text-2xl font-bold text-red-600">{urgentCount}</p></div>
        <div className="rounded-lg border bg-white p-4 shadow-sm"><p className="text-xs font-medium text-gray-500 uppercase">Pending (Client)</p><p className="mt-1 text-2xl font-bold text-amber-600">{pendingCount}</p></div>
        <div className="rounded-lg border bg-white p-4 shadow-sm"><p className="text-xs font-medium text-gray-500 uppercase">Resolved Today</p><p className="mt-1 text-2xl font-bold text-emerald-600">{resolvedToday}</p></div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {[{ key: '', label: 'All' }, { key: 'OPEN', label: 'Open' }, { key: 'PENDING', label: 'Pending' }, { key: 'URGENT', label: 'Urgent', p: 'URGENT' }, { key: 'RESOLVED', label: 'Resolved' }, { key: 'CLOSED', label: 'Closed' }].map(f => {
          const href = f.p ? `/admin/support?priority=${f.p}` : f.key ? `/admin/support?status=${f.key}` : '/admin/support'
          const active = f.p ? searchParams?.priority === f.p : f.key ? searchParams?.status === f.key : !searchParams?.status && !searchParams?.priority
          return <Link key={f.label} href={href} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${active ? 'bg-cyan-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{f.label}</Link>
        })}
        <form action="/admin/support" method="GET" className="flex gap-2">
          <select name="businessId" className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs">
            <option value="">All Businesses</option>
            {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button type="submit" className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700">Filter</button>
        </form>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Ticket</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Business</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Category</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Priority</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Assigned</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Messages</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Last Activity</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {tickets.length === 0 ? <tr><td colSpan={9} className="px-4 py-12 text-center text-sm text-gray-400">No tickets found.</td></tr> : tickets.map(t => (
              <tr key={t.id} className={`hover:bg-gray-50 ${t.priority === 'URGENT' ? 'bg-red-50/30' : ''}`}>
                <td className="px-4 py-3">
                  <p className="text-sm font-medium text-gray-900 truncate max-w-[200px]">{t.subject}</p>
                  <p className="text-xs text-gray-400 font-mono">{t.ticketNumber}</p>
                </td>
                <td className="px-4 py-3 text-sm text-gray-700">{t.business.name}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{t.category}</td>
                <td className="px-4 py-3"><span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[t.status]}`}>{t.status}</span></td>
                <td className="px-4 py-3 text-sm"><span className={`font-medium ${t.priority === 'URGENT' ? 'text-red-600' : t.priority === 'HIGH' ? 'text-orange-600' : 'text-gray-600'}`}>{t.priority}</span></td>
                <td className="px-4 py-3 text-sm text-gray-500">{t.assignedTo?.name || '—'}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{t._count.messages}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{t.lastMessageAt ? new Date(t.lastMessageAt).toLocaleString() : '—'}</td>
                <td className="px-4 py-3"><Link href={`/admin/support/tickets/${t.id}`} className="text-cyan-600 hover:underline text-sm">View</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}