import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createRule, updateRule, toggleRuleActive, duplicateRule } from '@/lib/actions/package-rules'
import { DeleteRuleButton } from './DeleteRuleButton'
import ApplyRuleWizard from './ApplyRuleWizard'
import RulePricingFields from '@/components/admin/pricing/RulePricingFields'

export default async function PackageRulesPage({ searchParams }: { searchParams?: { success?: string; error?: string; edit?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const rules = await prisma.packageConfigurationRule.findMany({
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    include: {
      executions: {
        where: { status: 'COMPLETED' },
        orderBy: { executedAt: 'desc' },
        take: 1,
        select: { executedAt: true },
      },
    },
  })

  const executionCounts = await prisma.ruleExecution.groupBy({
    by: ['ruleId'],
    where: { status: 'COMPLETED' },
    _count: { id: true },
  })
  const countMap = new Map(executionCounts.map(e => [e.ruleId, e._count.id]))

  const providers = await prisma.provider.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })

  const editRule = searchParams?.edit
    ? await prisma.packageConfigurationRule.findUnique({ where: { id: searchParams.edit } })
    : null

  function criteriaSummary(rule: typeof rules[0]) {
    const parts = [
      rule.country && `Country: ${rule.country}`,
      rule.region && `Region: ${rule.region}`,
      rule.productType && `Type: ${rule.productType}`,
      rule.dataMinGB != null && rule.dataMaxGB != null && `Data: ${rule.dataMinGB}-${rule.dataMaxGB} GB`,
      rule.dataMinGB != null && rule.dataMaxGB == null && `Data: ≥ ${rule.dataMinGB} GB`,
      rule.dataMinGB == null && rule.dataMaxGB != null && `Data: ≤ ${rule.dataMaxGB} GB`,
      rule.validityMinDays != null && rule.validityMaxDays != null && `Validity: ${rule.validityMinDays}-${rule.validityMaxDays}d`,
      rule.validityMinDays != null && rule.validityMaxDays == null && `Validity: ≥ ${rule.validityMinDays}d`,
      rule.validityMinDays == null && rule.validityMaxDays != null && `Validity: ≤ ${rule.validityMaxDays}d`,
    ].filter(Boolean)
    return parts.length > 0 ? parts.join(', ') : 'All plans'
  }

  function pricingSummary(rule: typeof rules[0]) {
    if (rule.fixedPrice) return `$${parseFloat(rule.fixedPrice.toString()).toFixed(2)} fixed`
    if (rule.markupPercent) return `${parseFloat(rule.markupPercent.toString())}% markup`
    return 'No pricing set'
  }

  function providerName(rule: typeof rules[0]) {
    return providers.find(p => p.id === rule.providerId)?.name || 'Any'
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Rule Library</h1>
          <p className="text-sm text-gray-500 mt-1">Create and manage reusable configuration templates</p>
        </div>
      </div>

      {searchParams?.success && (
        <div className="rounded-lg bg-emerald-50 p-4 border border-emerald-200 text-sm text-emerald-700 flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
          Rule {searchParams.success} successfully.
        </div>
      )}
      {searchParams?.error && (
        <div className="rounded-lg bg-red-50 p-4 border border-red-200 text-sm text-red-700">{searchParams.error}</div>
      )}

      {/* Create / Edit Form */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b bg-gray-50/50">
          <h3 className="text-sm font-semibold text-gray-900">{editRule ? `Edit: ${editRule.name}` : 'New Rule'}</h3>
        </div>
        <form action={editRule ? updateRule.bind(null, editRule.id) : createRule} className="p-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-500 mb-1">Name *</label>
              <input type="text" name="name" required defaultValue={editRule?.name || ''} placeholder="e.g. Standard Data Plans - Emerald Tier"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Provider</label>
              <select name="providerId" defaultValue={editRule?.providerId || ''}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20">
                <option value="">All Providers</option>
                {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Product Type</label>
              <select name="productType" defaultValue={editRule?.productType || ''}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20">
                <option value="">Any</option>
                <option value="NEW_ESIM">New eSIM</option>
                <option value="TOP_UP">Top-Up</option>
                <option value="BOTH">Both</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Country</label>
              <input type="text" name="country" defaultValue={editRule?.country || ''} placeholder="Any country"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Region</label>
              <input type="text" name="region" defaultValue={editRule?.region || ''} placeholder="Any region"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Data (GB)</label>
              <div className="flex gap-2">
                <input type="number" name="dataMinGB" placeholder="Min" defaultValue={editRule?.dataMinGB || ''}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20" />
                <input type="number" name="dataMaxGB" placeholder="Max" defaultValue={editRule?.dataMaxGB || ''}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Validity (Days)</label>
              <div className="flex gap-2">
                <input type="number" name="validityMinDays" placeholder="Min" defaultValue={editRule?.validityMinDays || ''}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20" />
                <input type="number" name="validityMaxDays" placeholder="Max" defaultValue={editRule?.validityMaxDays || ''}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20" />
              </div>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-5">
            <div className="sm:col-span-3">
              <RulePricingFields editRule={editRule ? {
                markupPercent: editRule.markupPercent,
                fixedPrice: editRule.fixedPrice,
                costPrice: editRule.costPrice,
              } : null} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Currency</label>
              <select name="sellingCurrency" defaultValue={editRule?.sellingCurrency || 'USD'}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20">
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Publish Status</label>
              <select name="publishStatus" defaultValue={editRule?.publishStatus || 'READY'}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20">
                <option value="DRAFT">Draft</option>
                <option value="READY">Ready</option>
                <option value="HIDDEN">Hidden</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-500">Priority</label>
              <input type="number" name="priority" defaultValue={editRule?.priority || 0}
                className="w-20 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isActive" defaultChecked={editRule ? editRule.isActive : true}
                className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
              <span className="text-gray-700">Active</span>
            </label>
            <div className="flex-1" />
            <button type="submit" className="rounded-lg bg-cyan-600 px-5 py-2 text-sm font-semibold text-white hover:bg-cyan-700 transition-colors">
              {editRule ? 'Save Changes' : 'Create Rule'}
            </button>
            {editRule && (
              <Link href="/admin/package-rules" className="rounded-lg border border-gray-200 px-5 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors">Cancel</Link>
            )}
          </div>
        </form>
      </div>

      {/* Rules Table */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b bg-gray-50/50 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">All Rules <span className="text-gray-400 font-normal">({rules.length})</span></h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50/80">
              <tr>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">Name</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">Type</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">Target</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">Pricing</th>
                <th className="px-4 py-3 text-center text-[11px] font-semibold uppercase tracking-wider text-gray-500">Status</th>
                <th className="px-4 py-3 text-center text-[11px] font-semibold uppercase tracking-wider text-gray-500">Used</th>
                <th className="px-4 py-3 text-center text-[11px] font-semibold uppercase tracking-wider text-gray-500">Applied</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">Updated</th>
                <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rules.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-16 text-center text-sm text-gray-400">No rules yet. Create your first rule above.</td></tr>
              ) : rules.map(rule => {
                const lastUsed = rule.executions[0]?.executedAt ?? null
                const timesApplied = countMap.get(rule.id) ?? 0
                return (
                  <tr key={rule.id} className="group hover:bg-gray-50/50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-gray-900">{rule.name}</div>
                      <div className="text-xs text-gray-400 mt-0.5 leading-relaxed">{criteriaSummary(rule)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-600">
                        {rule.productType || 'Any'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      <div>{providerName(rule)}</div>
                      <div className="text-gray-400">{rule.country || 'Any country'}{rule.region ? ` / ${rule.region}` : ''}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs font-medium text-gray-900">{pricingSummary(rule)}</div>
                      <div className="text-[11px] text-gray-400">{rule.sellingCurrency}{rule.costPrice ? ` · Cost $${parseFloat(rule.costPrice.toString()).toFixed(2)}` : ''}</div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <form action={toggleRuleActive.bind(null, rule.id)}>
                        <button type="submit" className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${rule.isActive ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}>
                          {rule.isActive ? 'Active' : 'Disabled'}
                        </button>
                      </form>
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-gray-500">
                      {lastUsed ? (
                        <span title={lastUsed.toLocaleString()}>{formatRelativeTime(lastUsed)}</span>
                      ) : (
                        <span className="text-gray-300">Never</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center justify-center rounded-full bg-cyan-50 px-2.5 py-0.5 text-[11px] font-medium text-cyan-700">
                        {timesApplied}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{formatRelativeTime(rule.updatedAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <ApplyRuleWizard rule={rule} />
                        <Link href={`/admin/package-rules?edit=${rule.id}`}
                          className="rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-500 hover:text-cyan-600 hover:bg-cyan-50 transition-colors">
                          Edit
                        </Link>
                        <form action={duplicateRule.bind(null, rule.id)}>
                          <button type="submit"
                            className="rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-500 hover:text-emerald-600 hover:bg-emerald-50 transition-colors">
                            Duplicate
                          </button>
                        </form>
                        <DeleteRuleButton ruleId={rule.id} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}
