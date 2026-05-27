import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { updatePricingRule } from '@/lib/actions/pricing-rules'

export default async function EditPricingRulePage({
  params, searchParams,
}: { params: { id: string }; searchParams?: { error?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const rule = await prisma.pricingRule.findUnique({ where: { id: params.id } })
  if (!rule) redirect('/admin/pricing-rules')

  const [businesses, packages] = await Promise.all([
    prisma.business.findMany({ where: { status: 'APPROVED' }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.eSIMPackage.findMany({ where: { source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } }, select: { id: true, name: true, displayName: true }, orderBy: { name: 'asc' } }),
  ])

  const fmtDate = (d: Date | null | undefined) => d ? new Date(d).toISOString().split('T')[0] : ''

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <Link href="/admin/pricing-rules" className="text-sm text-gray-500 hover:text-gray-700">← Back to Pricing Rules</Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900">Edit Pricing Rule</h2>
        <p className="mt-1 text-sm text-gray-500">{rule.name}</p>
      </div>

      {searchParams?.error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>}

      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <form action={updatePricingRule.bind(null, rule.id)} className="space-y-5">

          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Rule Basics</h3>
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700">Rule Name</label>
              <input id="name" name="name" type="text" required defaultValue={rule.name}
                className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
            </div>
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-gray-700">Description</label>
              <textarea id="description" name="description" rows={2} defaultValue={rule.description || ''}
                className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Type & Priority</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="ruleType" className="block text-sm font-medium text-gray-700">Type</label>
                <select id="ruleType" name="ruleType" defaultValue={rule.ruleType}
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
                <input id="priority" name="priority" type="number" required min="0" defaultValue={rule.priority}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Targeting</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="businessId" className="block text-sm font-medium text-gray-700">Business</label>
                <select id="businessId" name="businessId" defaultValue={rule.businessId || ''}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
                  <option value="">Any Business</option>
                  {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="packageId" className="block text-sm font-medium text-gray-700">Package</label>
                <select id="packageId" name="packageId" defaultValue={rule.packageId || ''}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
                  <option value="">Any Package</option>
                  {packages.map(p => <option key={p.id} value={p.id}>{p.displayName || p.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="country" className="block text-sm font-medium text-gray-700">Country</label>
                <input id="country" name="country" type="text" defaultValue={rule.country || ''}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
              <div>
                <label htmlFor="region" className="block text-sm font-medium text-gray-700">Region</label>
                <input id="region" name="region" type="text" defaultValue={rule.region || ''}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Pricing Logic</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="ruleMode" className="block text-sm font-medium text-gray-700">Mode</label>
                <select id="ruleMode" name="ruleMode" defaultValue={rule.ruleMode}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none">
                  <option value="PERCENTAGE">Percentage Discount</option>
                  <option value="FIXED_AMOUNT">Fixed Amount Off</option>
                  <option value="FIXED_PRICE">Fixed Final Price</option>
                </select>
              </div>
              <div>
                <label htmlFor="value" className="block text-sm font-medium text-gray-700">Value</label>
                <input id="value" name="value" type="number" required step="0.01" min="0" defaultValue={rule.value?.toString() || ''}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Schedule</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="startDate" className="block text-sm font-medium text-gray-700">Start Date</label>
                <input id="startDate" name="startDate" type="date" defaultValue={fmtDate(rule.startDate)}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
              <div>
                <label htmlFor="endDate" className="block text-sm font-medium text-gray-700">End Date</label>
                <input id="endDate" name="endDate" type="date" defaultValue={fmtDate(rule.endDate)}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <input id="isActive" name="isActive" type="checkbox" defaultChecked={rule.isActive} className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
            <label htmlFor="isActive" className="text-sm text-gray-700">Active</label>
          </div>

          <div className="flex gap-3 pt-4 border-t border-gray-100">
            <button type="submit" className="rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
              Save Changes
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
