'use client'

import { useState, useMemo } from 'react'
import { PackageBuyCard } from './PackageBuyCard'
import EsimSearchAssistant, { parseQuery, type ParsedQuery } from '@/components/business/EsimSearchAssistant'

interface Props {
  packages: any[]
  walletBalance: number
}

const SAFE_COUNTRY_MAP: Record<string, string[]> = {
  'FR': ['france', 'french'],
  'DE': ['germany'],
  'IT': ['italy'],
  'ES': ['spain'],
  'GB': ['uk', 'united kingdom', 'britain', 'england'],
  'US': ['usa', 'united states', 'america'],
  'ZA': ['south africa', 'sa'],
  'KE': ['kenya'],
  'NG': ['nigeria'],
  'GH': ['ghana'],
  'TZ': ['tanzania'],
  'UG': ['uganda'],
  'EG': ['egypt'],
  'MA': ['morocco'],
  'JP': ['japan'],
  'KR': ['south korea', 'korea'],
  'AU': ['australia'],
  'CA': ['canada'],
  'IN': ['india'],
  'AE': ['uae', 'dubai', 'emirates'],
  'BR': ['brazil'],
  'MX': ['mexico'],
  'CN': ['china'],
  'TH': ['thailand'],
  'ID': ['indonesia'],
  'VN': ['vietnam'],
  'SG': ['singapore'],
  'MY': ['malaysia'],
  'PH': ['philippines'],
  'TR': ['turkey'],
  'SA': ['saudi arabia', 'saudi'],
  'AR': ['argentina'],
  'PT': ['portugal'],
  'NL': ['netherlands'],
  'BE': ['belgium'],
  'CH': ['switzerland'],
  'AT': ['austria'],
  'PL': ['poland'],
  'SE': ['sweden'],
  'NO': ['norway'],
  'DK': ['denmark'],
  'FI': ['finland'],
  'IE': ['ireland'],
  'GR': ['greece'],
  'CZ': ['czech', 'czech republic'],
}

export function SearchablePackageGrid({ packages, walletBalance }: Props) {
  const [filtered, setFiltered] = useState<any[] | null>(null)
  const [noResults, setNoResults] = useState(false)
  const [lastQuery, setLastQuery] = useState<string>('')

  const handleSearch = (query: ParsedQuery) => {
    setLastQuery(JSON.stringify(query))
    let results = [...packages]

    if (query.country) {
      const countryName = Object.entries(SAFE_COUNTRY_MAP).find(([_, names]) =>
        names.some(n => n.toLowerCase().includes(query.country!.toLowerCase()))
      )?.[0] || query.country.toUpperCase()

      results = results.filter(p => {
        const pkgName = (p.displayName || p.name || '').toLowerCase()
        const pkgCountry = (p.country || '').toLowerCase()
        const countryNames = SAFE_COUNTRY_MAP[countryName] || []
        const matchCountry = countryName.toLowerCase()
        return pkgName.includes(matchCountry) ||
               pkgName.includes(query.country!.toLowerCase()) ||
               pkgCountry === matchCountry ||
               countryNames.some(cn => pkgName.includes(cn))
      })
    }

    if (query.region) {
      const regionLower = query.region.toLowerCase()
      results = results.filter(p => {
        const name = (p.displayName || p.name || '').toLowerCase()
        if (regionLower === 'europe' || regionLower === 'euro')
          return name.includes('europe') || name.includes('euro') || name.includes('eu')
        if (regionLower === 'asia')
          return name.includes('asia')
        if (regionLower === 'africa')
          return name.includes('africa') || p.country === query.region
        if (regionLower === 'global' || regionLower === 'worldwide')
          return name.includes('global') || name.includes('worldwide')
        return name.includes(regionLower)
      })
    }

    if (query.dataGB != null) {
      const targetGB = query.dataGB
      results = results.filter(p => {
        const pkgGB = p.dataGB || 0
        return Math.abs(pkgGB - targetGB) <= 1 || pkgGB >= targetGB
      })
    }

    if (query.validityDays != null) {
      results = results.filter(p => {
        const days = p.validityDays || 0
        return Math.abs(days - query.validityDays!) <= 3
      })
    }

    if (query.maxBudget != null) {
      results = results.filter(p => {
        const price = parseFloat(p.priceUSD?.toString() || p.priceUSD || '0')
        return price <= query.maxBudget!
      })
    }

    if (query.cheapest) {
      results.sort((a, b) => {
        const ap = parseFloat(a.priceUSD?.toString() || a.priceUSD || '0')
        const bp = parseFloat(b.priceUSD?.toString() || b.priceUSD || '0')
        return ap - bp
      })
    }

    setFiltered(results)
    setNoResults(results.length === 0)
  }

  const handleClear = () => {
    setFiltered(null)
    setNoResults(false)
  }

  const displayPackages = filtered || packages

  return (
    <div className="space-y-4">
      <EsimSearchAssistant onSearch={handleSearch} onClear={handleClear} />
      {noResults ? (
        <div className="rounded-xl border-dashed border-2 border-gray-200 p-8 text-center">
          <p className="text-sm text-gray-500">No matching packages found for your search.</p>
          <button onClick={handleClear} className="mt-2 text-sm text-cyan-600 hover:text-cyan-700">Show all packages</button>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {displayPackages.map((pkg: any) => (
            <PackageBuyCard key={pkg.id} pkg={pkg} walletBalance={walletBalance} />
          ))}
        </div>
      )}
      {filtered && filtered.length > 0 && (
        <p className="text-xs text-gray-400 text-center">
          Showing {filtered.length} of {packages.length} packages
        </p>
      )}
    </div>
  )
}
