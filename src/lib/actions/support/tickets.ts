'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { handlePrismaError } from '@/lib/errors/handle-prisma-error'

function generateTicketNumber(): string {
  const ts = Date.now().toString(36).toUpperCase().slice(-6)
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase()
  return `TKT-${ts}-${rand}`
}

export async function createSupportTicket(formData: FormData) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

    const subject = formData.get('subject') as string
    const category = formData.get('category') as string || 'GENERAL'
    const priority = formData.get('priority') as string || 'MEDIUM'
    const message = formData.get('message') as string
    const esimId = formData.get('esimId') as string
    const orderId = formData.get('orderId') as string
    const invoiceId = formData.get('invoiceId') as string

    if (!subject || !message) redirect('/business/support?error=Subject+and+message+required')

    // Validate related records belong to business
    if (esimId) {
      const esim = await prisma.eSIM.findFirst({ where: { id: esimId, purchase: { businessId: session.user.businessId! } } })
      if (!esim) redirect('/business/support?error=Invalid+related+eSIM')
    }
    if (orderId) {
      const order = await prisma.eSIMPurchase.findFirst({ where: { id: orderId, businessId: session.user.businessId! } })
      if (!order) redirect('/business/support?error=Invalid+related+order')
    }
    if (invoiceId) {
      const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, businessId: session.user.businessId! } })
      if (!invoice) redirect('/business/support?error=Invalid+related+invoice')
    }

    const ticket = await prisma.$transaction(async (tx) => {
      const t = await tx.supportTicket.create({
        data: {
          ticketNumber: generateTicketNumber(),
          businessId: session.user.businessId!,
          createdById: session.user.id,
          subject, category, priority,
          relatedEsimId: esimId || null,
          relatedOrderId: orderId || null,
          relatedInvoiceId: invoiceId || null,
          lastMessageAt: new Date(),
        },
      })

      await tx.supportMessage.create({
        data: { ticketId: t.id, senderId: session.user.id, senderType: 'BUSINESS_USER', message },
      })

      await tx.supportTicketEvent.create({
        data: { ticketId: t.id, actorId: session.user.id, eventType: 'TICKET_CREATED', metadata: { subject, category, priority } },
      })

      return t
    })

    revalidatePath('/business/support')
    redirect(`/business/support/tickets/${ticket.id}`)
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    const { message } = handlePrismaError(error, 'Failed to create ticket')
    redirect(`/business/support?error=${encodeURIComponent(message)}`)
  }
}

export async function addTicketMessage(ticketId: string, formData: FormData) {
  try {
    const session = await getServerSession(authOptions)
    if (!session) redirect('/login')

    const message = formData.get('message') as string
    if (!message) redirect(`/business/support/tickets/${ticketId}?error=Message+required`)

    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } })
    if (!ticket) redirect('/business/support?error=Ticket+not+found')

    // Permission check
    if (session.user.role === 'BUSINESS_USER' && ticket.businessId !== session.user.businessId) {
      redirect('/business/support?error=Forbidden')
    }

    const senderType = session.user.role === 'INTERNAL_ADMIN' ? 'ADMIN' : 'BUSINESS_USER'

    const updatedTicket = await prisma.$transaction(async (tx) => {
      const msg = await tx.supportMessage.create({
        data: { ticketId, senderId: session.user.id, senderType, message },
      })

      // Auto-reopen if resolved/closed and client replies
      const newStatus = senderType === 'BUSINESS_USER' && (ticket.status === 'RESOLVED' || ticket.status === 'CLOSED') ? 'OPEN' : ticket.status

      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { lastMessageAt: new Date(), status: newStatus },
      })

      await tx.supportTicketEvent.create({
        data: { ticketId, actorId: session.user.id, eventType: 'MESSAGE_SENT', metadata: { senderType, message: message.substring(0, 100) } },
      })

      if (newStatus !== ticket.status) {
        await tx.supportTicketEvent.create({
          data: { ticketId, actorId: session.user.id, eventType: 'STATUS_CHANGED', metadata: { from: ticket.status, to: newStatus } },
        })
      }

      return newStatus
    })

    if (session.user.role === 'INTERNAL_ADMIN') {
      revalidatePath(`/admin/support/tickets/${ticketId}`)
      redirect(`/admin/support/tickets/${ticketId}`)
    }
    revalidatePath(`/business/support/tickets/${ticketId}`)
    redirect(`/business/support/tickets/${ticketId}`)
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    const { message } = handlePrismaError(error, 'Failed to send message')
    redirect(`/business/support/tickets/${ticketId}?error=${encodeURIComponent(message)}`)
  }
}

