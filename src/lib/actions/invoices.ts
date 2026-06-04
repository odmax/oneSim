'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { handlePrismaError, handleServerActionError } from '@/lib/errors/handle-prisma-error'

function generateInvoiceNumber(): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `INV-${ts}-${rand}`
}

export async function generateInvoice(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const businessId = formData.get('businessId') as string
  const type = formData.get('type') as string || 'MANUAL'
  const currency = formData.get('currency') as string || 'USD'
  const dueDate = formData.get('dueDate') as string
  const notes = formData.get('notes') as string
  const markPaid = formData.get('markPaid') === 'on'
  const lineItemsRaw = formData.get('lineItems') as string

  if (!businessId) redirect('/admin/invoices/new?error=Business+required')
  if (!lineItemsRaw) redirect('/admin/invoices/new?error=Line+items+required')

  let lineItems: Array<{ description: string; quantity: number; unitPrice: number }>
  try {
    lineItems = JSON.parse(lineItemsRaw)
  } catch {
    redirect('/admin/invoices/new?error=Invalid+line+items')
  }

  if (lineItems.length === 0) redirect('/admin/invoices/new?error=At+least+one+line+item+required')

  const total = lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  if (total <= 0) redirect('/admin/invoices/new?error=Total+must+be+greater+than+0')

  let invoice: any
  try {
    invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: generateInvoiceNumber(),
        businessId,
        type,
        amount: total,
        currency,
        status: markPaid ? 'PAID' : 'DRAFT',
        dueDate: dueDate ? new Date(dueDate) : null,
        paidAt: markPaid ? new Date() : null,
        notes: notes || null,
        metadata: { lineItems },
      },
    })
  } catch (error: any) {
    redirect(`/admin/invoices/new?error=${encodeURIComponent(error.message || 'Failed to create invoice')}`)
  }

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'INVOICE_CREATED', entity: 'Invoice', entityId: invoice.id, details: `Invoice ${invoice.invoiceNumber} created for $${total}` },
  })

  revalidatePath('/admin/invoices')
  redirect(`/admin/invoices/${invoice.id}?success=Invoice+created`)
}

export async function markInvoicePaid(invoiceId: string) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
    if (!invoice) redirect('/admin/invoices?error=Invoice+not+found')
    if (invoice.status === 'PAID') redirect('/admin/invoices?error=Already+paid')

    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'PAID', paidAt: new Date() } })

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'INVOICE_PAID', entity: 'Invoice', entityId: invoiceId, details: `Invoice ${invoice.invoiceNumber || invoiceId} marked as paid` },
    })

    revalidatePath('/admin/invoices')
    redirect(`/admin/invoices/${invoiceId}?success=Invoice+marked+as+paid`)
  } catch (error: any) {
    handleServerActionError(error, '/admin/invoices', 'mark_paid_failed')
  }
}

export async function cancelInvoice(invoiceId: string) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
    if (!invoice) redirect('/admin/invoices?error=Invoice+not+found')
    if (invoice.status === 'PAID' || invoice.status === 'CANCELLED') redirect('/admin/invoices?error=Cannot+cancel')

    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'CANCELLED' } })

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'INVOICE_CANCELLED', entity: 'Invoice', entityId: invoiceId, details: `Invoice ${invoice.invoiceNumber || invoiceId} cancelled` },
    })

    revalidatePath('/admin/invoices')
    redirect(`/admin/invoices/${invoiceId}?success=Invoice+cancelled`)
  } catch (error: any) {
    handleServerActionError(error, '/admin/invoices', 'cancel_failed')
  }
}
