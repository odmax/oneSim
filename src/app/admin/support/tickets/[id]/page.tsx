import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { addTicketMessage, updateTicketStatus, assignTicketTo, markMessagesAsRead } from '@/lib/actions/support/tickets'

export default async function AdminTicketDetail({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string; success?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: params.id },
    include: {
      business: { select: { id: true, name: true, contactEmail: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      assignedTo: { select: { id: true, name: true } },
      messages: { orderBy: { createdAt: 'asc' } },
      events: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  })
  if (!ticket) redirect('/admin/support')

  // Mark admin messages as read
  if (ticket.messages.some(m => m.senderType === 'BUSINESS_USER' && !m.readAt)) {
    await markMessagesAsRead(params.id)
  }

  const admins = await prisma.user.findMany({ where: { role: 'INTERNAL_ADMIN', isActive: true }, select: { id: true, name: true } })

  const statusColors: Record<string, string> = { OPEN: 'bg-blue-50 text-blue-600', PENDING: 'bg-amber-50 text-amber-600', RESOLVED: 'bg-emerald-50 text-emerald-600', CLOSED: 'bg-gray-50 text-gray-500' }
  const isClosed = ticket.status === 'CLOSED' || ticket.status === 'RESOLVED'

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link href="/admin/support" className="text-sm text-cyan-600 hover:underline">← Back to Support Queue</Link>

      {searchParams?.error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{searchParams.error}</div>}
      {searchParams?.success && <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-700">{searchParams.success}</div>}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main ticket area */}
        <div className="lg:col-span-2 space-y-6">
          <div className="rounded-lg border bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-gray-900">{ticket.subject}</h2>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[ticket.status]}`}>{ticket.status}</span>
                  <span className={`text-xs font-medium ${ticket.priority === 'URGENT' ? 'text-red-600' : ''}`}>{ticket.priority}</span>
                </div>
                <p className="mt-1 text-xs text-gray-500 font-mono">{ticket.ticketNumber} · {ticket.category} · Created {new Date(ticket.createdAt).toLocaleString()}</p>
              </div>
              <div className="flex gap-2">
                {!isClosed && <form action={updateTicketStatus.bind(null, params.id, 'RESOLVED')}><button type="submit" className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700">Resolve</button></form>}
                <form action={updateTicketStatus.bind(null, params.id, isClosed ? 'OPEN' : 'CLOSED')}>
                  <button type="submit" className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">{isClosed ? 'Reopen' : 'Close'}</button>
                </form>
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="space-y-4">
            {ticket.messages.map(msg => {
              const isAdmin = msg.senderType === 'ADMIN' || msg.senderType === 'SYSTEM'
              return (
                <div key={msg.id} className={`flex ${isAdmin ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-[75%] rounded-xl px-4 py-3 ${isAdmin ? 'bg-cyan-500 text-white rounded-bl-sm' : 'bg-gray-100 text-gray-900 rounded-br-sm'}`}>
                    <p className="text-sm whitespace-pre-wrap">{msg.message}</p>
                    <div className={`flex items-center gap-2 mt-1 ${isAdmin ? 'justify-start' : 'justify-end'}`}>
                      <span className={`text-xs ${isAdmin ? 'text-cyan-100' : 'text-gray-400'}`}>
                        {msg.senderType === 'ADMIN' ? 'You (Admin)' : msg.senderType === 'SYSTEM' ? 'System' : ticket.createdBy.name} · {new Date(msg.createdAt).toLocaleString()}
                      </span>
                      {msg.readAt && <span className="text-xs text-gray-400">Seen</span>}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Reply */}
          {!isClosed && (
            <div className="rounded-lg border bg-white p-6 shadow-sm">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Reply</h3>
              <form action={addTicketMessage.bind(null, params.id)} className="space-y-3">
                <textarea name="message" rows={3} required placeholder="Type your reply..." className="block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
                <button type="submit" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700">Send Reply</button>
              </form>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Details</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">Business</dt><dd className="font-medium text-gray-900">{ticket.business.name}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Created By</dt><dd className="text-gray-900">{ticket.createdBy.name}<br /><span className="text-xs text-gray-400">{ticket.createdBy.email}</span></dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Category</dt><dd className="text-gray-900">{ticket.category}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Priority</dt><dd className="text-gray-900">{ticket.priority}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Messages</dt><dd className="text-gray-900">{ticket.messages.length}</dd></div>
            </dl>
          </div>

          {/* Assign */}
          <div className="rounded-lg border bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Assignment</h3>
            <p className="text-xs text-gray-500 mb-2">Currently: {ticket.assignedTo?.name || 'Unassigned'}</p>
            <form action={assignTicketTo.bind(null, params.id, '')}>
              <select name="adminId" onChange={e => e.target.form?.requestSubmit()} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">Unassign</option>
                {admins.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </form>
          </div>

          {ticket.relatedEsimId && <div className="rounded-lg border bg-white p-5 shadow-sm"><h3 className="text-sm font-semibold text-gray-900 mb-2">Related</h3><Link href={`/admin/esims/${ticket.relatedEsimId}`} className="text-sm text-cyan-600 hover:underline">View eSIM</Link></div>}

          {/* Events */}
          <details className="rounded-lg border bg-white p-4">
            <summary className="cursor-pointer text-sm font-medium text-gray-700">Activity Log</summary>
            <div className="mt-3 space-y-1.5">
              {ticket.events.map(ev => (
                <div key={ev.id} className="flex justify-between text-xs text-gray-500">
                  <span>{ev.eventType.replace(/_/g, ' ')}</span>
                  <span>{new Date(ev.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}