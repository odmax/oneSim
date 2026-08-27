'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createCustomPackage } from '@/lib/actions/custom-package'

export interface ProviderPackageOption {
  id: string
  name: string
  dataGB: number
  validityDays: number
  country: string | null
  region: string | null
  cost: number
  sellingPrice: number
  currency: string
  pricingStatus: string | null
  configurationStatus: string | null
  publishStatus: string | null
}

export interface ProviderOption {
  id: string
  name: string
  code: string
  status: string
  hasPurchaseCapability: boolean
  hasCustomPackageCreationCapability: boolean
  packages: ProviderPackageOption[]
}

export interface BackingRow {
  rowKey: string
  providerId: string
  providerPackageId: string
  priority: number
  enabled: boolean
}

let rowCounter = 0
function newRowKey() { rowCounter += 1; return `row-${rowCounter}-${Date.now()}` }

export function CustomPackageForm({ providers }: { providers: ProviderOption[] }) {
  const router = useRouter()

  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [dataGB, setDataGB] = useState(10)
  const [validityDays, setValidityDays] = useState(30)
  const [countries, setCountries] = useState('')
  const [productType, setProductType] = useState('NEW_ESIM')
  const [currency, setCurrency] = useState('USD')
  const [sellingPrice, setSellingPrice] = useState(29.99)
  const [policy, setPolicy] = useState<'AT_LEAST' | 'EXACT'>('AT_LEAST')
  const [allowFailover, setAllowFailover] = useState(false)

  const [rows, setRows] = useState<BackingRow[]>([{
    rowKey: newRowKey(),
    providerId: providers[0]?.id || '',
    providerPackageId: providers[0]?.packages[0]?.id || '',
    priority: 1,
    enabled: true,
  }])

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function setRow(rowKey: string, patch: Partial<BackingRow>) {
    setRows(prev => prev.map(r => (r.rowKey === rowKey ? { ...r, ...patch } : r)))
  }

  function handleProviderChange(rowKey: string, providerId: string) {
    const provider = providers.find(p => p.id === providerId)
    setRow(rowKey, {
      providerId,
      providerPackageId: provider?.packages[0]?.id || '',
    })
  }

  function addRow() {
    setRows(prev => {
      const usedProviders = new Set(prev.map(r => r.providerId))
      const nextProvider = providers.find(p => !usedProviders.has(p.id))
      const nextPriority = Math.max(0, ...prev.map(r => r.priority)) + 1
      return [...prev, {
        rowKey: newRowKey(),
        providerId: nextProvider?.id || '',
        providerPackageId: nextProvider?.packages[0]?.id || '',
        priority: nextPriority,
        enabled: true,
      }]
    })
  }

  function removeRow(rowKey: string) {
    setRows(prev => {
      const filtered = prev.filter(r => r.rowKey !== rowKey)
      return filtered.map((r, i) => ({ ...r, priority: i + 1 }))
    })
  }

  // ---- Validation ----
  const enabledRows = rows.filter(r => r.enabled && r.providerPackageId)

  const validationErrors: string[] = []
  if (enabledRows.length === 0) validationErrors.push('At least one enabled backing is required.')
  if (!validationErrors.includes('At least one enabled backing is required.') && !enabledRows.some(r => r.priority === 1)) {
    validationErrors.push('Priority 1 (primary provider) is required.')
  }
  const priorities = enabledRows.map(r => r.priority)
  if (new Set(priorities).size !== priorities.length) validationErrors.push('Priorities must be unique.')
  if (priorities.some(p => p < 1)) validationErrors.push('Priority must be >= 1.')

  const packageIds = enabledRows.map(r => r.providerPackageId).filter(Boolean)
  if (new Set(packageIds).size !== packageIds.length) {
    validationErrors.push('The same ProviderPackage cannot be selected twice.')
  }

  // Same provider twice (only if it would be ambiguous)
  const providerIds = enabledRows.map(r => r.providerId).filter(Boolean)
  if (new Set(providerIds).size !== providerIds.length) {
    validationErrors.push('The same provider cannot be selected more than once unless it supports multiple distinct packages.')
  }

  // ---- Compatibility warnings ----
  const warnings: string[] = []
  const selectedRows = rows.filter(r => r.enabled && r.providerPackageId)
  if (selectedRows.length > 1) {
    const valSet = new Set(selectedRows.map(r => {
      const p = providers.find(pr => pr.id === r.providerId)?.packages.find(pk => pk.id === r.providerPackageId)
      return p ? `${p.validityDays}` : ''
    }))
    if (valSet.size > 1) {
      warnings.push(`Selected providers have differing validity: ${[...valSet].join(', ')} days.`)
    }
    const dataSet = new Set(selectedRows.map(r => {
      const p = providers.find(pr => pr.id === r.providerId)?.packages.find(pk => pk.id === r.providerPackageId)
      return p ? `${p.dataGB}` : ''
    }))
    if (dataSet.size > 1) {
      warnings.push(`Selected providers have differing data allowances: ${[...dataSet].join(', ')} GB.`)
    }
  }

  // ---- Packaged data for submission ----
  const orderedRows = [...enabledRows].sort((a, b) => a.priority - b.priority)

  const totalBackingCost = orderedRows.reduce((sum, r) => {
    const p = providers.find(pr => pr.id === r.providerId)?.packages.find(pk => pk.id === r.providerPackageId)
    return sum + (p ? p.cost : 0)
  }, 0)
  const avgMarginPct = orderedRows.length > 0 && sellingPrice > 0
    ? ((sellingPrice - totalBackingCost / orderedRows.length) / sellingPrice) * 100
    : null

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true); setError(null)
    if (validationErrors.length > 0) { setError(validationErrors[0]); setBusy(false); return }

    const fd = new FormData()
    fd.set('name', name)
    fd.set('displayName', displayName || name)
    fd.set('description', description)
    fd.set('dataGB', String(dataGB))
    fd.set('validityDays', String(validityDays))
    fd.set('countries', countries)
    fd.set('productType', productType)
    fd.set('currency', currency)
    fd.set('sellingPrice', String(sellingPrice))
    fd.set('compatibilityPolicy', policy)
    fd.set('allowFailover', allowFailover ? 'true' : 'false')
    for (const r of orderedRows) {
      fd.append('providerPackageIds', r.providerPackageId)
      fd.append('providerIds', r.providerId)
      fd.append('priorities', String(r.priority))
      fd.append('enabledFlags', String(r.enabled))
    }

    try {
      const res = await createCustomPackage(fd)
      if (!res.success) { setError(res.error || 'Creation failed'); setBusy(false); return }
      router.push('/admin/packages?tab=catalog&success=custom_created')
      router.refresh()
    } catch {
      setError('Creation failed unexpectedly'); setBusy(false)
    }
  }

  const reviewRows = orderedRows.map(r => {
    const provider = providers.find(pr => pr.id === r.providerId)
    const pkg = provider?.packages.find(pk => pk.id === r.providerPackageId)
    return { priority: r.priority, providerName: provider?.name || '?', packageName: pkg?.name || '?', dataGB: pkg?.dataGB, validityDays: pkg?.validityDays }
  })

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* Section 1 — Package Information */}
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-semibold text-gray-900">1. Package Information</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Package name *</span>
            <input name="name" value={name} onChange={e => setName(e.target.value)} required className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" placeholder="Africa 10GB - 30 Days" />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Display name</span>
            <input name="displayName" value={displayName} onChange={e => setDisplayName(e.target.value)} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder={name || 'Package name'} />
          </label>
        </div>
        <label className="mt-3 block text-sm">
          <span className="font-medium text-gray-700">Description</span>
          <textarea name="description" value={description} onChange={e => setDescription(e.target.value)} rows={2} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
      </section>

      {/* Section 2 — Coverage & Allowance */}
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-semibold text-gray-900">2. Coverage &amp; Allowance</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Data (GB) *</span>
            <input name="dataGB" type="number" min={1} value={dataGB} onChange={e => setDataGB(Number(e.target.value) || 0)} required className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Validity (days) *</span>
            <input name="validityDays" type="number" min={1} value={validityDays} onChange={e => setValidityDays(Number(e.target.value) || 0)} required className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Countries / coverage (comma-separated ISO3)</span>
            <input name="countries" value={countries} onChange={e => setCountries(e.target.value)} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="ZAF, NGA, EGY" />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Product type</span>
            <select name="productType" value={productType} onChange={e => setProductType(e.target.value)} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="NEW_ESIM">New eSIM</option>
              <option value="ESIM">eSIM</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Compatibility policy</span>
            <select name="compatibilityPolicy" value={policy} onChange={e => setPolicy(e.target.value as any)} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="AT_LEAST">AT_LEAST (backing &gt;= custom allowance/validity)</option>
              <option value="EXACT">EXACT (backing == custom allowance/validity)</option>
            </select>
          </label>
        </div>
      </section>

      {/* Section 3 — Provider Backings */}
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="mb-1 text-base font-semibold text-gray-900">3. Provider Backings</h3>
        <p className="mb-4 text-xs text-gray-500">Assign one or more providers. Priority 1 = primary provider; priority 2+ = fallback.</p>

        {rows.length === 0 && <p className="text-sm text-gray-400">No providers configured.</p>}

        <div className="space-y-3">
          {rows.map((row, idx) => {
            const provider = providers.find(p => p.id === row.providerId)
            const providerPackages = provider?.packages || []
            return (
              <div key={row.rowKey} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {idx === 0 ? 'Primary provider' : 'Fallback provider'} · Priority {idx + 1}
                  </span>
                  {rows.length > 1 && (
                    <button type="button" onClick={() => removeRow(row.rowKey)} className="text-xs font-medium text-red-500 hover:text-red-700">Remove</button>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="block text-sm lg:col-span-1">
                    <span className="font-medium text-gray-700">Provider</span>
                    <select
                      value={row.providerId}
                      onChange={e => handleProviderChange(row.rowKey, e.target.value)}
                      className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    >
                      <option value="">Select provider</option>
                      {providers.map(p => {
                        const used = rows.some(r => r.rowKey !== row.rowKey && r.enabled && r.providerId === p.id)
                        return <option key={p.id} value={p.id} disabled={used}>{p.name}{used ? ' (already selected)' : ''}</option>
                      })}
                    </select>
                  </label>
                  <label className="block text-sm lg:col-span-2">
                    <span className="font-medium text-gray-700">Provider plan / package</span>
                    <select
                      value={row.providerPackageId}
                      onChange={e => setRow(row.rowKey, { providerPackageId: e.target.value })}
                      className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    >
                      <option value="">Select plan</option>
                      {providerPackages.map(pk => {
                        const used = rows.some(r => r.rowKey !== row.rowKey && r.enabled && r.providerPackageId === pk.id)
                        return (
                          <option key={pk.id} value={pk.id} disabled={used}>
                            {pk.name} — {pk.dataGB}GB/{pk.validityDays}d · {pk.country || pk.region || 'GLOBAL'} · {pk.currency} {pk.cost.toFixed(2)}
                          </option>
                        )
                      })}
                    </select>
                    {providerPackages.length === 0 && (
                      <p className="mt-1 text-xs text-amber-600">This provider has no eligible plans.</p>
                    )}
                  </label>
                  <label className="block text-sm lg:col-span-1">
                    <span className="font-medium text-gray-700">Priority</span>
                    <input
                      type="number"
                      min={1}
                      value={row.priority}
                      onChange={e => setRow(row.rowKey, { priority: Number(e.target.value) || 1 })}
                      className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </label>
                </div>
                <div className="mt-3 flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={row.enabled} onChange={e => setRow(row.rowKey, { enabled: e.target.checked })} className="rounded" />
                    Enabled
                  </label>
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-4">
          <button type="button" onClick={addRow} disabled={providers.length === 0 || rows.filter(r => r.enabled).length >= providers.length}
            className="rounded-lg border border-indigo-300 px-4 py-2 text-sm font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-40">
            + Add Provider
          </button>
        </div>
      </section>

      {/* Section 4 — Routing & Failover */}
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-semibold text-gray-900">4. Routing &amp; Failover</h3>
        <p className="mb-3 text-xs text-gray-500">
          Priority 1 is the primary provider. Priority 2+ are fallback candidates. Failover is only attempted when explicitly enabled.
        </p>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={allowFailover} onChange={e => setAllowFailover(e.target.checked)} className="rounded" />
          Allow failover to fallback providers
        </label>

        {reviewRows.length > 0 && (
          <div className="mt-4 rounded-lg bg-gray-50 p-4 text-sm">
            <p className="mb-2 font-medium text-gray-700">Ordered routing preview</p>
            <ol className="space-y-1 text-xs text-gray-600">
              {reviewRows.map(r => (
                <li key={`${r.priority}-${r.providerName}`}>
                  {r.priority} → {r.providerName} — {r.packageName} ({r.dataGB}GB/{r.validityDays}d)
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      {/* Section 5 — Pricing */}
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-semibold text-gray-900">5. Pricing</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Selling price *</span>
            <input name="sellingPrice" type="number" min={0.01} step="0.01" value={sellingPrice} onChange={e => setSellingPrice(Number(e.target.value) || 0)} required className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Currency</span>
            <input name="currency" value={currency} onChange={e => setCurrency(e.target.value.toUpperCase().slice(0, 3))} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>
        </div>
        <div className="mt-3 rounded-lg bg-gray-50 p-4 text-sm">
          <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-xs text-gray-600">
            <span>Backing providers: <strong>{orderedRows.length}</strong></span>
            <span>Total backing cost: <strong>{currency} {totalBackingCost.toFixed(2)}</strong></span>
            <span>Avg margin: <strong>{avgMarginPct != null ? avgMarginPct.toFixed(1) + '%' : '—'}</strong></span>
          </div>
        </div>
      </section>

      {/* Inline validation errors + warnings */}
      {validationErrors.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="mb-1 text-sm font-medium text-red-700">Validation errors</p>
          <ul className="list-disc list-inside space-y-0.5 text-sm text-red-700">
            {validationErrors.map((v, i) => <li key={i}>{v}</li>)}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="mb-1 text-sm font-medium text-amber-700">Compatibility warnings</p>
          <ul className="list-disc list-inside space-y-0.5 text-sm text-amber-700">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {/* Section 6 — Review */}
      <section className="rounded-xl border border-indigo-100 bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-semibold text-gray-900">6. Review</h3>
        <div className="rounded-lg bg-gray-50 p-4 text-sm">
          <p className="mb-2 font-semibold text-gray-800">CUSTOM PACKAGE</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600 sm:grid-cols-4">
            <span>Name: <strong>{name || '—'}</strong></span>
            <span>Data: <strong>{dataGB}GB</strong></span>
            <span>Validity: <strong>{validityDays}d</strong></span>
            <span>Selling price: <strong>{currency} {sellingPrice.toFixed(2)}</strong></span>
          </div>
          <p className="mb-1 mt-3 font-semibold text-gray-800">PROVIDER ROUTING</p>
          {reviewRows.length === 0 ? (
            <p className="text-xs text-gray-400">No backings configured.</p>
          ) : (
            <ol className="space-y-0.5 text-xs text-gray-600">
              {reviewRows.map(r => <li key={`rev-${r.priority}`}>{r.priority}. {r.providerName} — {r.packageName}</li>)}
            </ol>
          )}
          <p className="mb-1 mt-3 font-semibold text-gray-800">Failover</p>
          <p className="text-xs text-gray-600">{allowFailover ? 'Enabled' : 'Disabled'}</p>
          {warnings.length > 0 && (
            <>
              <p className="mb-1 mt-3 font-semibold text-amber-700">Warnings</p>
              <ul className="list-disc list-inside space-y-0.5 text-xs text-amber-700">
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button type="submit" disabled={busy || validationErrors.length > 0}
            className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? 'Creating…' : 'Create Custom Package'}
          </button>
          <a href="/admin/provider-catalog" className="rounded-lg border border-gray-300 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</a>
        </div>
      </section>
    </form>
  )
}
