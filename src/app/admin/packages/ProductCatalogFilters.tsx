'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

const PROVIDER_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Choice', value: 'CHOICE' },
  { label: 'AirHub', value: 'AIRHUB' },
  { label: 'iBASIS', value: 'IBASIS' },
  { label: 'Telna', value: 'TELNA' },
  { label: 'Custom', value: 'CUSTOM' },
] as const

const VALIDITY_OPTIONS = [
  { label: 'All', days: '' },
  { label: '1 Day', days: '1' },
  { label: '7 Days', days: '7' },
  { label: '15 Days', days: '15' },
  { label: '30 Days', days: '30' },
  { label: '60 Days', days: '60' },
  { label: '90 Days', days: '90' },
] as const

const SORT_OPTIONS = [
  { label: 'Cheapest', value: 'cheapest' },
  { label: 'Most Expensive', value: 'price-desc' },
  { label: 'Highest Margin', value: 'margin-desc' },
  { label: 'Lowest Margin', value: 'margin-asc' },
  { label: 'Data: Highest', value: 'data-desc' },
  { label: 'Validity: Longest', value: 'validity-desc' },
] as const

function buildQuery(tab: string, overrides: Record<string, string>): string {
  const params = new URLSearchParams()
  if (tab !== 'live') params.set('tab', tab)
  const s = overrides.search !== undefined ? overrides.search : ''
  if (s) params.set('search', s)
  const p = overrides.provider !== undefined ? overrides.provider : ''
  if (p) params.set('provider', p)
  const v = overrides.validity !== undefined ? overrides.validity : ''
  if (v) params.set('validity', v)
  const qs = params.toString()
  return qs ? `/admin/packages?${qs}` : '/admin/packages'
}

interface Props {
  tab: string
  search: string
  provider: string
  validity: string
  sort: string
}

export function ProductCatalogFilters({ tab, search: initialSearch, provider: providerFilter, validity: validityStr, sort: sortParam }: Props) {
  const router = useRouter()
  const [searchInput, setSearchInput] = useState(initialSearch)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  // Sync input when URL changes externally (e.g. tab change)
  useEffect(() => {
    setSearchInput(initialSearch)
  }, [initialSearch])

  // Debounced URL update on search change
  const onSearchChange = (value: string) => {
    setSearchInput(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const url = buildQuery(tab, { search: value })
      router.replace(url)
    }, 300)
  }

  // Clear search, preserve other filters
  const clearSearch = () => {
    setSearchInput('')
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const url = buildQuery(tab, { search: '' })
    router.replace(url)
  }

  return (
    <div className="mb-4 space-y-2">
      {/* Search — controlled input with debounced URL push */}
      <div className="relative">
        <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <input
          type="text"
          value={searchInput}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Search products, country, package code..."
          className="w-full rounded-xl border border-gray-200 bg-white pl-11 pr-10 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20 shadow-sm"
        />
        {searchInput && (
          <button onClick={clearSearch} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        )}
      </div>

      {/* Provider pills */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider w-14">Provider</span>
        {PROVIDER_OPTIONS.map(o => {
          const href = buildQuery(tab, { provider: o.value })
          const active = (providerFilter || '') === o.value
          return <a key={o.value || 'all'} href={href} className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{o.label}</a>
        })}
      </div>

      {/* Validity pills */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider w-14">Validity</span>
        {VALIDITY_OPTIONS.map(o => {
          const href = buildQuery(tab, { validity: o.days })
          const active = (validityStr || '') === o.days
          return <a key={o.days || 'all'} href={href} className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{o.label}</a>
        })}
      </div>

      {/* Sort + Clear */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider w-14">Sort</span>
        <form method="GET" action="/admin/packages" className="inline-flex items-center gap-1.5">
          {tab !== 'live' && <input type="hidden" name="tab" value={tab} />}
          {initialSearch && <input type="hidden" name="search" value={initialSearch} />}
          {providerFilter && <input type="hidden" name="provider" value={providerFilter} />}
          {Boolean(validityStr) && <input type="hidden" name="validity" value={validityStr} />}
          <select name="sort" defaultValue={sortParam} onChange={e => { (e.target.form as HTMLFormElement)?.submit() }}
            className="rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] font-medium text-gray-700 bg-white focus:border-cyan-500 focus:outline-none">
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </form>
        {(initialSearch || providerFilter || Boolean(validityStr)) && (
          <a href={tab === 'live' ? '/admin/packages' : `/admin/packages?tab=${tab}`} className="ml-2 rounded-lg border border-gray-300 px-2.5 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-50">Clear Filters</a>
        )}
      </div>
    </div>
  )
}