export async function updateTicketStatus(ticketId: string, status: string) {
  try {
    const session = await getServerSession(authOptions)
    if (!session) redirect('/login')

    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } })
    if (!ticket) redirect('/business/support?error=Ticket+not+found')

    if (session.user.role === 'BUSINESS_USER' && ticket.businessId !== session.user.businessId) {
      redirect('/business/support?error=Forbidden')
    }

    const oldStatus = ticket.status
    const now = status === 'CLOSED' ? new Date() : null

    await prisma.$transaction(async (tx) => {
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { status, closedAt: now, resolvedAt: status === 'RESOLVED' ? new Date() : undefined },
      })
      await tx.supportTicketEvent.create({
        data: { ticketId, actorId: session.user.id, eventType: status === 'CLOSED' ? 'TICKET_CLOSED' : status === 'RESOLVED' ? 'STATUS_CHANGED' : status === 'OPEN' ? 'TICKET_REOPENED' : 'STATUS_CHANGED', metadata: { from: oldStatus, to: status } },
      })
    })

    if (session.user.role === 'INTERNAL_ADMIN') {
      revalidatePath(`/admin/support/tickets/${ticketId}`)
      redirect(`/admin/support/tickets/${ticketId}?success=Status+updated`)
    }
    revalidatePath(`/business/support/tickets/${ticketId}`)
    redirect(`/business/support/tickets/${ticketId}?success=Status+updated`)
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    const { message } = handlePrismaError(error, 'Failed to update ticket')
    redirect(`/business/support/tickets/${ticketId}?error=${encodeURIComponent(message)}`)
  }
}

export async function assignTicketTo(ticketId: string, formData: FormData) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

    const adminId = formData.get('adminId') as string
    const resolvedAdminId = !adminId || adminId === '__unassign__' ? null : adminId

    await prisma.$transaction(async (tx) => {
      const old = await tx.supportTicket.findUnique({ where: { id: ticketId }, select: { assignedToId: true } })
      await tx.supportTicket.update({ where: { id: ticketId }, data: { assignedToId: resolvedAdminId } })
      await tx.supportTicketEvent.create({
        data: { ticketId, actorId: session.user.id, eventType: 'ASSIGNED', metadata: { from: old?.assignedToId || null, to: resolvedAdminId } },
      })
    })

    revalidatePath(`/admin/support/tickets/${ticketId}`)
    redirect(`/admin/support/tickets/${ticketId}?success=Assigned`)
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    const { message } = handlePrismaError(error, 'Failed to assign ticket')
    redirect(`/admin/support/tickets/${ticketId}?error=${encodeURIComponent(message)}`)
  }
}

export async function setTyping(ticketId: string, isTyping: boolean) {
  try {
    const session = await getServerSession(authOptions)
    if (!session) return

    await prisma.supportTypingState.upsert({
      where: { ticketId_userId: { ticketId, userId: session.user.id } },
      update: { isTyping, updatedAt: new Date() },
      create: { ticketId, userId: session.user.id, isTyping },
    })
  } catch { /* best-effort */ }
}

export async function markMessagesAsRead(ticketId: string) {
  try {
    const session = await getServerSession(authOptions)
    if (!session) return

    await prisma.supportMessage.updateMany({
      where: { ticketId, senderId: { not: session.user.id }, readAt: null },
      data: { readAt: new Date() },
    })
  } catch { /* best-effort */ }
}