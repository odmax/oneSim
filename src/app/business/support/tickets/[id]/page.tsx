import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { addTicketMessage, updateTicketStatus, setTyping, markMessagesAsRead } from '@/lib/actions/support/tickets'

export default async function BusinessTicketDetail({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string; success?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: params.id },
    include: {
      messages: { orderBy: { createdAt: 'asc' }, include: { ticket: { select: { businessId: true } } } },
      events: { orderBy: { createdAt: 'desc' }, take: 10 },
    },
  })
  if (!ticket || ticket.businessId !== session.user.businessId) redirect('/business/support')

  // Mark as read
  if (ticket.messages.some(m => m.senderType !== 'BUSINESS_USER' && !m.readAt)) {
    await markMessagesAsRead(params.id)
  }

  const statusColors: Record<string, string> = { OPEN: 'bg-blue-50 text-blue-600', PENDING: 'bg-amber-50 text-amber-600', RESOLVED: 'bg-emerald-50 text-emerald-600', CLOSED: 'bg-gray-50 text-gray-500' }
  const isClosed = ticket.status === 'CLOSED' || ticket.status === 'RESOLVED'

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Link href="/business/support" className="text-sm text-emerald-600 hover:underline">← Back to Support</Link>

      {searchParams?.error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{searchParams.error}</div>}
      {searchParams?.success && <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">{searchParams.success}</div>}

      {/* Ticket Header */}
      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-gray-900">{ticket.subject}</h2>
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[ticket.status]}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${ticket.status === 'OPEN' ? 'bg-blue-400' : ticket.status === 'PENDING' ? 'bg-amber-400' : ticket.status === 'RESOLVED' ? 'bg-emerald-400' : 'bg-gray-400'}`} />
                {ticket.status}
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              <span className="font-mono">{ticket.ticketNumber}</span>
              <span className="mx-2">·</span>{ticket.category}
              <span className="mx-2">·</span>Priority: {ticket.priority}
              <span className="mx-2">·</span>Created: {new Date(ticket.createdAt).toLocaleString()}
            </p>
          </div>
          <div className="flex gap-2">
            {isClosed ? (
              <form action={updateTicketStatus.bind(null, params.id, 'OPEN')}>
                <button type="submit" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">Reopen</button>
              </form>
            ) : (
              <form action={updateTicketStatus.bind(null, params.id, 'CLOSED')}>
                <button type="submit" className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Close Ticket</button>
              </form>
            )}
          </div>
        </div>

        {ticket.relatedEsimId && <p className="text-sm text-gray-500">Related eSIM: <Link href={`/business/esims`} className="text-cyan-600 hover:underline">{ticket.relatedEsimId}</Link></p>}
        {ticket.relatedOrderId && <p className="text-sm text-gray-500">Related Order: {ticket.relatedOrderId}</p>}
      </div>

      {/* Messages */}
      <div className="space-y-4">
        {ticket.messages.map(msg => {
          const isClient = msg.senderType === 'BUSINESS_USER'
          return (
            <div key={msg.id} className={`flex ${isClient ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-xl px-4 py-3 ${isClient ? 'bg-emerald-500 text-white rounded-br-sm' : 'bg-gray-100 text-gray-900 rounded-bl-sm'}`}>
                <p className="text-sm whitespace-pre-wrap">{msg.message}</p>
                <div className={`flex items-center gap-2 mt-1 ${isClient ? 'justify-end' : 'justify-start'}`}>
                  <span className={`text-xs ${isClient ? 'text-emerald-100' : 'text-gray-400'}`}>
                    {msg.senderType === 'ADMIN' ? 'Support' : 'You'} · {new Date(msg.createdAt).toLocaleString()}
                  </span>
                  {msg.readAt && <span className={`text-xs ${isClient ? 'text-emerald-200' : 'text-gray-400'}`}>Seen</span>}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Reply form */}
      {!isClosed && (
        <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Add Reply</h3>
          <form action={addTicketMessage.bind(null, params.id)} className="space-y-3">
            <textarea name="message" rows={3} required placeholder="Type your message..." className="block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
            <button type="submit" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">Send Message</button>
          </form>
        </div>
      )}

      {/* Events */}
      <details className="rounded-xl border border-gray-100 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">Activity Log</summary>
        <div className="mt-3 space-y-2">
          {ticket.events.map(ev => (
            <div key={ev.id} className="flex justify-between text-xs text-gray-500">
              <span>{ev.eventType.replace(/_/g, ' ')}</span>
              <span>{new Date(ev.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}