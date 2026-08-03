'use client'

import { useState } from 'react'
import { PackageBuyCard } from './PackageBuyCard'
import EsimSearchAssistant, { parseQuery, type ParsedQuery } from '@/components/business/EsimSearchAssistant'
import { filterPackages } from './package-filter'

interface Props {
  packages: any[]
  walletBalance: number
}

export function SearchablePackageGrid({ packages, walletBalance }: Props) {
  const [filtered, setFiltered] = useState<any[] | null>(null)
  const [noResults, setNoResults] = useState(false)
  const [lastQuery, setLastQuery] = useState<string>('')

  const handleSearch = (query: ParsedQuery) => {
    const rawQuery = (query as any).rawQuery as string | undefined
    setLastQuery(rawQuery || JSON.stringify(query))
    const results = filterPackages(packages, query)
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
          <p className="text-sm text-gray-500">No matching packages found for &apos;{lastQuery}&apos;.</p>
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
