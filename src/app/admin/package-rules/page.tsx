import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createRule, updateRule, toggleRuleActive } from '@/lib/actions/package-rules'
import { DeleteRuleButton } from './DeleteRuleButton'

export default async function PackageRulesPage({ searchParams }: { searchParams?: { success?: string; error?: string; edit?: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const rules = await prisma.packageConfigurationRule.findMany({
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  })

  const providers = await prisma.provider.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })

  const editRule = searchParams?.edit
    ? await prisma.packageConfigurationRule.findUnique({ where: { id: searchParams.edit } })
    : null

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Package Configuration Rules</h2>
          <p className="text-gray-600">Auto-configure imported packages based on matching criteria</p>
        </div>
      </div>

      {searchParams?.success && (
        <div className="rounded-lg bg-green-50 p-4 border border-green-200 text-sm text-green-700">
          Rule {searchParams.success} successfully.
        </div>
      )}
      {searchParams?.error && (
        <div className="rounded-lg bg-red-50 p-4 border border-red-200 text-sm text-red-700">{searchParams.error}</div>
      )}

      {/* Create / Edit Form */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">{editRule ? 'Edit Rule' : 'Create Rule'}</h3>
        <form action={editRule ? updateRule.bind(null, editRule.id) : createRule} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Name *</label>
              <input type="text" name="name" required defaultValue={editRule?.name || ''}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Provider</label>
              <select name="providerId" defaultValue={editRule?.providerId || ''}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
                <option value="">Any</option>
                {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Product Type</label>
              <select name="productType" defaultValue={editRule?.productType || ''}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
                <option value="">Any</option>
                <option value="NEW_ESIM">New eSIM</option>
                <option value="TOP_UP">Top-Up</option>
                <option value="BOTH">Both</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Country</label>
              <input type="text" name="country" defaultValue={editRule?.country || ''}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Region</label>
              <input type="text" name="region" defaultValue={editRule?.region || ''}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Data Range (GB)</label>
              <div className="flex gap-2">
                <input type="number" name="dataMinGB" placeholder="Min" defaultValue={editRule?.dataMinGB || ''}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
                <input type="number" name="dataMaxGB" placeholder="Max" defaultValue={editRule?.dataMaxGB || ''}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Validity Range (Days)</label>
              <div className="flex gap-2">
                <input type="number" name="validityMinDays" placeholder="Min" defaultValue={editRule?.validityMinDays || ''}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
                <input type="number" name="validityMaxDays" placeholder="Max" defaultValue={editRule?.validityMaxDays || ''}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Markup %</label>
              <input type="number" step="0.01" name="markupPercent" defaultValue={editRule?.markupPercent ? parseFloat(editRule.markupPercent.toString()) : ''}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Fixed Price</label>
              <input type="number" step="0.01" name="fixedPrice" defaultValue={editRule?.fixedPrice ? parseFloat(editRule.fixedPrice.toString()) : ''}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Currency</label>
              <select name="sellingCurrency" defaultValue={editRule?.sellingCurrency || 'USD'}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Publish Status</label>
                  <select name="publishStatus" defaultValue={editRule?.publishStatus || 'READY'}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none">
                    <option value="DRAFT">Draft</option>
                    <option value="READY">Ready</option>
                    <option value="HIDDEN">Hidden</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Priority</label>
                  <input type="number" name="priority" defaultValue={editRule?.priority || 0}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none" />
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="isActive" defaultChecked={editRule ? editRule.isActive : true}
                      className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500" />
                    <span className="text-gray-700">Active</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            <button type="submit" className="rounded-lg bg-cyan-600 px-5 py-2 text-sm font-medium text-white hover:bg-cyan-700">
              {editRule ? 'Update Rule' : 'Create Rule'}
            </button>
            {editRule && (
              <Link href="/admin/package-rules" className="rounded-lg border border-gray-200 px-5 py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</Link>
            )}
          </div>
        </form>
      </div>

      {/* Rules List */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Name</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Provider</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Criteria</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Pricing</th>
              <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Priority</th>
              <th className="px-3 py-3 text-center text-xs font-medium uppercase text-gray-500">Active</th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rules.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400">No rules created yet.</td></tr>
            ) : rules.map(rule => {
              const criteria = [
                rule.country && `Country: ${rule.country}`,
                rule.region && `Region: ${rule.region}`,
                rule.productType && `Type: ${rule.productType}`,
                rule.dataMinGB != null && rule.dataMaxGB != null && `Data: ${rule.dataMinGB}-${rule.dataMaxGB} GB`,
                rule.dataMinGB != null && !rule.dataMaxGB && `Data: ≥ ${rule.dataMinGB} GB`,
                !rule.dataMinGB && rule.dataMaxGB != null && `Data: ≤ ${rule.dataMaxGB} GB`,
                rule.validityMinDays != null && rule.validityMaxDays != null && `Validity: ${rule.validityMinDays}-${rule.validityMaxDays}d`,
                rule.validityMinDays != null && !rule.validityMaxDays && `Validity: ≥ ${rule.validityMinDays}d`,
                !rule.validityMinDays && rule.validityMaxDays != null && `Validity: ≤ ${rule.validityMaxDays}d`,
              ].filter(Boolean)
              const pricing = rule.fixedPrice ? `$${rule.fixedPrice} fixed` : rule.markupPercent ? `${rule.markupPercent}% markup` : '—'
              const providerName = providers.find(p => p.id === rule.providerId)?.name
              return (
                <tr key={rule.id} className="hover:bg-gray-50">
                  <td className="px-3 py-3 text-sm font-medium text-gray-900">{rule.name}</td>
                  <td className="px-3 py-3 text-xs text-gray-500">{providerName || 'Any'}</td>
                  <td className="px-3 py-3 text-xs text-gray-500">{criteria.join(', ') || 'Match all'}</td>
                  <td className="px-3 py-3 text-xs text-gray-900">
                    {rule.fixedPrice ? <span className="font-medium text-blue-600">{pricing}</span> : rule.markupPercent ? <span className="font-medium text-emerald-600">{pricing}</span> : <span className="text-gray-400">—</span>}
                    <span className="text-gray-400 ml-1">{rule.sellingCurrency}</span>
                  </td>
                  <td className="px-3 py-3 text-xs text-center text-gray-600">{rule.priority}</td>
                  <td className="px-3 py-3 text-center">
                    <form action={toggleRuleActive.bind(null, rule.id)}>
                      <button type="submit" className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${rule.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                        {rule.isActive ? 'Active' : 'Inactive'}
                      </button>
                    </form>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex gap-2">
                      <Link href={`/admin/package-rules?edit=${rule.id}`} className="text-xs text-cyan-600 hover:text-cyan-700">Edit</Link>
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
  )
}
