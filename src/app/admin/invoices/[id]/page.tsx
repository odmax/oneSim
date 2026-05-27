import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { markInvoicePaid, cancelInvoice } from '@/lib/actions/invoices'

export default async function InvoiceDetailPage({ params, searchParams }: { params: { id: string }; searchParams?: { error?: string; success?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const invoice = await prisma.invoice.findUnique({
    where: { id: params.id },
    include: {
      business: { select: { id: true, name: true, contactEmail: true } },
      purchase: { include: { package: true } },
    },
  })
  if (!invoice) redirect('/admin/invoices')

  const lineItems = (invoice.metadata as any)?.lineItems || []
  const status = invoice.status

  return (
    <div className="space-y-6 max-w-3xl">
      <Link href="/admin/invoices" className="text-sm text-gray-500 hover:text-gray-700">← Back to Invoices</Link>

      {searchParams?.success && <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">{decodeURIComponent(searchParams.success)}</div>}

      {/* Header */}
      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">{invoice.invoiceNumber || `Invoice #${invoice.id.slice(-8)}`}</h2>
            <p className="mt-1 text-sm text-gray-500">{invoice.type}</p>
          </div>
          <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${
            status === 'PAID' ? 'bg-emerald-50 text-emerald-600' :
            status === 'DRAFT' ? 'bg-gray-50 text-gray-600' :
            status === 'CANCELLED' ? 'bg-gray-100 text-gray-400' :
            'bg-amber-50 text-amber-600'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${
              status === 'PAID' ? 'bg-emerald-400' :
              status === 'DRAFT' ? 'bg-gray-400' :
              status === 'CANCELLED' ? 'bg-red-400' : 'bg-amber-400'
            }`} />
            {status}
          </span>
        </div>
      </div>

      {/* Business & Details */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Business</h3>
          <p className="text-sm text-gray-700">{invoice.business.name}</p>
          <p className="text-sm text-gray-500">{invoice.business.contactEmail}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Details</h3>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">Amount</span><span className="font-semibold text-gray-900">${invoice.amount.toString()}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Currency</span><span className="text-gray-700">{invoice.currency}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Issued</span><span className="text-gray-700">{new Date(invoice.createdAt).toLocaleDateString()}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Due</span><span className="text-gray-700">{invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : '—'}</span></div>
            {invoice.paidAt && <div className="flex justify-between"><span className="text-gray-500">Paid</span><span className="text-emerald-600 font-medium">{new Date(invoice.paidAt).toLocaleDateString()}</span></div>}
          </div>
        </div>
      </div>

      {/* Line Items */}
      {lineItems.length > 0 && (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-gray-50 px-5 py-4">
            <h3 className="text-sm font-semibold text-gray-900">Line Items</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase text-gray-500">Description</th>
                  <th className="px-5 py-3 text-right text-xs font-medium uppercase text-gray-500">Qty</th>
                  <th className="px-5 py-3 text-right text-xs font-medium uppercase text-gray-500">Unit Price</th>
                  <th className="px-5 py-3 text-right text-xs font-medium uppercase text-gray-500">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {lineItems.map((item: any, i: number) => (
                  <tr key={i}>
                    <td className="px-5 py-3 text-gray-700">{item.description}</td>
                    <td className="px-5 py-3 text-right text-gray-600">{item.quantity}</td>
                    <td className="px-5 py-3 text-right text-gray-600">${item.unitPrice?.toFixed(2)}</td>
                    <td className="px-5 py-3 text-right font-medium text-gray-900">${(item.quantity * item.unitPrice).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-100 bg-gray-50/50">
                  <td colSpan={3} className="px-5 py-3 text-right text-sm font-semibold text-gray-700">Total</td>
                  <td className="px-5 py-3 text-right font-bold text-gray-900">${invoice.amount.toString()}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Notes */}
      {invoice.notes && (
        <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Notes</h3>
          <p className="text-sm text-gray-600 whitespace-pre-wrap">{invoice.notes}</p>
        </div>
      )}

      {/* Actions */}
      <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {status !== 'PAID' && status !== 'CANCELLED' && (
            <form action={markInvoicePaid.bind(null, invoice.id)}>
              <button type="submit" className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
                Mark as Paid
              </button>
            </form>
          )}
          {status !== 'PAID' && status !== 'CANCELLED' && (
            <form action={cancelInvoice.bind(null, invoice.id)}>
              <button type="submit" className="rounded-lg border border-red-200 px-5 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50">
                Cancel Invoice
              </button>
            </form>
          )}
          <a href={`/api/admin/invoices/${invoice.id}/pdf`} target="_blank"
            className="rounded-lg border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">
            Download PDF
          </a>
          <Link href="/admin/invoices" className="rounded-lg border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">
            Back to Invoices
          </Link>
        </div>
      </div>
    </div>
  )
}
