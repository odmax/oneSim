'use client'

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { PackageBuyCard } from './PackageBuyCard'
import EsimSearchAssistant, { parseQuery, type ParsedQuery } from '@/components/business/EsimSearchAssistant'
import { filterPackages } from './package-filter'
import { countryFlagEntry, matchCountrySearch } from '@/lib/packages/country-flags'
import type { CountryFlagEntry } from '@/lib/packages/country-flags'

interface Props {
  packages: any[]
  walletBalance: number
}

interface CountryOption extends CountryFlagEntry {
  count: number
}

type SortMode = 'price-asc' | 'price-desc' | 'data-desc' | 'validity-desc'

const VALIDITY_FILTERS = [
  { label: 'All', days: 0 },
  { label: '1 Day', days: 1 },
  { label: '7 Days', days: 7 },
  { label: '15 Days', days: 15 },
  { label: '30 Days', days: 30 },
  { label: '60 Days', days: 60 },
  { label: '90 Days', days: 90 },
]

const SORT_OPTIONS: { label: string; value: SortMode }[] = [
  { label: 'Cheapest', value: 'price-asc' },
  { label: 'Most Data', value: 'data-desc' },
  { label: 'Longest Validity', value: 'validity-desc' },
]

function extractCountryCode(pkg: any): string | null {
  const st = (pkg._searchText || '').toLowerCase()
  const codes = ['za', 'ng', 'ke', 'gh', 'tz', 'ug', 'eg', 'ma', 'et', 'rw', 'ci', 'sn', 'cm', 'zm', 'mw', 'bw', 'na', 'mz', 'ao', 'sd', 'tn',
    'us', 'gb', 'de', 'fr', 'it', 'es', 'jp', 'kr', 'cn', 'in', 'ae', 'sa', 'tr', 'au', 'ca', 'br', 'mx', 'ar', 'id', 'th', 'ph', 'vn', 'my', 'sg',
    'pt', 'nl', 'be', 'ch', 'at', 'pl', 'se', 'no', 'dk', 'fi', 'ie', 'gr', 'cz']
  for (const code of codes) {
    const tokens = st.split(' | ')
    if (tokens.some((t: string) => t.trim() === code)) return code.toUpperCase()
  }
  return null
}

