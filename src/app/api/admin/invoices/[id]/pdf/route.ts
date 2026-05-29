import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: params.id },
    include: {
      business: { select: { id: true, name: true, contactEmail: true } },
    },
  })

  if (!invoice) return new NextResponse('Not found', { status: 404 })

  const lineItems = (invoice.metadata as any)?.lineItems || []
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://staging.onetelecom.cloud'

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Invoice ${invoice.invoiceNumber || params.id}</title>
<style>
  body { font-family: Arial, sans-serif; color: #1f2937; padding: 40px; font-size: 14px; }
  .header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 40px; }
  .title { font-size: 28px; font-weight: bold; color: #111827; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #ecfdf5; color: #059669; }
  .details { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 40px; }
  .section-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 40px; }
  th { text-align: left; padding: 8px 12px; font-size: 11px; text-transform: uppercase; color: #6b7280; background: #f9fafb; border-bottom: 1px solid #e5e7eb; }
  td { padding: 8px 12px; border-bottom: 1px solid #f3f4f6; }
  .total { text-align: right; font-size: 18px; font-weight: bold; margin-top: 20px; }
  .footer { margin-top: 60px; font-size: 12px; color: #9ca3af; text-align: center; }
</style></head><body>
  <div class="header">
    <div><h1 class="title">OneSim Africa</h1><p style="color:#6b7280;">eSIM Provider</p></div>
    <div style="text-align:right;">
      <p style="font-size:12px;color:#6b7280;">Invoice</p>
      <p style="font-weight:bold;font-size:18px;">${invoice.invoiceNumber || `#${params.id.slice(-8)}`}</p>
      <span class="badge">${invoice.status}</span>
    </div>
  </div>

  <div class="details">
    <div>
      <p class="section-title">Bill To</p>
      <p style="font-weight:600;">${invoice.business.name}</p>
      <p style="color:#6b7280;">${invoice.business.contactEmail}</p>
    </div>
    <div>
      <p class="section-title">Invoice Details</p>
      <p>Issued: ${new Date(invoice.createdAt).toLocaleDateString()}</p>
      ${invoice.dueDate ? `<p>Due: ${new Date(invoice.dueDate).toLocaleDateString()}</p>` : ''}
      ${invoice.paidAt ? `<p>Paid: ${new Date(invoice.paidAt).toLocaleDateString()}</p>` : ''}
      <p>Amount: $${invoice.amount.toString()}</p>
    </div>
  </div>

  ${lineItems.length > 0 ? `
  <table>
    <thead><tr><th>Description</th><th style="text-align:right;">Qty</th><th style="text-align:right;">Unit Price</th><th style="text-align:right;">Total</th></tr></thead>
    <tbody>
      ${lineItems.map((item: any) => `<tr><td>${item.description}</td><td style="text-align:right;">${item.quantity}</td><td style="text-align:right;">$${(item.unitPrice || 0).toFixed(2)}</td><td style="text-align:right;">$${(item.quantity * (item.unitPrice || 0)).toFixed(2)}</td></tr>`).join('')}
    </tbody>
  </table>
  ` : ''}

  <div class="total">Total: $${invoice.amount.toString()}</div>

  ${invoice.notes ? `<div style="margin-top:20px;padding:16px;background:#f9fafb;border-radius:8px;"><p style="font-weight:600;margin-bottom:4px;">Notes</p><p style="color:#6b7280;">${invoice.notes}</p></div>` : ''}

  <div class="footer">
    <p>OneSim Africa — ${baseUrl}</p>
    <p>Payment instructions: Bank transfer to OneSim Financial Services. Reference: ${invoice.invoiceNumber || params.id}</p>
  </div>
</body></html>`

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="invoice-${invoice.invoiceNumber || params.id}.html"`,
    },
  })
}
