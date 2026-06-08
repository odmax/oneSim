import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createSupportTicket } from '@/lib/actions/support/tickets'

export default async function BusinessSupportPage({ searchParams }: { searchParams?: { error?: string; success?: string; status?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const statusFilter = searchParams?.status || ''
  const where: any = { businessId: session.user.businessId! }
  if (statusFilter && ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'].includes(statusFilter)) where.status = statusFilter

  const tickets = await prisma.supportTicket.findMany({
    where,
    orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
    include: { _count: { select: { messages: true } } },
  })

  const openCount = await prisma.supportTicket.count({ where: { businessId: session.user.businessId!, status: { in: ['OPEN', 'PENDING'] } } })

  // Get related data for create form
  const esims = await prisma.eSIM.findMany({ where: { purchase: { businessId: session.user.businessId! } }, select: { id: true, iccid: true }, take: 20 })
  const orders = await prisma.eSIMPurchase.findMany({ where: { businessId: session.user.businessId! }, select: { id: true, status: true }, orderBy: { createdAt: 'desc' }, take: 20 })
  const invoices = await prisma.invoice.findMany({ where: { businessId: session.user.businessId! }, select: { id: true, invoiceNumber: true }, orderBy: { createdAt: 'desc' }, take: 20 })

  const statusColors: Record<string, string> = { OPEN: 'bg-blue-50 text-blue-600', PENDING: 'bg-amber-50 text-amber-600', RESOLVED: 'bg-emerald-50 text-emerald-600', CLOSED: 'bg-gray-50 text-gray-500' }
  const priorityColors: Record<string, string> = { LOW: 'text-gray-500', MEDIUM: 'text-blue-600', HIGH: 'text-orange-600', URGENT: 'text-red-600' }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Support</h2>
          <p className="mt-1 text-sm text-gray-500">{openCount > 0 ? `${openCount} open ticket(s)` : 'No open tickets'}</p>
        </div>
        <Link href="/business/support/new" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">Create Ticket</Link>
      </div>

      {searchParams?.error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{searchParams.error}</div>}

      {/* Create ticket form */}
      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">New Support Ticket</h3>
        <form action={createSupportTicket} className="space-y-4">
          <div><label className="block text-sm font-medium text-gray-700">Subject *</label><input name="subject" required className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none" /></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700">Category</label>
              <select name="category" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm"><option value="GENERAL">General</option><option value="TECHNICAL">Technical</option><option value="BILLING">Billing</option><option value="WALLET">Wallet</option><option value="API">API</option><option value="ESIM_ACTIVATION">eSIM Activation</option><option value="TOPUP">Top-Up</option></select></div>
            <div><label className="block text-sm font-medium text-gray-700">Priority</label>
              <select name="priority" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm"><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select></div>
          </div>
          <div><label className="block text-sm font-medium text-gray-700">Message *</label><textarea name="message" rows={4} required className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none" /></div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className="block text-sm font-medium text-gray-700">Related eSIM</label>
              <select name="esimId" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm"><option value="">—</option>{esims.map(e => <option key={e.id} value={e.id}>{e.iccid}</option>)}</select></div>
            <div><label className="block text-sm font-medium text-gray-700">Related Order</label>
              <select name="orderId" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm"><option value="">—</option>{orders.map(o => <option key={o.id} value={o.id}>{o.id.slice(-8)} ({o.status})</option>)}</select></div>
            <div><label className="block text-sm font-medium text-gray-700">Related Invoice</label>
              <select name="invoiceId" className="mt-1 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm"><option value="">—</option>{invoices.map(inv => <option key={inv.id} value={inv.id}>{inv.invoiceNumber || inv.id.slice(-8)}</option>)}</select></div>
          </div>
          <button type="submit" className="rounded-lg bg-emerald-600 px-6 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">Submit Ticket</button>
        </form>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        {['', 'OPEN', 'PENDING', 'RESOLVED', 'CLOSED'].map(s => (
          <Link key={s} href={`/business/support${s ? `?status=${s}` : ''}`} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${s === statusFilter ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {s || 'All'}
          </Link>
        ))}
      </div>

      {/* Ticket list */}
      {tickets.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No support tickets yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tickets.map(t => {
            const lastMsg = t._count.messages
            return (
              <Link key={t.id} href={`/business/support/tickets/${t.id}`} className="block rounded-xl border border-gray-100 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold text-gray-900 truncate">{t.subject}</h3>
                      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[t.status] || 'bg-gray-50 text-gray-500'}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${t.status === 'OPEN' ? 'bg-blue-400' : t.status === 'PENDING' ? 'bg-amber-400' : t.status === 'RESOLVED' ? 'bg-emerald-400' : 'bg-gray-400'}`} />
                        {t.status}
                      </span>
                      <span className={`text-xs font-medium ${priorityColors[t.priority] || 'text-gray-500'}`}>{t.priority}</span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      <span className="font-mono">{t.ticketNumber}</span>
                      <span className="mx-2">·</span>
                      {t.category}
                      <span className="mx-2">·</span>
                      {lastMsg} message(s)
                      {t.lastMessageAt && <><span className="mx-2">·</span>Last: {new Date(t.lastMessageAt).toLocaleString()}</>}
                    </p>
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}