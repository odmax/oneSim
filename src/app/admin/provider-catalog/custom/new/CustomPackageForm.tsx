'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createCustomPackage } from '@/lib/actions/custom-package'
import type { CustomPackageCreationMode } from '@/lib/services/custom-package/types'

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

export interface BackingProviderOption {
  id: string
  name: string
  code: string
  status: string
  hasPurchaseCapability: boolean
  hasCustomPackageCreationCapability: boolean
  packages: ProviderPackageOption[]
}

export interface UpstreamProviderField {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'select'
  required: boolean
  options?: Array<{ value: string; label: string }>
}

export interface UpstreamProviderDefinition {
  providerFields: UpstreamProviderField[]
}

export interface UpstreamProviderOption {
  id: string
  name: string
  code: string
  status: string
  contractSupported: boolean
  implementationSupported: boolean
  accountEnabled: boolean
  gatedReason: string | null
  definition: UpstreamProviderDefinition | null
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

type Mode = CustomPackageCreationMode

export function CustomPackageForm({
  backingProviders,
  upstreamProviders,
}: {
  backingProviders: BackingProviderOption[]
  upstreamProviders: UpstreamProviderOption[]
}) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('EXISTING_BACKINGS')

  // Shared OneSIM product fields.
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [dataGB, setDataGB] = useState(10)
  const [validityDays, setValidityDays] = useState(30)
  const [countries, setCountries] = useState('')
  const [productType, setProductType] = useState<'NEW_ESIM' | 'TOP_UP' | 'BOTH'>('NEW_ESIM')
  const [currency, setCurrency] = useState('USD')
  const [sellingPrice, setSellingPrice] = useState(29.99)

  // Mode A state.
  const [policy, setPolicy] = useState<'AT_LEAST' | 'EXACT'>('AT_LEAST')
  const [allowFailover, setAllowFailover] = useState(false)
  const [rows, setRows] = useState<BackingRow[]>([{
    rowKey: newRowKey(),
    providerId: backingProviders[0]?.id || '',
    providerPackageId: backingProviders[0]?.packages[0]?.id || '',
    priority: 1,
    enabled: true,
  }])

  // Mode B state.
  const [upstreamProviderId, setUpstreamProviderId] = useState('')
  const [upstreamSku, setUpstreamSku] = useState('')
  const [providerValues, setProviderValues] = useState<Record<string, string | number | boolean>>({})
  const [upstreamConfirmed, setUpstreamConfirmed] = useState(false)

  // Stable Mode B idempotency key: generated ONCE when the admin first enters
  // mode B (survives double-click/back-button resubmit). Never regenerated on
  // each submit.
  const upstreamIdempotencyKeyRef = useRef<string | null>(null)
  function upstreamIdempotencyKey(): string {
    if (upstreamIdempotencyKeyRef.current) return upstreamIdempotencyKeyRef.current
    upstreamIdempotencyKeyRef.current = `cpb_upstream_${crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)}`
    return upstreamIdempotencyKeyRef.current
  }

