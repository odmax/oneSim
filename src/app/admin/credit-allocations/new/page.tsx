import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { adminAllocateCredit } from '@/lib/actions/admin-credit'

export default async function AllocateCreditPage({ searchParams }: { searchParams?: { error?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const businesses = await prisma.business.findMany({
    where: { status: 'APPROVED' },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  return (
    <div className="space-y-6 max-w-2xl">
      <Link href="/admin/wallet-topups" className="text-sm text-gray-500 hover:text-gray-700">← Back to Credit Allocations</Link>

      <div>
        <h2 className="text-2xl font-bold text-gray-900">Allocate Credit</h2>
        <p className="mt-1 text-sm text-gray-500">Directly credit a business wallet after manual payment confirmation.</p>
      </div>

      {searchParams?.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>
      )}

      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <form action={adminAllocateCredit} className="space-y-5">

          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Allocation Details</h3>

            <div>
              <label htmlFor="businessId" className="block text-sm font-medium text-gray-700">Business *</label>
              <select id="businessId" name="businessId" required
                className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
                <option value="">Select a business...</option>
                {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="amount" className="block text-sm font-medium text-gray-700">Amount *</label>
                <input id="amount" name="amount" type="number" required step="0.01" min="0.01" placeholder="0.00"
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
              <div>
                <label htmlFor="currency" className="block text-sm font-medium text-gray-700">Currency</label>
                <select id="currency" name="currency"
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="reference" className="block text-sm font-medium text-gray-700">Invoice / Payment Reference *</label>
              <input id="reference" name="reference" type="text" required placeholder="e.g. INV-2026-001"
                className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              <p className="mt-1 text-xs text-gray-400">Used to prevent duplicate allocations.</p>
            </div>

            <div>
              <label htmlFor="note" className="block text-sm font-medium text-gray-700">Admin Note</label>
              <textarea id="note" name="note" rows={3} placeholder="Optional — internal note"
                className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
            </div>
          </div>

          <div className="flex gap-3 pt-4 border-t border-gray-100">
            <button type="submit" className="rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
              Allocate Credit
            </button>
            <Link href="/admin/wallet-topups" className="rounded-lg border border-gray-200 px-6 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  )
}
