'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useMemo } from 'react'
import { MultiSelect } from './MultiSelect'
import type { DateRangePreset } from '@/lib/analytics/filters'
import { REGIONS } from '@/lib/analytics/filters'

const DATE_PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: 'all', label: 'All Time' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: 'thisMonth', label: 'This Month' },
  { value: 'lastMonth', label: 'Last Month' },
  { value: 'custom', label: 'Custom' },
]

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'EXPIRED', label: 'Expired' },
]

interface FilterBarProps {
  businesses: { id: string; name: string }[]
  packages: { id: string; name: string }[]
  providers: { id: string; name: string }[]
  countries: string[]
}

export function FilterBar({ businesses, packages, providers, countries }: FilterBarProps) {
  const router = useRouter()
  const sp = useSearchParams()

  const buildUrl = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(sp?.toString() || '')
    for (const [key, val] of Object.entries(updates)) {
      if (val === null || val === '') params.delete(key)
      else params.set(key, val)
    }
    const qs = params.toString()
    router.push(qs ? `/admin/analytics?${qs}` : '/admin/analytics')
  }, [router, sp])

  const readParam = (key: string, def: string = ''): string => sp?.get(key) || def
  const readMulti = (key: string): string[] => {
    const v = sp?.get(key)
    return v ? v.split(',').filter(Boolean) : []
  }

  const dateRange = readParam('dateRange', 'all') as DateRangePreset
  const dateFrom = readParam('dateFrom')
  const dateTo = readParam('dateTo')
  const selectedProviders = readMulti('providers')
  const selectedRegions = readMulti('regions')
  const selectedCountries = readMulti('countries')
  const selectedStatuses = readMulti('statuses')
  const businessId = readParam('businessId')
  const packageId = readParam('packageId')

  const providerOptions = useMemo(() => providers.map(p => ({ value: p.id, label: p.name })), [providers])
  const regionOptions = useMemo(() => REGIONS.map(r => ({ value: r, label: r })), [])
  const countryOptions = useMemo(() => countries.map(c => ({ value: c, label: c })), [countries])
  const statusOptions = STATUS_OPTIONS

  const handleClear = () => {
    router.push('/admin/analytics')
  }

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
      {/* Date Presets */}
      <div className="mb-3">
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Date Range</label>
        <div className="flex flex-wrap gap-1.5">
          {DATE_PRESETS.map(p => (
            <button
              key={p.value}
              type="button"
              onClick={() => {
                if (p.value === 'custom') {
                  buildUrl({ dateRange: 'custom', dateFrom: '', dateTo: '' })
                } else {
                  buildUrl({ dateRange: p.value, dateFrom: null, dateTo: null })
                }
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                dateRange === p.value
                  ? 'bg-cyan-600 text-white border-cyan-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {dateRange === 'custom' && (
          <div className="flex gap-3 mt-2">
            <div>
              <label className="block text-xs text-gray-500 mb-0.5">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={e => buildUrl({ dateFrom: e.target.value || null })}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-0.5">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={e => buildUrl({ dateTo: e.target.value || null })}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
              />
            </div>
          </div>
        )}
      </div>

      {/* Multi-select and Select filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <MultiSelect
          label="Provider"
          options={providerOptions}
          selected={selectedProviders}
          onChange={vals => buildUrl({ providers: vals.length > 0 ? vals.join(',') : null })}
        />
        <MultiSelect
          label="Region"
          options={regionOptions}
          selected={selectedRegions}
          onChange={vals => buildUrl({ regions: vals.length > 0 ? vals.join(',') : null })}
        />
        <MultiSelect
          label="Country"
          options={countryOptions}
          selected={selectedCountries}
          onChange={vals => buildUrl({ countries: vals.length > 0 ? vals.join(',') : null })}
        />
        <MultiSelect
          label="Status"
          options={statusOptions}
          selected={selectedStatuses}
          onChange={vals => buildUrl({ statuses: vals.length > 0 ? vals.join(',') : null })}
        />

        <div className="min-w-[180px]">
          <label className="block text-xs font-medium text-gray-500 mb-1">Business</label>
          <select
            value={businessId}
            onChange={e => buildUrl({ businessId: e.target.value || null })}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
          >
            <option value="">All Businesses</option>
            {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>

        <div className="min-w-[180px]">
          <label className="block text-xs font-medium text-gray-500 mb-1">Product / SKU</label>
          <select
            value={packageId}
            onChange={e => buildUrl({ packageId: e.target.value || null })}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
          >
            <option value="">All Products</option>
            {packages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        {/* Actions */}
        <div className="flex gap-2 items-end pb-0.5">
          <button
            type="button"
            onClick={handleClear}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
          >
            Clear Filters
          </button>
          <a
            href={sp?.toString() ? `/api/export/analytics-csv?${sp.toString()}` : '/api/export/analytics-csv'}
            className="inline-flex items-center rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 transition-colors"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export CSV
          </a>
          <button
            type="button"
            disabled
            className="inline-flex items-center rounded-lg border border-gray-300 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-400 cursor-not-allowed"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
            Export PDF
          </button>
        </div>
      </div>
    </div>
  )
}