  const [error, setError] = useState<string | null>(null)
  const [errorMeta, setErrorMeta] = useState<{ requiresReconciliation?: boolean; partialFailure?: boolean; operationId?: string; category?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const selectedUpstream = upstreamProviders.find(p => p.id === upstreamProviderId)

  function setRow(rowKey: string, patch: Partial<BackingRow>) {
    setRows(prev => prev.map(r => (r.rowKey === rowKey ? { ...r, ...patch } : r)))
  }

  function handleProviderChange(rowKey: string, providerId: string) {
    const provider = backingProviders.find(p => p.id === providerId)
    setRow(rowKey, { providerId, providerPackageId: provider?.packages[0]?.id || '' })
  }

  function addRow() {
    setRows(prev => {
      const usedProviders = new Set(prev.map(r => r.providerId))
      const nextProvider = backingProviders.find(p => !usedProviders.has(p.id))
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

  // ---- Mode A validation ----
  const enabledRows = rows.filter(r => r.enabled && r.providerPackageId)
  const validationErrors: string[] = []
  if (mode === 'EXISTING_BACKINGS') {
    if (enabledRows.length === 0) validationErrors.push('At least one enabled backing is required.')
    if (enabledRows.length > 0 && !enabledRows.some(r => r.priority === 1)) validationErrors.push('Priority 1 (primary provider) is required.')
    const priorities = enabledRows.map(r => r.priority)
    if (new Set(priorities).size !== priorities.length) validationErrors.push('Priorities must be unique.')
    if (priorities.some(p => p < 1)) validationErrors.push('Priority must be >= 1.')
    const packageIds = enabledRows.map(r => r.providerPackageId).filter(Boolean)
    if (new Set(packageIds).size !== packageIds.length) validationErrors.push('The same ProviderPackage cannot be selected twice.')
    const providerIds = enabledRows.map(r => r.providerId).filter(Boolean)
    if (new Set(providerIds).size !== providerIds.length) validationErrors.push('The same provider cannot be selected more than once unless it supports multiple distinct packages.')
  } else {
    if (!upstreamProviderId) validationErrors.push('Select an upstream provider.')
    if (!selectedUpstream?.accountEnabled) validationErrors.push('The selected provider is not enabled for upstream creation.')
    if (!upstreamSku.trim()) validationErrors.push('A provider SKU is required.')
    if (!upstreamConfirmed) validationErrors.push('Confirm the upstream mutation before creating.')
  }

  // ---- Mode A compatibility warnings ----
  const warnings: string[] = []
  if (mode === 'EXISTING_BACKINGS') {
    const selectedRows = rows.filter(r => r.enabled && r.providerPackageId)
    if (selectedRows.length > 1) {
      const valSet = new Set(selectedRows.map(r => {
        const p = backingProviders.find(pr => pr.id === r.providerId)?.packages.find(pk => pk.id === r.providerPackageId)
        return p ? `${p.validityDays}` : ''
      }))
      if (valSet.size > 1) warnings.push(`Selected providers have differing validity: ${[...valSet].join(', ')} days.`)
      const dataSet = new Set(selectedRows.map(r => {
        const p = backingProviders.find(pr => pr.id === r.providerId)?.packages.find(pk => pk.id === r.providerPackageId)
        return p ? `${p.dataGB}` : ''
      }))
      if (dataSet.size > 1) warnings.push(`Selected providers have differing data allowances: ${[...dataSet].join(', ')} GB.`)
    }
  }

  const orderedRows = [...enabledRows].sort((a, b) => a.priority - b.priority)
  const totalBackingCost = orderedRows.reduce((sum, r) => {
    const p = backingProviders.find(pr => pr.id === r.providerId)?.packages.find(pk => pk.id === r.providerPackageId)
    return sum + (p ? p.cost : 0)
  }, 0)

  const reviewRows = orderedRows.map(r => {
    const provider = backingProviders.find(pr => pr.id === r.providerId)
    const pkg = provider?.packages.find(pk => pk.id === r.providerPackageId)
    return { priority: r.priority, providerName: provider?.name || '?', packageName: pkg?.name || '?', dataGB: pkg?.dataGB, validityDays: pkg?.validityDays }
  })

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true); setError(null); setErrorMeta(null)
    if (validationErrors.length > 0) { setError(validationErrors[0]); setBusy(false); return }

    const fd = new FormData()
    fd.set('mode', mode)
    fd.set('name', name)
    fd.set('displayName', displayName || name)
    fd.set('description', description)
    fd.set('dataGB', String(dataGB))
    fd.set('validityDays', String(validityDays))
    fd.set('countries', countries)
    fd.set('productType', productType)
    fd.set('currency', currency)
    fd.set('sellingPrice', String(sellingPrice))

    if (mode === 'EXISTING_BACKINGS') {
      fd.set('compatibilityPolicy', policy)
      fd.set('allowFailover', allowFailover ? 'true' : 'false')
      for (const r of orderedRows) {
        fd.append('providerPackageIds', r.providerPackageId)
        fd.append('providerIds', r.providerId)
        fd.append('priorities', String(r.priority))
        fd.append('enabledFlags', String(r.enabled))
      }
    } else {
      fd.set('providerId', upstreamProviderId)
      fd.set('upstreamConfirmed', upstreamConfirmed ? 'true' : 'false')
      fd.set('upstreamIdempotencyKey', upstreamIdempotencyKey())
      fd.set('providerValues', JSON.stringify({ ...providerValues, sku: upstreamSku.trim() }))
    }

    try {
      const res = await createCustomPackage(fd)
      if (!res.success) {
        setError(res.error || 'Creation failed')
        setErrorMeta({
          requiresReconciliation: res.requiresReconciliation,
          partialFailure: res.partialFailure,
          operationId: res.operationId,
          category: res.category,
        })
        setBusy(false)
        return
      }
      router.push('/admin/packages?tab=catalog&success=custom_created')
      router.refresh()
    } catch {
      setError('Creation failed unexpectedly'); setBusy(false)
    }
  }

  const fieldTypeFor = (f: UpstreamProviderField): string => {
    if (f.type === 'number') return 'number'
    if (f.type === 'boolean') return 'checkbox'
    if (f.type === 'select') return 'select'
    return 'text'
  }

  function setProviderValue(key: string, value: string | number | boolean) {
    setProviderValues(prev => ({ ...prev, [key]: value }))
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* Mode selector */}
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-semibold text-gray-900">Creation Mode</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <label className={`cursor-pointer rounded-xl border p-4 ${mode === 'EXISTING_BACKINGS' ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200'}`}>
            <input type="radio" name="mode" value="EXISTING_BACKINGS" checked={mode === 'EXISTING_BACKINGS'} onChange={() => setMode('EXISTING_BACKINGS')} className="sr-only" />
            <span className="block font-medium text-gray-900">Build from Existing Provider Packages</span>
            <span className="block mt-1 text-xs text-gray-600">Create a OneSIM retail package backed by one or more existing provider packages. No new package is created at the provider.</span>
          </label>
          <label className={`cursor-pointer rounded-xl border p-4 ${mode === 'UPSTREAM_CREATE' ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200'}`}>
            <input type="radio" name="mode" value="UPSTREAM_CREATE" checked={mode === 'UPSTREAM_CREATE'} onChange={() => setMode('UPSTREAM_CREATE')} className="sr-only" />
            <span className="block font-medium text-gray-900">Create New Provider Package</span>
            <span className="block mt-1 text-xs text-gray-600">Define a new package and create the corresponding package/template with a provider that supports upstream package authoring.</span>
          </label>
        </div>
      </section>

      {/* Step 1 — Package Details (shared) */}
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-semibold text-gray-900">1. Package Details</h3>
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

      {/* Step 2 — Coverage & Allowance (shared) */}
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
            <select name="productType" value={productType} onChange={e => setProductType(e.target.value as any)} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="NEW_ESIM">New eSIM</option>
              <option value="BOTH">eSIM</option>
            </select>
          </label>
        </div>
      </section>

      {mode === 'EXISTING_BACKINGS' ? (
        <>
          {/* Mode A — Step 3 Provider Backings */}
          <section className="rounded-xl border bg-white p-5 shadow-sm">
            <h3 className="mb-1 text-base font-semibold text-gray-900">3. Provider Backings</h3>
            <p className="mb-4 text-xs text-gray-500">Assign one or more providers. Priority 1 = primary provider; priority 2+ = fallback.</p>
            <div className="space-y-3">
              {rows.map((row, idx) => {
                const provider = backingProviders.find(p => p.id === row.providerId)
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
                        <select value={row.providerId} onChange={e => handleProviderChange(row.rowKey, e.target.value)} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                          <option value="">Select provider</option>
                          {backingProviders.map(p => {
                            const used = rows.some(r => r.rowKey !== row.rowKey && r.enabled && r.providerId === p.id)
                            return <option key={p.id} value={p.id} disabled={used}>{p.name}{used ? ' (already selected)' : ''}</option>
                          })}
                        </select>
                      </label>
                      <label className="block text-sm lg:col-span-2">
                        <span className="font-medium text-gray-700">Provider plan / package</span>
                        <select value={row.providerPackageId} onChange={e => setRow(row.rowKey, { providerPackageId: e.target.value })} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
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
                        {providerPackages.length === 0 && <p className="mt-1 text-xs text-amber-600">This provider has no eligible plans.</p>}
                      </label>
                      <label className="block text-sm lg:col-span-1">
                        <span className="font-medium text-gray-700">Priority</span>
                        <input type="number" min={1} value={row.priority} onChange={e => setRow(row.rowKey, { priority: Number(e.target.value) || 1 })} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
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
              <button type="button" onClick={addRow} disabled={backingProviders.length === 0 || rows.filter(r => r.enabled).length >= backingProviders.length}
                className="rounded-lg border border-indigo-300 px-4 py-2 text-sm font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-40">
                + Add Provider
              </button>
            </div>
          </section>

          {/* Mode A — Step 4 Routing & Failover */}
          <section className="rounded-xl border bg-white p-5 shadow-sm">
            <h3 className="mb-3 text-base font-semibold text-gray-900">4. Routing &amp; Failover</h3>
            <p className="mb-3 text-xs text-gray-500">Priority 1 is the primary provider. Priority 2+ are fallback candidates. Failover is only attempted when explicitly enabled.</p>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={allowFailover} onChange={e => setAllowFailover(e.target.checked)} className="rounded" />
              Allow failover to fallback providers
            </label>
            {reviewRows.length > 0 && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4 text-sm">
                <p className="mb-2 font-medium text-gray-700">Ordered routing preview</p>
                <ol className="space-y-1 text-xs text-gray-600">
                  {reviewRows.map(r => <li key={`${r.priority}-${r.providerName}`}>{r.priority} → {r.providerName} — {r.packageName} ({r.dataGB}GB/{r.validityDays}d)</li>)}
                </ol>
              </div>
            )}
          </section>
        </>
      ) : (
        <>
          {/* Mode B — Step 3 Select Provider */}
          <section className="rounded-xl border bg-white p-5 shadow-sm">
            <h3 className="mb-3 text-base font-semibold text-gray-900">3. Select Provider</h3>
            <p className="mb-3 text-xs text-gray-500">Create against ONE upstream provider that supports package authoring.</p>
            {upstreamProviders.length === 0 ? (
              <p className="text-sm text-gray-400">No providers are currently enabled for upstream creation.</p>
            ) : (
              <select value={upstreamProviderId} onChange={e => setUpstreamProviderId(e.target.value)} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">Select provider</option>
                {upstreamProviders.map(p => (
                  <option key={p.id} value={p.id} disabled={!p.accountEnabled}>
                    {p.name}{p.accountEnabled ? '' : (p.gatedReason ? ` — ${p.gatedReason}` : ' — not enabled')}
                  </option>
                ))}
              </select>
            )}
            {selectedUpstream?.gatedReason && !selectedUpstream.accountEnabled && (
              <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">{selectedUpstream.gatedReason}</p>
            )}
            {selectedUpstream?.accountEnabled && (
              <p className="mt-2 rounded-lg border border-green-200 bg-green-50 p-2 text-xs text-green-700">Enabled for upstream creation.</p>
            )}
          </section>

          {/* Mode B — Step 4 Package Definition */}
          <section className="rounded-xl border bg-white p-5 shadow-sm">
            <h3 className="mb-3 text-base font-semibold text-gray-900">4. Package Definition</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="font-medium text-gray-700">Provider SKU *</span>
                <input name="upstreamSku" value={upstreamSku} onChange={e => setUpstreamSku(e.target.value)} required className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="e.g. TZN-5GB-7D" />
              </label>
              {selectedUpstream?.definition?.providerFields.map(f => {
                if (f.type === 'select') {
                  return (
                    <label key={f.key} className="block text-sm">
                      <span className="font-medium text-gray-700">{f.label}{f.required ? ' *' : ''}</span>
                      <select
                        value={String(providerValues[f.key] ?? '')}
                        onChange={e => setProviderValue(f.key, e.target.value)}
                        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      >
                        <option value="">Select…</option>
                        {(f.options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </label>
                  )
                }
                if (f.type === 'boolean') {
                  return (
                    <label key={f.key} className="flex items-center gap-2 text-sm text-gray-700">
                      <input type="checkbox" checked={!!providerValues[f.key]} onChange={e => setProviderValue(f.key, e.target.checked)} className="rounded" />
                      {f.label}
                    </label>
                  )
                }
                return (
                  <label key={f.key} className="block text-sm">
                    <span className="font-medium text-gray-700">{f.label}{f.required ? ' *' : ''}</span>
                    <input
                      type={fieldTypeFor(f)}
                      value={String(providerValues[f.key] ?? '')}
                      onChange={e => setProviderValue(f.key, f.type === 'number' ? (Number(e.target.value) || 0) : e.target.value)}
                      className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </label>
                )
              })}
            </div>
            {selectedUpstream && !selectedUpstream.accountEnabled && (
              <p className="mt-2 text-xs text-gray-500">Provider configuration locked: upstream creation is not enabled for this provider.</p>
            )}
          </section>

          {/* Mode B — Step 5 Pricing */}
          <section className="rounded-xl border bg-white p-5 shadow-sm">
            <h3 className="mb-3 text-base font-semibold text-gray-900">5. OneSIM Pricing</h3>
            <p className="mb-3 text-xs text-gray-500">The provider cost is only populated from the upstream contract when reliably supplied; otherwise the ProviderPackage uses MISSING/NOT_READY pricing semantics. Retail selling price is an explicit admin decision.</p>
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
          </section>
        </>
      )}

      {/* Inline validation errors + warnings */}
      {validationErrors.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="mb-1 text-sm font-medium text-red-700">Validation errors</p>
          <ul className="list-disc list-inside space-y-0.5 text-sm text-red-700">{validationErrors.map((v, i) => <li key={i}>{v}</li>)}</ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="mb-1 text-sm font-medium text-amber-700">Compatibility warnings</p>
          <ul className="list-disc list-inside space-y-0.5 text-sm text-amber-700">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p>{error}</p>
          {errorMeta?.requiresReconciliation && (
            <p className="mt-1 text-xs font-medium text-amber-700">
              Provider creation status could not be confirmed. Do not retry creation manually — reconciliation is required.
              {errorMeta.operationId ? ` Operation reference: ${errorMeta.operationId}` : ''}
            </p>
          )}
          {errorMeta?.partialFailure && !errorMeta?.requiresReconciliation && (
            <p className="mt-1 text-xs font-medium text-amber-700">
              Provider package was created, but OneSIM could not finish local setup. Recovery ("Resume setup") is available.
              {errorMeta.operationId ? ` Operation reference: ${errorMeta.operationId}` : ''}
            </p>
          )}
        </div>
      )}

      {/* Review */}
      <section className="rounded-xl border border-indigo-100 bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-semibold text-gray-900">Review</h3>
        <div className="rounded-lg bg-gray-50 p-4 text-sm">
          <p className="mb-2 font-semibold text-gray-800">ONESIM PRODUCT</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600 sm:grid-cols-4">
            <span>Name: <strong>{name || '—'}</strong></span>
            <span>Data: <strong>{dataGB}GB</strong></span>
            <span>Validity: <strong>{validityDays}d</strong></span>
            <span>Selling price: <strong>{currency} {sellingPrice.toFixed(2)}</strong></span>
          </div>

          {mode === 'EXISTING_BACKINGS' ? (
            <>
              <p className="mb-1 mt-3 font-semibold text-gray-800">PROVIDER ROUTING</p>
              {reviewRows.length === 0 ? <p className="text-xs text-gray-400">No backings configured.</p> : (
                <ol className="space-y-0.5 text-xs text-gray-600">{reviewRows.map(r => <li key={`rev-${r.priority}`}>{r.priority}. {r.providerName} — {r.packageName}</li>)}</ol>
              )}
              <p className="mb-1 mt-3 font-semibold text-gray-800">Failover</p>
              <p className="text-xs text-gray-600">{allowFailover ? 'Enabled' : 'Disabled'}</p>
            </>
          ) : (
            <>
              <p className="mb-1 mt-3 font-semibold text-gray-800">UPSTREAM PROVIDER</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600 sm:grid-cols-3">
                <span>Provider: <strong>{selectedUpstream?.name || '—'}</strong></span>
                <span>Creation type: <strong>upstream package/template</strong></span>
                <span>Package/template SKU: <strong>{upstreamSku || '—'}</strong></span>
              </div>
              {selectedUpstream?.definition?.providerFields.filter(f => providerValues[f.key] !== undefined && providerValues[f.key] !== '').map(f => (
                <p key={f.key} className="text-xs text-gray-600">{f.label}: <strong>{String(providerValues[f.key])}</strong></p>
              ))}
              <p className="text-xs text-gray-600">Expected upstream operation: <strong>create package/template with {selectedUpstream?.name || 'provider'}</strong></p>
            </>
          )}
        </div>

        {mode === 'UPSTREAM_CREATE' && (
          <>
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              This action will create a new package/template with the selected provider.
            </div>
            <label className="mt-3 flex items-start gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={upstreamConfirmed} onChange={e => setUpstreamConfirmed(e.target.checked)} className="mt-0.5 rounded" />
              <span>I understand this creates a package with the provider.</span>
            </label>
          </>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button type="submit" disabled={busy || validationErrors.length > 0}
            className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? 'Creating…' : mode === 'UPSTREAM_CREATE' ? 'Create & Create at Provider' : 'Create Custom Package'}
          </button>
          <a href="/admin/provider-catalog" className="rounded-lg border border-gray-300 px-6 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</a>
        </div>
      </section>
    </form>
  )
}