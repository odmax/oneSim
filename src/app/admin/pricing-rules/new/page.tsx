import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createPricingRule } from '@/lib/actions/pricing-rules'

export default async function NewPricingRulePage({ searchParams }: { searchParams?: { error?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const [businesses, packages] = await Promise.all([
    prisma.business.findMany({ where: { status: 'APPROVED' }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.eSIMPackage.findMany({ where: { source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } }, select: { id: true, name: true, displayName: true }, orderBy: { name: 'asc' } }),
  ])

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <Link href="/admin/pricing-rules" className="text-sm text-gray-500 hover:text-gray-700">← Back to Pricing Rules</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">New Pricing Rule</h2>
        <p className="mt-1 text-sm text-gray-500">Create an optional discount or price override for specific clients, regions, or packages</p>
      </div>

      {searchParams?.error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>}

      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <form action={createPricingRule} className="space-y-5">

          {/* Rule Basics */}
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Rule Basics</h3>
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700">Rule Name *</label>
              <input id="name" name="name" type="text" required placeholder="e.g. Nigeria Regional Discount"
                className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </div>
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-gray-700">Description</label>
              <textarea id="description" name="description" rows={2} placeholder="Optional — internal note"
                className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </div>
          </div>

          {/* Rule Type */}
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Rule Type</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="ruleType" className="block text-sm font-medium text-gray-700">Type *</label>
                <select id="ruleType" name="ruleType" required
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
                  <option value="GLOBAL_DISCOUNT">Global Discount</option>
                  <option value="BUSINESS_DISCOUNT">Business Pricing</option>
                  <option value="REGION_OVERRIDE">Regional Pricing</option>
                  <option value="PACKAGE_OVERRIDE">Package Override</option>
                  <option value="PROMOTIONAL">Promotional</option>
                </select>
              </div>
              <div>
                <label htmlFor="priority" className="block text-sm font-medium text-gray-700">Priority</label>
                <input id="priority" name="priority" type="number" required min="0" defaultValue="0"
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
                <p className="mt-1 text-xs text-gray-400">Lower = higher priority</p>
              </div>
            </div>
          </div>

          {/* Targeting */}
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Targeting <span className="text-xs font-normal text-gray-400">(optional — leave blank for global)</span></h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="businessId" className="block text-sm font-medium text-gray-700">Business</label>
                <select id="businessId" name="businessId" className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
                  <option value="">Any Business</option>
                  {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="packageId" className="block text-sm font-medium text-gray-700">Package</label>
                <select id="packageId" name="packageId" className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
                  <option value="">Any Package</option>
                  {packages.map(p => <option key={p.id} value={p.id}>{p.displayName || p.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="country" className="block text-sm font-medium text-gray-700">Country</label>
                <input id="country" name="country" type="text" placeholder="e.g. Nigeria"
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
              <div>
                <label htmlFor="region" className="block text-sm font-medium text-gray-700">Region</label>
                <input id="region" name="region" type="text" placeholder="e.g. West Africa"
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
            </div>
          </div>

          {/* Pricing Logic */}
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Pricing Logic</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="ruleMode" className="block text-sm font-medium text-gray-700">Mode *</label>
                <select id="ruleMode" name="ruleMode" required
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
                  <option value="PERCENTAGE">Percentage Discount</option>
                  <option value="FIXED_AMOUNT">Fixed Amount Off</option>
                  <option value="FIXED_PRICE">Fixed Final Price</option>
                </select>
              </div>
              <div>
                <label htmlFor="value" className="block text-sm font-medium text-gray-700">Value *</label>
                <input id="value" name="value" type="number" required step="0.01" min="0" placeholder="e.g. 10"
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
                <p className="mt-1 text-xs text-gray-400">% discount, $ amount off, or fixed $ price</p>
              </div>
            </div>
          </div>

          {/* Schedule */}
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Schedule <span className="text-xs font-normal text-gray-400">(optional)</span></h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="startDate" className="block text-sm font-medium text-gray-700">Start Date</label>
                <input id="startDate" name="startDate" type="date"
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
              <div>
                <label htmlFor="endDate" className="block text-sm font-medium text-gray-700">End Date</label>
                <input id="endDate" name="endDate" type="date"
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
            </div>
          </div>

          <div className="flex gap-3 pt-4 border-t border-gray-100">
            <button type="submit" className="rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
              Create Rule
            </button>
            <Link href="/admin/pricing-rules" className="rounded-lg border border-gray-200 px-6 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  )
}