function buildCountryList(packages: any[]): CountryOption[] {
  const map = new Map<string, CountryOption>()
  for (const pkg of packages) {
    const code = extractCountryCode(pkg)
    if (!code) continue
    const entry = countryFlagEntry(code)
    if (!entry) continue
    const existing = map.get(code)
    if (existing) {
      existing.count++
    } else {
      map.set(code, { ...entry, count: 1 })
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
}

function sortPackages(packages: any[], mode: SortMode): any[] {
  const sorted = [...packages]
  switch (mode) {
    case 'price-asc':
      sorted.sort((a, b) => parseFloat(a.priceUSD?.toString?.() || '0') - parseFloat(b.priceUSD?.toString?.() || '0'))
      break
    case 'data-desc':
      sorted.sort((a, b) => (b.dataGB || 0) - (a.dataGB || 0))
      break
    case 'validity-desc':
      sorted.sort((a, b) => (b.validityDays || 0) - (a.validityDays || 0))
      break
  }
  return sorted
}

export function CountrySearchPage({ packages, walletBalance }: Props) {
  const [search, setSearch] = useState('')
  const [selectedCountry, setSelectedCountry] = useState<CountryOption | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>('price-asc')
  const [validityDays, setValidityDays] = useState(0)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [aiResults, setAiResults] = useState<any[] | null>(null)
  const [aiNoResults, setAiNoResults] = useState(false)
  const [aiQuery, setAiQuery] = useState('')
  const [listboxOpen, setListboxOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxRef = useRef<HTMLUListElement>(null)

  // Derive country list from packages
  const countries = useMemo(() => buildCountryList(packages), [packages])

  // Filter autocomplete
  const filteredCountries = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return countries
    return countries.filter(c => c.searchable.includes(q))
  }, [countries, search])

  // Filter packages by selected country + validity
  const displayPackages = useMemo(() => {
    let pkgs = aiResults || packages
    if (selectedCountry) {
      const code = selectedCountry.code.toLowerCase()
      pkgs = pkgs.filter((p: any) => {
        const tokens = (p._searchText || '').toLowerCase().split(' | ')
        return tokens.some((t: string) => t === code)
      })
    }
    if (validityDays > 0) {
      pkgs = pkgs.filter((p: any) => (p.validityDays || 0) >= validityDays)
    }
    return sortPackages(pkgs, sortMode)
  }, [packages, selectedCountry, validityDays, sortMode, aiResults])

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const opts = filteredCountries
    if (!opts.length) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex(i => Math.min(i + 1, opts.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      e.preventDefault()
      selectCountry(opts[highlightIndex])
    } else if (e.key === 'Escape') {
      setListboxOpen(false)
      inputRef.current?.blur()
    }
  }, [filteredCountries, highlightIndex])

  const selectCountry = useCallback((c: CountryOption) => {
    setSelectedCountry(c)
    setSearch(c.name)
    setListboxOpen(false)
    setAiResults(null)
    setAiNoResults(false)
    setHighlightIndex(-1)
  }, [])

  const clearCountry = useCallback(() => {
    setSelectedCountry(null)
    setSearch('')
    setAiResults(null)
    setAiNoResults(false)
  }, [])

  // ARIA: scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex >= 0 && listboxRef.current) {
      const el = listboxRef.current.children[highlightIndex] as HTMLElement | undefined
      el?.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightIndex])

  const handleAdvancedSearch = (query: ParsedQuery) => {
    const rawQuery = (query as any).rawQuery as string
    setAiQuery(rawQuery || '')
    const results = filterPackages(packages, query)
    setAiResults(results)
    setAiNoResults(results.length === 0)
    setSelectedCountry(null)
  }

  const clearAdvanced = () => {
    setAiResults(null)
    setAiNoResults(false)
    setAiQuery('')
  }

  return (
    <div className="space-y-5">
      {/* Search bar with autocomplete */}
      <div className="relative">
        <div className="relative">
          <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setListboxOpen(true); setHighlightIndex(-1) }}
            onFocus={() => setListboxOpen(true)}
            onBlur={() => setTimeout(() => setListboxOpen(false), 200)}
            onKeyDown={handleKeyDown}
            placeholder="Search destination..."
            role="combobox"
            aria-expanded={listboxOpen && filteredCountries.length > 0}
            aria-controls="country-listbox"
            aria-activedescendant={highlightIndex >= 0 ? `country-opt-${highlightIndex}` : undefined}
            aria-autocomplete="list"
            className="w-full rounded-xl border border-gray-200 bg-white pl-11 pr-4 py-3.5 text-base text-gray-900 placeholder:text-gray-400 focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20 shadow-sm"
          />
          {search && (
            <button onClick={clearCountry} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          )}
        </div>

        {/* Autocomplete dropdown */}
        {listboxOpen && filteredCountries.length > 0 && !selectedCountry && (
          <ul id="country-listbox" ref={listboxRef} role="listbox" className="absolute z-20 mt-1 w-full rounded-xl border border-gray-200 bg-white shadow-lg max-h-64 overflow-y-auto">
            {filteredCountries.map((c, i) => (
              <li
                key={c.code}
                id={`country-opt-${i}`}
                role="option"
                aria-selected={highlightIndex === i}
                onMouseDown={() => selectCountry(c)}
                onMouseEnter={() => setHighlightIndex(i)}
                className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer text-sm ${
                  highlightIndex === i ? 'bg-cyan-50 text-cyan-900' : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span className="text-lg">{c.flag}</span>
                <span className="font-medium flex-1">{c.name}</span>
                <span className="text-xs text-gray-400">{c.count} packages</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Selected country chip */}
      {selectedCountry && (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full bg-cyan-50 border border-cyan-200 px-3 py-1.5 text-sm font-medium text-cyan-800">
            <span className="text-base">{selectedCountry.flag}</span>
            {selectedCountry.name}
            <button onClick={clearCountry} className="ml-1 rounded-full p-0.5 text-cyan-500 hover:text-cyan-700 hover:bg-cyan-100">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </span>
        </div>
      )}

      {/* Sort + Validity filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Sort by</span>
          <select
            value={sortMode}
            onChange={e => setSortMode(e.target.value as SortMode)}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white focus:border-cyan-500 focus:outline-none"
          >
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {VALIDITY_FILTERS.map(f => (
            <button
              key={f.days}
              onClick={() => setValidityDays(f.days)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                validityDays === f.days
                  ? 'bg-cyan-600 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results count */}
      {displayPackages.length > 0 && (
        <p className="text-xs text-gray-400">
          {selectedCountry
            ? `${displayPackages.length} package${displayPackages.length !== 1 ? 's' : ''} for ${selectedCountry.flag} ${selectedCountry.name}`
            : `Showing ${displayPackages.length} of ${packages.length} packages`}
        </p>
      )}

      {/* Empty state */}
      {displayPackages.length === 0 && !aiNoResults && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center">
          <p className="text-sm text-gray-500">No packages found for</p>
          <p className="mt-1 text-lg font-semibold text-gray-700">&ldquo;{selectedCountry ? selectedCountry.name : search}&rdquo;</p>
          <button onClick={clearCountry} className="mt-4 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
            Clear Search
          </button>
        </div>
      )}

      {/* AI empty state */}
      {aiNoResults && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-8 text-center">
          <p className="text-sm text-gray-500">No matching packages found for &apos;{aiQuery}&apos;.</p>
          <button onClick={() => { clearAdvanced(); clearCountry() }} className="mt-2 text-sm text-cyan-600 hover:text-cyan-700">Show all packages</button>
        </div>
      )}

      {/* Package grid */}
      {displayPackages.length > 0 && (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {displayPackages.map((pkg: any) => (
            <PackageBuyCard key={pkg.id} pkg={pkg} walletBalance={walletBalance} />
          ))}
        </div>
      )}

      {/* Advanced search toggle */}
      <div className="border-t border-gray-100 pt-4">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-2 text-xs font-medium text-gray-400 hover:text-cyan-600 transition-colors"
        >
          <svg className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          Advanced Search
        </button>
        {showAdvanced && (
          <div className="mt-3">
            <EsimSearchAssistant onSearch={handleAdvancedSearch} onClear={clearAdvanced} />
            {aiResults && !aiNoResults && (
              <p className="mt-1 text-xs text-gray-400">AI: showing {aiResults.length} of {packages.length} packages</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
