interface PackageFilterQuery {
  rawQuery?: string
  country?: string | null
  region?: string | null
  dataGB?: number | null
  validityDays?: number | null
  maxBudget?: number | null
  cheapest?: boolean
}

/**
 * Pure filter for package search. Returns filtered results.
 * Uses the `_searchText` field (precomputed server-side) for country/region/name matching.
 * Falls back to a raw text search when no structured query fields are set.
 */
export function filterPackages(packages: any[], query: PackageFilterQuery): any[] {
  let results = [...packages]

  const hasCustomFilter = query.country || query.region || query.dataGB != null || query.validityDays != null || query.maxBudget != null || query.cheapest

  if (query.rawQuery && !hasCustomFilter) {
    const q = query.rawQuery.toLowerCase().trim()
    if (q.length <= 2) {
      // Short code — match pipe-delimited tokens to avoid false positives (e.g. "gb" in "10gb")
      results = results.filter(p => {
        const tokens = (p._searchText || '').toLowerCase().split(' | ')
        return tokens.some((t: string) => t === q)
      })
    } else {
      results = results.filter(p => (p._searchText || '').includes(q) || (p.displayName || p.name || '').toLowerCase().includes(q))
    }
  }

  if (query.country) {
    const term = query.country.toLowerCase()
    if (term.length <= 2) {
      // ISO country code — match pipe-delimited tokens only
      results = results.filter(p => {
        const tokens = (p._searchText || '').toLowerCase().split(' | ')
        return tokens.some((t: string) => t === term)
      })
    } else {
      // Country name — broad text match
      results = results.filter(p => {
        const st = ((p._searchText || '') + ' ' + (p.displayName || p.name || '')).toLowerCase()
        return st.includes(term)
      })
    }
  }

  if (query.region) {
    const regionLower = query.region.toLowerCase()
    results = results.filter(p => {
      const st = (p._searchText || '').toLowerCase()
      if (regionLower === 'europe' || regionLower === 'euro')
        return st.includes('europe') || st.includes('euro') || st.includes('eu')
      if (regionLower === 'asia') return st.includes('asia')
      if (regionLower === 'africa') return st.includes('africa')
      if (regionLower === 'global' || regionLower === 'worldwide')
        return st.includes('global') || st.includes('worldwide')
      return st.includes(regionLower)
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
      const price = parseFloat(p.priceUSD?.toString?.() || p.priceUSD || '0')
      return !isNaN(price) && price <= query.maxBudget!
    })
  }

  if (query.cheapest) {
    results.sort((a, b) => {
      const ap = parseFloat(a.priceUSD?.toString?.() || a.priceUSD || '0')
      const bp = parseFloat(b.priceUSD?.toString?.() || b.priceUSD || '0')
      return ap - bp
    })
  }

  return results
}
