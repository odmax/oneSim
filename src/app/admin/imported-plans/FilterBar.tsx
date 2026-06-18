'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback } from 'react'

interface ProviderOption {
  id: string; name: string; code: string
}

export default function FilterBar({ providers }: { providers: ProviderOption[] }) {
  const router = useRouter()
  const sp = useSearchParams()

  const setParam = useCallback((key: string, value: string | null) => {
    const p = new URLSearchParams(sp.toString())
    if (value) p.set(key, value); else p.delete(key)
    router.push(`/admin/imported-plans?${p.toString()}`)
  }, [router, sp])

  return (
    <div className="mb-6 flex flex-wrap items-end gap-3">
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Provider</label>
        <select onChange={e => setParam('provider', e.target.value || null)} defaultValue={sp.get('provider') || ''}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
          <option value="">All Providers</option>
          {providers.map(p => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
        <select onChange={e => setParam('status', e.target.value || null)} defaultValue={sp.get('status') || ''}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
          <option value="">All Statuses</option>
          <option value="unconfigured">Unconfigured</option>
          <option value="configured">Configured</option>
          <option value="ready_to_publish">Ready To Publish</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" defaultChecked={sp.get('costMissing') === '1'}
          onChange={e => setParam('costMissing', e.target.checked ? '1' : null)}
          className="h-4 w-4 rounded border-gray-300 text-emerald-600" />
        <span className="text-sm text-gray-600">Cost Missing</span>
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" defaultChecked={sp.get('hidden') === '1'}
          onChange={e => setParam('hidden', e.target.checked ? '1' : null)}
          className="h-4 w-4 rounded border-gray-300 text-emerald-600" />
        <span className="text-sm text-gray-600">Hidden from Catalog</span>
      </label>
      <div className="flex-1 min-w-[200px]">
        <input type="text" placeholder="Search name, SKU, plan ID, country..."
          defaultValue={sp.get('search') || ''}
          onKeyDown={e => { if (e.key === 'Enter') setParam('search', (e.target as HTMLInputElement).value || null) }}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
      </div>
      <div className="flex gap-2">
        <a href="/api/admin/imported-plans-csv/export" download
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm">
          Export CSV
        </a>
        <a href="/admin/packages"
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm">
          View Catalog
        </a>
      </div>
    </div>
  )
}
