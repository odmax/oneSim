'use client'

import { useState, useCallback } from 'react'
import {
  telnaListCountries,
  telnaGetCompany,
  telnaListInventories,
  telnaListGroups,
  telnaGetWallet,
  telnaListPackageTemplates,
  telnaGetPackageTemplate,
  telnaMapPackageTemplate,
} from '@/lib/actions/telna-discovery'
import { telnaSyncPackages } from '@/lib/actions/telna-sync'
import type { TelnaCountry, TelnaCompany, TelnaInventory, TelnaGroup, TelnaWallet, TelnaPackageTemplate, MappedTelnaPackageTemplate } from '@/lib/providers/connectors/telna-endpoints'

type DiscoveryTab = 'countries' | 'inventories' | 'groups' | 'wallet' | 'packageTemplates' | 'sync'

const TABS: { key: DiscoveryTab; label: string }[] = [
  { key: 'countries', label: 'Countries' },
  { key: 'inventories', label: 'Inventories' },
  { key: 'groups', label: 'Groups' },
  { key: 'wallet', label: 'Wallet' },
  { key: 'packageTemplates', label: 'Package Templates' },
  { key: 'sync', label: 'Sync Packages' },
]

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    ACTIVE: 'bg-green-100 text-green-800',
    INACTIVE: 'bg-gray-100 text-gray-800',
    SUSPENDED: 'bg-red-100 text-red-800',
  }
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${colorMap[status] || 'bg-gray-100 text-gray-800'}`}>
      {status}
    </span>
  )
}

export function TelnaDiscoveryPanel({ providerId }: { providerId: string }) {
  const [tab, setTab] = useState<DiscoveryTab>('countries')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [countries, setCountries] = useState<TelnaCountry[] | null>(null)
  const [countryTotal, setCountryTotal] = useState(0)

  const [company, setCompany] = useState<TelnaCompany | null>(null)
  const [companyId, setCompanyId] = useState('')

  const [inventories, setInventories] = useState<TelnaInventory[] | null>(null)
  const [inventoryTotal, setInventoryTotal] = useState(0)
  const [invCompanyFilter, setInvCompanyFilter] = useState('')

  const [groups, setGroups] = useState<TelnaGroup[] | null>(null)
  const [groupTotal, setGroupTotal] = useState(0)
  const [groupInvFilter, setGroupInvFilter] = useState('')
  const [groupCompanyFilter, setGroupCompanyFilter] = useState('')

  const [wallet, setWallet] = useState<TelnaWallet | null>(null)
  const [walletId, setWalletId] = useState('')

  const [templates, setTemplates] = useState<TelnaPackageTemplate[] | null>(null)
  const [templateTotal, setTemplateTotal] = useState(0)
  const [templateInvFilter, setTemplateInvFilter] = useState('')
  const [templateOffset, setTemplateOffset] = useState(0)
  const [selectedTemplate, setSelectedTemplate] = useState<MappedTelnaPackageTemplate | null>(null)
  const [selectedTemplateRaw, setSelectedTemplateRaw] = useState<Record<string, unknown> | null>(null)
  const [templateDetailId, setTemplateDetailId] = useState('')
  const [templateDetailLoading, setTemplateDetailLoading] = useState(false)

  const [syncResult, setSyncResult] = useState<{ fetched: number; created: number; updated: number; archived: number; skipped: number; durationMs: number } | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const loadCountries = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await telnaListCountries(providerId, 50, 0)
      if (res.success && res.data) {
        setCountries(res.data.items)
        setCountryTotal(res.data.total)
      } else {
        setError(res.error?.message || 'Failed to load countries')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally { setLoading(false) }
  }, [providerId])

  const loadCompany = useCallback(async () => {
    if (!companyId) return
    setLoading(true); setError(null)
    try {
      const res = await telnaGetCompany(providerId, Number(companyId))
      if (res.success && res.data) {
        setCompany(res.data.company)
      } else {
        setError(res.error?.message || 'Company not found')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally { setLoading(false) }
  }, [providerId, companyId])

  const loadInventories = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await telnaListInventories(providerId, invCompanyFilter ? Number(invCompanyFilter) : undefined, 50, 0)
      if (res.success && res.data) {
        setInventories(res.data.items)
        setInventoryTotal(res.data.total)
      } else {
        setError(res.error?.message || 'Failed to load inventories')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally { setLoading(false) }
  }, [providerId, invCompanyFilter])

  const loadGroups = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await telnaListGroups(providerId, groupInvFilter ? Number(groupInvFilter) : undefined, groupCompanyFilter ? Number(groupCompanyFilter) : undefined, 50, 0)
      if (res.success && res.data) {
        setGroups(res.data.items)
        setGroupTotal(res.data.total)
      } else {
        setError(res.error?.message || 'Failed to load groups')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally { setLoading(false) }
  }, [providerId, groupInvFilter, groupCompanyFilter])

  const loadWallet = useCallback(async () => {
    if (!walletId) return
    setLoading(true); setError(null)
    try {
      const res = await telnaGetWallet(providerId, Number(walletId))
      if (res.success && res.data) {
        setWallet(res.data.wallet)
      } else {
        setError(res.error?.message || 'Wallet not found')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally { setLoading(false) }
  }, [providerId, walletId])

  const loadTemplates = useCallback(async (offset = 0) => {
    setLoading(true); setError(null); setTemplateOffset(offset)
    try {
      const res = await telnaListPackageTemplates(providerId, templateInvFilter ? Number(templateInvFilter) : undefined, 50, offset)
      if (res.success && res.data) {
        setTemplates(res.data.items)
        setTemplateTotal(res.data.total)
      } else {
        setError(res.error?.message || 'Failed to load package templates')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally { setLoading(false) }
  }, [providerId, templateInvFilter])

  const handleSync = useCallback(async () => {
    setSyncing(true); setSyncError(null); setSyncResult(null)
    try {
      const res = await telnaSyncPackages(providerId)
      if ('error' in res) {
        setSyncError(res.error || 'Sync failed')
      } else if (res.success) {
        setSyncResult(res.result)
      }
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : 'Unknown error')
    } finally { setSyncing(false) }
  }, [providerId])

  const loadTemplateDetail = useCallback(async () => {
    if (!templateDetailId) return
    setTemplateDetailLoading(true); setError(null)
    try {
      const res = await telnaMapPackageTemplate(providerId, Number(templateDetailId))
      if (res.success && res.data) {
        setSelectedTemplate(res.data)
        setSelectedTemplateRaw(res.data.rawData)
      } else {
        setError(res.error?.message || 'Template not found')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally { setTemplateDetailLoading(false) }
  }, [providerId, templateDetailId])

  const handleKeyDown = (fn: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') fn()
  }

  return (
    <div className="rounded-lg border bg-white p-6 shadow-sm">
      <h3 className="mb-4 text-lg font-semibold text-gray-900">Telna Discovery</h3>

      {/* Sub-tabs */}
      <div className="mb-4 flex gap-1 border-b border-gray-200">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setError(null) }}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'border-b-2 border-cyan-600 text-cyan-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {/* Countries Tab */}
      {tab === 'countries' && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-gray-600">Telna country catalog — {countryTotal} total countries</p>
            <button onClick={loadCountries} disabled={loading} className="rounded-lg bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
          {countries && countries.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">ID</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Name</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">ISO</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Code</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Region</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {countries.map(c => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono text-xs text-gray-500">{c.id}</td>
                      <td className="px-4 py-2 font-medium text-gray-900">{c.name}</td>
                      <td className="px-4 py-2 font-mono text-gray-700">{c.iso}</td>
                      <td className="px-4 py-2 font-mono text-gray-500">{c.code || '-'}</td>
                      <td className="px-4 py-2 text-gray-600">{c.region || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : countries && countries.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">No countries found. Click Refresh to load.</p>
          ) : (
            <p className="py-8 text-center text-sm text-gray-500">Click Refresh to load country catalog.</p>
          )}
        </div>
      )}

      {/* Inventories Tab */}
      {tab === 'inventories' && (
        <div>
          <div className="mb-3 flex items-center gap-3">
            <div className="flex-1">
              <label className="text-xs font-medium text-gray-500">Company ID filter</label>
              <input
                type="text"
                value={invCompanyFilter}
                onChange={e => setInvCompanyFilter(e.target.value)}
                onKeyDown={handleKeyDown(loadInventories)}
                placeholder="Optional company ID"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            <button onClick={loadInventories} disabled={loading} className="mt-5 self-start rounded-lg bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
          <p className="mb-3 text-xs text-gray-500">{inventoryTotal} total inventories</p>
          {inventories && inventories.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">ID</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Name</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Type</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Company</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Total</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Avail</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {inventories.map(inv => (
                    <tr key={inv.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono text-xs text-gray-500">{inv.id}</td>
                      <td className="px-4 py-2 font-medium text-gray-900">{inv.name}</td>
                      <td className="px-4 py-2 text-gray-600">{inv.type}</td>
                      <td className="px-4 py-2"><StatusBadge status={inv.status} /></td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-500">{inv.companyId}</td>
                      <td className="px-4 py-2 text-gray-700">{inv.totalSims}</td>
                      <td className="px-4 py-2 text-gray-700">{inv.availableSims}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : inventories && inventories.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">No inventories found.</p>
          ) : (
            <p className="py-8 text-center text-sm text-gray-500">Click Refresh to load inventories.</p>
          )}
        </div>
      )}

      {/* Groups Tab */}
      {tab === 'groups' && (
        <div>
          <div className="mb-3 flex items-center gap-3">
            <div className="flex-1">
              <label className="text-xs font-medium text-gray-500">Inventory ID filter</label>
              <input
                type="text"
                value={groupInvFilter}
                onChange={e => setGroupInvFilter(e.target.value)}
                onKeyDown={handleKeyDown(loadGroups)}
                placeholder="Optional inventory ID"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs font-medium text-gray-500">Company ID filter</label>
              <input
                type="text"
                value={groupCompanyFilter}
                onChange={e => setGroupCompanyFilter(e.target.value)}
                onKeyDown={handleKeyDown(loadGroups)}
                placeholder="Optional company ID"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            <button onClick={loadGroups} disabled={loading} className="mt-5 self-start rounded-lg bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
          <p className="mb-3 text-xs text-gray-500">{groupTotal} total groups</p>
          {groups && groups.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">ID</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Name</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Inventory</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Profile</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Total</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Avail</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {groups.map(g => (
                    <tr key={g.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono text-xs text-gray-500">{g.id}</td>
                      <td className="px-4 py-2 font-medium text-gray-900">{g.name}</td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-500">{g.inventoryId}</td>
                      <td className="px-4 py-2"><StatusBadge status={g.status} /></td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-500">{g.profileId ?? '-'}</td>
                      <td className="px-4 py-2 text-gray-700">{g.totalSims}</td>
                      <td className="px-4 py-2 text-gray-700">{g.availableSims}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : groups && groups.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">No groups found.</p>
          ) : (
            <p className="py-8 text-center text-sm text-gray-500">Set filters and click Refresh.</p>
          )}
        </div>
      )}

      {/* Package Templates Tab */}
      {tab === 'packageTemplates' && (
        <div>
          <div className="mb-3 flex items-center gap-3">
            <div className="flex-1">
              <label className="text-xs font-medium text-gray-500">Inventory ID filter</label>
              <input
                type="text"
                value={templateInvFilter}
                onChange={e => setTemplateInvFilter(e.target.value)}
                onKeyDown={handleKeyDown(() => loadTemplates(0))}
                placeholder="Optional inventory ID"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            <button onClick={() => loadTemplates(0)} disabled={loading} className="mt-5 self-start rounded-lg bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
          <p className="mb-3 text-xs text-gray-500">{templateTotal} total package templates</p>

          {/* Pagination */}
          {templateTotal > 50 && (
            <div className="mb-3 flex items-center gap-2 text-sm">
              <button
                onClick={() => loadTemplates(Math.max(0, templateOffset - 50))}
                disabled={templateOffset === 0 || loading}
                className="rounded border px-2 py-1 text-xs disabled:opacity-30"
              >
                Prev
              </button>
              <span className="text-gray-500">Page {Math.floor(templateOffset / 50) + 1} / {Math.ceil(templateTotal / 50)}</span>
              <button
                onClick={() => loadTemplates(templateOffset + 50)}
                disabled={templateOffset + 50 >= templateTotal || loading}
                className="rounded border px-2 py-1 text-xs disabled:opacity-30"
              >
                Next
              </button>
            </div>
          )}

          {templates && templates.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">ID</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Name</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Data</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Validity</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Coverage</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Currency</th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase text-gray-500">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {templates.map(t => {
                    const da = t.data_allowance
                    const ta = t.time_allowance
                    const dataStr = da ? `${da.value}${da.unit}` : '-'
                    const timeStr = ta ? `${ta.value} ${ta.unit}` : '-'
                    const coverageStr = t.countries && t.countries.length > 0
                      ? t.countries.slice(0, 2).map(c => c.name || c.iso || '').filter(Boolean).join(', ') + (t.countries.length > 2 ? '...' : '')
                      : t.zones && t.zones.length > 0 ? t.zones[0].name || t.zones[0].type || '-' : '-'
                    const cost = typeof t.price === 'number' ? t.price : t.charging?.amount ?? '-'
                    const currency = t.currency || t.charging?.currency || ''

                    return (
                      <tr key={t.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 font-mono text-xs text-gray-500">{t.id}</td>
                        <td className="px-4 py-2 font-medium text-gray-900 max-w-[200px] truncate" title={t.name}>{t.name}</td>
                        <td className="px-4 py-2 text-gray-600">{dataStr}</td>
                        <td className="px-4 py-2 text-gray-600">{timeStr}</td>
                        <td className="px-4 py-2 text-xs text-gray-500 max-w-[150px] truncate" title={coverageStr}>{coverageStr}</td>
                        <td className="px-4 py-2"><StatusBadge status={t.status || 'UNKNOWN'} /></td>
                        <td className="px-4 py-2 font-mono text-xs text-gray-600">{currency}</td>
                        <td className="px-4 py-2 text-gray-700">{cost !== '-' ? `$${cost}` : '-'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : templates && templates.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">No package templates found.</p>
          ) : (
            <p className="py-8 text-center text-sm text-gray-500">Click Refresh to load package templates.</p>
          )}

          {/* Template Detail Lookup */}
          <div className="mt-6 border-t pt-4">
            <h4 className="mb-3 text-sm font-semibold text-gray-700">Template Detail / Mapping</h4>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <input
                  type="text"
                  value={templateDetailId}
                  onChange={e => setTemplateDetailId(e.target.value)}
                  onKeyDown={handleKeyDown(loadTemplateDetail)}
                  placeholder="Enter package template ID"
                  className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                />
              </div>
              <button onClick={loadTemplateDetail} disabled={templateDetailLoading || !templateDetailId} className="self-start rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50">
                {templateDetailLoading ? 'Loading...' : 'Map Template'}
              </button>
            </div>
            {selectedTemplate && (
              <div className="mt-4 space-y-3">
                {/* Warnings */}
                {selectedTemplate.warnings.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <p className="mb-1 text-xs font-semibold text-amber-800">Mapping Warnings ({selectedTemplate.warnings.length})</p>
                    <ul className="list-inside list-disc text-xs text-amber-700">
                      {selectedTemplate.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                )}

                {/* Mapped Fields */}
                <div className="rounded-lg border bg-gray-50 p-4">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                    <div><dt className="text-xs font-medium text-gray-500">Template ID</dt><dd className="font-mono text-gray-900">{selectedTemplate.providerTemplateId}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Name</dt><dd className="text-gray-900">{selectedTemplate.name}</dd></div>
                    <div className="col-span-2"><dt className="text-xs font-medium text-gray-500">Description</dt><dd className="text-gray-700">{selectedTemplate.description || '-'}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Inventory ID</dt><dd className="font-mono text-gray-900">{selectedTemplate.inventoryId ?? '-'}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Status</dt><dd><StatusBadge status={selectedTemplate.status} /></dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Currency</dt><dd className="text-gray-900">{selectedTemplate.currency || '-'}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Cost</dt><dd className="text-gray-900">{selectedTemplate.providerCost != null ? `$${selectedTemplate.providerCost}` : '-'}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Data Allowance</dt><dd className="text-gray-900">
                      {selectedTemplate.unlimitedData ? 'Unlimited' : selectedTemplate.dataAllowance ? `${selectedTemplate.dataAllowance.value} ${selectedTemplate.dataAllowance.unit}` : '-'}
                    </dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Data (GB)</dt><dd className="text-gray-900">{selectedTemplate.dataGB != null ? selectedTemplate.dataGB : '-'}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Data (MB)</dt><dd className="text-gray-900">{selectedTemplate.dataMB != null ? selectedTemplate.dataMB : '-'}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Unlimited</dt><dd>{selectedTemplate.unlimitedData ? <span className="text-green-600 font-semibold">Yes</span> : 'No'}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Time Allowance</dt><dd className="text-gray-900">{selectedTemplate.timeAllowance ? `${selectedTemplate.timeAllowance.value} ${selectedTemplate.timeAllowance.unit}` : '-'}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Validity (Days)</dt><dd className="text-gray-900">{selectedTemplate.validityDays != null ? selectedTemplate.validityDays : <span className="text-amber-600">Not normalized</span>}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Countries</dt><dd className="text-gray-900">{(selectedTemplate.countries && selectedTemplate.countries.length > 0) ? selectedTemplate.countries.join(', ') : '-'}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Country Codes</dt><dd className="font-mono text-xs text-gray-900">{selectedTemplate.countryCodes.length > 0 ? selectedTemplate.countryCodes.join(', ') : '-'}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Regions</dt><dd className="text-gray-900">{selectedTemplate.regions.length > 0 ? selectedTemplate.regions.join(', ') : '-'}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Traffic Policy</dt><dd className="font-mono text-xs text-gray-900">{selectedTemplate.trafficPolicyId || '-'}</dd></div>
                    <div><dt className="text-xs font-medium text-gray-500">Route Policy</dt><dd className="font-mono text-xs text-gray-900">{selectedTemplate.routePolicyId || '-'}</dd></div>
                  </dl>
                </div>

                {/* Raw Response Preview */}
                <details className="rounded-lg border border-gray-200">
                  <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-gray-700">Raw Response Preview</summary>
                  <pre className="max-h-96 overflow-auto p-4 text-xs text-gray-600">{JSON.stringify(selectedTemplateRaw, null, 2)}</pre>
                </details>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Wallet Tab */}
      {tab === 'wallet' && (
        <div>
          <div className="mb-3 flex items-center gap-3">
            <div className="flex-1">
              <label className="text-xs font-medium text-gray-500">Wallet ID</label>
              <input
                type="text"
                value={walletId}
                onChange={e => setWalletId(e.target.value)}
                onKeyDown={handleKeyDown(loadWallet)}
                placeholder="Enter wallet ID"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            <button onClick={loadWallet} disabled={loading || !walletId} className="mt-5 self-start rounded-lg bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50">
              {loading ? 'Loading...' : 'Look Up'}
            </button>
          </div>
          {wallet ? (
            <div className="rounded-lg border bg-gray-50 p-4">
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div><dt className="text-xs font-medium text-gray-500">ID</dt><dd className="font-mono text-gray-900">{wallet.id}</dd></div>
                <div><dt className="text-xs font-medium text-gray-500">Name</dt><dd className="text-gray-900">{wallet.name}</dd></div>
                <div><dt className="text-xs font-medium text-gray-500">Currency</dt><dd className="text-gray-900">{wallet.currency}</dd></div>
                <div><dt className="text-xs font-medium text-gray-500">Balance</dt><dd className="text-gray-900">{wallet.balance}</dd></div>
                <div><dt className="text-xs font-medium text-gray-500">Status</dt><dd><StatusBadge status={wallet.status} /></dd></div>
                <div><dt className="text-xs font-medium text-gray-500">Company ID</dt><dd className="font-mono text-gray-900">{wallet.companyId}</dd></div>
                {wallet.minimumBalance !== undefined && (
                  <div><dt className="text-xs font-medium text-gray-500">Min Balance</dt><dd className="text-gray-900">{wallet.minimumBalance}</dd></div>
                )}
                {wallet.maximumBalance !== undefined && (
                  <div><dt className="text-xs font-medium text-gray-500">Max Balance</dt><dd className="text-gray-900">{wallet.maximumBalance}</dd></div>
                )}
                {wallet.lastTransactionDate && (
                  <div className="col-span-2"><dt className="text-xs font-medium text-gray-500">Last Transaction</dt><dd className="text-gray-900">{wallet.lastTransactionDate}</dd></div>
                )}
              </dl>
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-gray-500">Enter a Wallet ID and click Look Up.</p>
          )}

          {/* Company lookup (inline convenience) */}
          {company && (
            <div className="mt-4 rounded-lg border bg-blue-50 p-4">
              <h4 className="mb-2 text-sm font-semibold text-blue-800">Company Details</h4>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-xs font-medium text-blue-500">ID</dt><dd className="font-mono text-blue-900">{company.id}</dd></div>
                <div><dt className="text-xs font-medium text-blue-500">Name</dt><dd className="text-blue-900">{company.name}</dd></div>
                <div><dt className="text-xs font-medium text-blue-500">Code</dt><dd className="font-mono text-blue-900">{company.code}</dd></div>
                <div><dt className="text-xs font-medium text-blue-500">Status</dt><dd><StatusBadge status={company.status} /></dd></div>
              </dl>
            </div>
          )}
        </div>
      )}

      {/* Sync Packages Tab */}
      {tab === 'sync' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Sync Telna Packages</h3>
              <p className="text-sm text-gray-600">Fetch packages from Telna and synchronize into ProviderPackage catalog</p>
            </div>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
            >
              {syncing ? 'Syncing...' : 'Sync Packages'}
            </button>
          </div>

          {syncError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{syncError}</div>
          )}

          {syncResult && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <h4 className="mb-3 text-sm font-semibold text-green-800">Sync Complete</h4>
              <div className="grid grid-cols-6 gap-3 text-center text-xs">
                <div className="rounded bg-white p-2">
                  <p className="text-gray-500">Fetched</p>
                  <p className="text-lg font-bold text-gray-900">{syncResult.fetched}</p>
                </div>
                <div className="rounded bg-white p-2">
                  <p className="text-gray-500">Created</p>
                  <p className="text-lg font-bold text-emerald-600">{syncResult.created}</p>
                </div>
                <div className="rounded bg-white p-2">
                  <p className="text-gray-500">Updated</p>
                  <p className="text-lg font-bold text-amber-600">{syncResult.updated}</p>
                </div>
                <div className="rounded bg-white p-2">
                  <p className="text-gray-500">Archived</p>
                  <p className="text-lg font-bold text-red-600">{syncResult.archived}</p>
                </div>
                <div className="rounded bg-white p-2">
                  <p className="text-gray-500">Skipped</p>
                  <p className="text-lg font-bold text-gray-600">{syncResult.skipped}</p>
                </div>
                <div className="rounded bg-white p-2">
                  <p className="text-gray-500">Duration</p>
                  <p className="text-lg font-bold text-purple-600">{syncResult.durationMs}ms</p>
                </div>
              </div>
            </div>
          )}

          {!syncResult && !syncError && (
            <p className="py-8 text-center text-sm text-gray-500">Click &ldquo;Sync Packages&rdquo; to fetch and synchronize Telna packages into the catalog.</p>
          )}
        </div>
      )}
    </div>
  )
}
