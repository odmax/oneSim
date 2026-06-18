import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { savePackage } from '@/lib/actions/markup'
import { suggestDisplayName } from '@/lib/packages/package-utils'

function StepRow({ source, isActive, displayName }: { source: string; isActive: boolean; displayName: string | null }) {
  const steps = [
    { label: 'Imported', done: true },
    { label: 'Configured', done: source !== 'PROVIDER_PLAN' || !!displayName },
    { label: 'Catalog', done: source !== 'PROVIDER_PLAN' },
    { label: 'Live', done: source !== 'PROVIDER_PLAN' && isActive },
  ]
  return (
    <div className="flex items-center gap-0">
      {steps.map((step, i) => (
        <div key={step.label} className="flex items-center">
          <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
            step.done ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-400'
          }`}>
            {step.done ? '✓' : i + 1}
          </div>
          <span className={`ml-2 text-sm font-medium ${step.done ? 'text-emerald-600' : 'text-gray-400'}`}>{step.label}</span>
          {i < 3 && <div className={`mx-3 h-0.5 w-10 rounded-full ${step.done && steps[i + 1]?.done ? 'bg-emerald-400' : 'bg-gray-200'}`} />}
        </div>
      ))}
    </div>
  )
}

export default async function EditPackagePage({ 
  params,
  searchParams,
}: { 
  params: { id: string }
  searchParams?: { error?: string; success?: string }
}) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin?error=unauthorized')

  const pkg = await prisma.eSIMPackage.findUnique({ where: { id: params.id } })
  if (!pkg) redirect('/admin/packages')

  const providers = await prisma.provider.findMany({
    where: { status: { in: ['ACTIVE', 'TESTING', 'DEGRADED'] } },
    orderBy: { name: 'asc' },
  })

  if (!pkg.providerId && pkg.providerName) {
    const matchedByCode = providers.find(p => p.code.toLowerCase() === pkg.providerName!.toLowerCase())
    if (!matchedByCode) {
      const dbProvider = await prisma.provider.findFirst({ where: { code: { equals: pkg.providerName, mode: 'insensitive' } } })
      if (dbProvider && !providers.some(p => p.id === dbProvider.id)) providers.push(dbProvider)
    }
  }
  if (pkg.providerId && !providers.some(p => p.id === pkg.providerId)) {
    const currentProvider = await prisma.provider.findUnique({ where: { id: pkg.providerId } })
    if (currentProvider) providers.push(currentProvider)
  }

  const linkedProvider = pkg.providerId ? providers.find(p => p.id === pkg.providerId) : providers.find(p => pkg.providerName && p.code.toLowerCase() === pkg.providerName.toLowerCase()) || null
  const defaultProviderId = pkg.providerId || linkedProvider?.id || ''
  const isImported = !!pkg.providerName
  const isProviderPlan = pkg.source === 'PROVIDER_PLAN'
  const costPrice = pkg.costPriceUSD ? parseFloat(pkg.costPriceUSD.toString()) : 0
  const currentMarkupPct = pkg.markupPercent ? parseFloat(pkg.markupPercent.toString()) : 0
  const suggestedPrice = costPrice > 0 ? costPrice + (costPrice * currentMarkupPct / 100) : 0
  const currentSellingPrice = parseFloat(pkg.priceUSD.toString())
  const currentMargin = costPrice > 0 ? ((currentSellingPrice - costPrice) / costPrice * 100).toFixed(1) : null

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link href="/admin/packages" className="text-sm text-gray-500 hover:text-gray-700">← Back to Packages</Link>
      </div>

      {/* Hero banner */}
      <div className="mb-8 rounded-xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-white p-6 shadow-sm">
        <StepRow source={pkg.source} isActive={pkg.isActive} displayName={pkg.displayName} />
        <div className="mt-4">
          <h2 className="text-xl font-bold text-gray-900">{isProviderPlan ? 'Configure & Publish Provider Plan' : 'Edit Package'}</h2>
          <p className="mt-1 text-sm text-gray-500">
            {isProviderPlan
              ? 'Configure this provider plan and publish it as a OneSIM catalog product.'
              : pkg.isActive
                ? 'This product is visible to business clients.'
                : 'This product will be visible to business clients when activated.'}
          </p>
        </div>
      </div>

      {searchParams?.error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{decodeURIComponent(searchParams.error)}</div>
      )}
      {searchParams?.success && (
        <div className="mb-6 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">{decodeURIComponent(searchParams.success)}</div>
      )}

      <div className="max-w-3xl">
        <form action={savePackage.bind(null, pkg.id)} className="space-y-6">

          {/* Section 1: Customer-Facing Product */}
          <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
            <h3 className="mb-1 text-base font-semibold text-gray-900">Customer-Facing Product</h3>
            <p className="mb-5 text-sm text-gray-500">How this package appears to business clients</p>

            <div className="space-y-4">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700">Admin Name</label>
                <input id="name" name="name" type="text" required defaultValue={pkg.name} readOnly
                  className="mt-1 block w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-500" />
                <p className="mt-1 text-xs text-gray-400">Internal name — not shown to clients</p>
              </div>

              <div>
                <label htmlFor="displayName" className="block text-sm font-medium text-gray-700">OneSIM Display Name</label>
                <input id="displayName" name="displayName" type="text"
                  defaultValue={pkg.displayName || (isImported ? suggestDisplayName(pkg) : pkg.name)}
                  placeholder={isImported ? suggestDisplayName(pkg) : pkg.name}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
                <p className="mt-1 text-xs text-gray-400">Shown on the business buy page — e.g. &ldquo;OneSIM Malawi 1GB 1 Day&rdquo;</p>
              </div>

              <div>
                <label htmlFor="customerDescription" className="block text-sm font-medium text-gray-700">Customer Description</label>
                <textarea id="customerDescription" name="customerDescription" rows={3}
                  defaultValue={pkg.customerDescription ?? pkg.description ?? ''}
                  placeholder={pkg.description || ''}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
                <p className="mt-1 text-xs text-gray-400">Optional — shown below the display name on the buy page</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Data</label>
                  <p className="mt-1 text-sm font-medium text-gray-900">{pkg.dataGB} GB</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Validity</label>
                  <p className="mt-1 text-sm font-medium text-gray-900">{pkg.validityDays} days</p>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Pricing */}
          <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
            <h3 className="mb-1 text-base font-semibold text-gray-900">Pricing</h3>
            <p className="mb-5 text-sm text-gray-500">Set the selling price and margin</p>

            <div className="space-y-4">
              <div className={`grid gap-4 ${isImported ? 'grid-cols-4' : 'grid-cols-1'}`}>
                <div>
                  <label className="block text-sm font-medium text-gray-500">Cost Price</label>
                  {isImported && costPrice > 0 ? (
                    <p className="mt-1 text-lg font-semibold text-gray-900">${costPrice.toFixed(2)}</p>
                  ) : (
                    <div className="mt-1 flex items-center gap-2">
                      <input name="costPriceUSD" type="number" step="0.01" min="0" defaultValue={costPrice > 0 ? costPrice : ''}
                        placeholder="0.00"
                        className="block w-28 rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
                      <input name="costCurrency" type="text" maxLength={3} defaultValue={pkg.costCurrency || 'USD'}
                        className="block w-16 rounded-lg border border-gray-200 px-2 py-1.5 text-sm font-mono uppercase focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
                    </div>
                  )}
                  {!isImported && <p className="mt-1 text-xs text-gray-400">Enter wholesale cost for margin calculations</p>}
                </div>
                {isImported && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-500">Cost Currency</label>
                      <p className="mt-1 text-lg font-semibold text-gray-900">{pkg.costCurrency || 'USD'}</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-500">Current Markup</label>
                      <p className="mt-1 text-lg font-semibold text-gray-900">{currentMarkupPct > 0 ? `${currentMarkupPct}%` : '—'}</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-500">Current Margin</label>
                      <p className={`mt-1 text-lg font-semibold ${currentMargin && parseFloat(currentMargin) >= 0 ? 'text-emerald-600' : 'text-gray-400'}`}>
                        {currentMargin ? `${currentMargin}%` : '—'}
                      </p>
                    </div>
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="priceUSD" className="block text-sm font-medium text-gray-700">Selling Price (USD) *</label>
                  <input id="priceUSD" name="priceUSD" type="number" required step="0.01" min="0"
                    defaultValue={currentSellingPrice}
                    className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
                  {suggestedPrice > 0 && (
                    <p className="mt-1 text-xs text-gray-400">Suggested: ${suggestedPrice.toFixed(2)} (cost + {currentMarkupPct}% markup)</p>
                  )}
                </div>
                <div>
                  <label htmlFor="localPrice" className="block text-sm font-medium text-gray-700">Local Price (optional)</label>
                  <input id="localPrice" name="localPrice" type="number" step="0.01" min="0"
                    defaultValue={parseFloat(pkg.localPrice.toString())}
                    className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
                </div>
              </div>

              {costPrice > 0 && (
                <div className={`rounded-lg p-3 ${parseFloat(pkg.priceUSD.toString()) >= costPrice ? 'bg-emerald-50' : 'bg-red-50'}`}>
                  <p className={`text-sm ${parseFloat(pkg.priceUSD.toString()) >= costPrice ? 'text-emerald-700' : 'text-red-700'}`}>
                    {parseFloat(pkg.priceUSD.toString()) >= costPrice
                      ? `Margin preview: ${((currentSellingPrice - costPrice) / costPrice * 100).toFixed(1)}% — above cost`
                      : '⚠ Selling price is below cost'}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Section 3: Internal Provider Mapping */}
          <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
            <div className="mb-5 flex items-center gap-2">
              <h3 className="text-base font-semibold text-gray-900">Provider Activation Mapping</h3>
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                <span className="h-1.5 w-1.5 rounded-full bg-gray-400" /> Internal only
              </span>
            </div>
            <p className="mb-4 text-sm text-gray-500">Used to activate the correct plan with the upstream provider. Customers never see this.</p>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="providerId" className="block text-sm font-medium text-gray-700">Linked Provider</label>
                <select id="providerId" name="providerId" defaultValue={defaultProviderId}
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500">
                  <option value="">None</option>
                  {providers.map((prov: any) => (
                    <option key={prov.id} value={prov.id}>{prov.name} ({prov.code})</option>
                  ))}
                </select>
                {linkedProvider && (
                  <p className="mt-1 text-xs text-gray-400">
                    <Link href={`/admin/providers/${linkedProvider.id}`} className="text-emerald-600 hover:text-emerald-700">{linkedProvider.name}</Link>
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="providerPlanId" className="block text-sm font-medium text-gray-700">Provider Plan ID</label>
                <input id="providerPlanId" name="providerPlanId" type="text" defaultValue={pkg.providerPlanId || ''} placeholder="e.g. plan-123"
                  className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-mono focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4 text-sm text-gray-500">
              <div><span className="text-gray-400">SKU:</span> <span className="font-mono">{pkg.sku || '—'}</span></div>
              <div><span className="text-gray-400">Package Code:</span> <span className="font-mono">{pkg.packageCode || '—'}</span></div>
              <div><span className="text-gray-400">Provider Plan ID:</span> <span className="font-mono">{pkg.providerPlanId || '—'}</span></div>
              <div><span className="text-gray-400">Package ID:</span> <span className="font-mono">{pkg.id}</span></div>
            </div>
          </div>

          {/* Section 4: Publish */}
          <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
            <h3 className="mb-1 text-base font-semibold text-gray-900">Publish</h3>
            <p className="mb-5 text-sm text-gray-500">Control visibility to business clients</p>

            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <input id="isActive" name="isActive" type="checkbox" defaultChecked={pkg.isActive}
                  className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
                <label htmlFor="isActive" className="text-sm text-gray-700">Activate now — make visible to business clients immediately</label>
              </div>

              <div className="border-t border-gray-100 pt-4">
                <p className="text-xs font-medium text-gray-500 mb-3">Actions</p>
                <div className="flex flex-wrap gap-2">
                  <button type="submit" name="__action" value="save"
                    className="rounded-lg border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">
                    Save Draft
                  </button>
                  {isProviderPlan && (
                    <button type="submit" name="__action" value="save_and_convert"
                      className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
                      Save & Add to Catalog
                    </button>
                  )}
                  {!isProviderPlan && (
                    <button type="submit" name="__action" value="save_and_activate"
                      className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 shadow-sm">
                      {pkg.isActive ? 'Save Changes' : 'Save & Activate'}
                    </button>
                  )}
                </div>

                {!isProviderPlan && (
                  <div className="mt-4 border-t border-gray-100 pt-4">
                    <p className="text-xs font-medium text-gray-500 mb-3">Danger zone — manage catalog visibility</p>
                    <div className="flex flex-wrap gap-2">
                      {pkg.isActive && (
                        <button type="submit" name="__action" value="hide"
                          className="rounded-lg border border-red-200 px-5 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50">
                          Hide from Clients
                        </button>
                      )}
                      {isImported && pkg.source === 'CATALOG_PRODUCT' && (
                        <button type="submit" name="__action" value="move_to_provider"
                          className="rounded-lg border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-500 hover:bg-gray-50">
                          Move Back to Provider Plans
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

        </form>
      </div>
    </div>
  )
}
