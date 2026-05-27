import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { togglePricingRule } from '@/lib/actions/pricing-rules'

const RULE_TYPE_LABELS: Record<string, string> = {
  GLOBAL_DISCOUNT: 'Global Discount',
  BUSINESS_DISCOUNT: 'Business Pricing',
  REGION_OVERRIDE: 'Regional Pricing',
  PACKAGE_OVERRIDE: 'Package Override',
  PROMOTIONAL: 'Promotional',
}

const RULE_MODE_LABELS: Record<string, string> = {
  PERCENTAGE: '% Discount',
  FIXED_AMOUNT: '$ Off',
  FIXED_PRICE: 'Fixed Price',
}

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>{children}</span>
}

export default async function PricingRulesPage({ searchParams }: { searchParams?: { error?: string; success?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const rules = await prisma.pricingRule.findMany({
    orderBy: { priority: 'asc' },
    include: {
      business: { select: { id: true, name: true } },
      package: { select: { id: true, name: true } },
    },
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Pricing Rules</h2>
          <p className="mt-1 text-sm text-gray-500">Optional discount and override rules applied on top of manual catalog prices</p>
        </div>
        <Link href="/admin/pricing-rules/new" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
          Add Rule
        </Link>
      </div>

      {searchParams?.error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>}
      {searchParams?.success && <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">{decodeURIComponent(searchParams.success)}</div>}

      {rules.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-gray-500">No pricing rules yet. Rules are optional — packages use their manual price until a rule matches.</p>
          <Link href="/admin/pricing-rules/new" className="mt-3 inline-block text-sm font-medium text-emerald-600 hover:text-emerald-700">Create your first rule →</Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {rules.map((rule) => {
            const valueDisplay = rule.value
              ? rule.ruleMode === 'PERCENTAGE' ? `${rule.value.toString()}%` :
                rule.ruleMode === 'FIXED_PRICE' ? `$${rule.value.toString()}` : `$${rule.value.toString()} off`
              : '—'

            return (
              <div key={rule.id} className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold text-gray-900">{rule.name}</h3>
                      {rule.isActive ? (
                        <Badge color="bg-emerald-50 text-emerald-600">Active</Badge>
                      ) : (
                        <Badge color="bg-gray-50 text-gray-500">Inactive</Badge>
                      )}
                    </div>
                    {rule.description && <p className="mt-0.5 text-sm text-gray-500">{rule.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <span className="rounded-md bg-gray-50 px-2 py-1 text-gray-600">{RULE_TYPE_LABELS[rule.ruleType] || rule.ruleType}</span>
                      <span className="rounded-md bg-gray-50 px-2 py-1 text-gray-600">{RULE_MODE_LABELS[rule.ruleMode] || rule.ruleMode}</span>
                      <span className="rounded-md bg-emerald-50 px-2 py-1 font-medium text-emerald-700">{valueDisplay}</span>
                      <span className="rounded-md bg-gray-50 px-2 py-1 text-gray-500">Priority: {rule.priority}</span>
                      {rule.business && <span className="rounded-md bg-blue-50 px-2 py-1 text-blue-600">Business: {rule.business.name}</span>}
                      {rule.country && <span className="rounded-md bg-purple-50 px-2 py-1 text-purple-600">Country: {rule.country}</span>}
                      {rule.region && <span className="rounded-md bg-purple-50 px-2 py-1 text-purple-600">Region: {rule.region}</span>}
                      {rule.package && <span className="rounded-md bg-cyan-50 px-2 py-1 text-cyan-600">Package: {rule.package.name}</span>}
                      {rule.packageType && <span className="rounded-md bg-cyan-50 px-2 py-1 text-cyan-600">Type: {rule.packageType}</span>}
                      {rule.startDate && <span className="rounded-md bg-amber-50 px-2 py-1 text-amber-600">From: {new Date(rule.startDate).toLocaleDateString()}</span>}
                      {rule.endDate && <span className="rounded-md bg-amber-50 px-2 py-1 text-amber-600">Until: {new Date(rule.endDate).toLocaleDateString()}</span>}
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Link href={`/admin/pricing-rules/${rule.id}/edit`} className="rounded-md bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100">
                      Edit
                    </Link>
                    <form action={togglePricingRule.bind(null, rule.id)}>
                      <input type="hidden" name="isActive" value={rule.isActive ? 'off' : 'on'} />
                      <button type="submit" className={`rounded-md px-3 py-1.5 text-xs font-medium ${rule.isActive ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}>
                        {rule.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
