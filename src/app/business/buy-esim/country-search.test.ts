import { describe, it, expect } from 'vitest'
import { countryFlagEntry, matchCountrySearch } from '@/lib/packages/country-flags'

function makePkg(overrides: Record<string, any> = {}) {
  return {
    id: 'p1', displayName: 'Test 5GB', name: 'TEST', dataGB: 5, validityDays: 30,
    priceUSD: { toString: () => '10' },
    _searchText: 'test 5gb | test | zm | zm | africa',
    ...overrides,
  }
}

function extractCountryCode(pkg: any): string | null {
  const st = (pkg._searchText || '').toLowerCase()
  const codes = ['za', 'ng', 'ke', 'zm', 'us', 'gb', 'fr', 'jp', 'kr', 'in', 'ae', 'sa', 'tr', 'au', 'ca', 'br', 'mx', 'de', 'it', 'es']
  for (const code of codes) {
    const tokens = st.split(' | ')
    if (tokens.some((t: string) => t.trim() === code)) return code.toUpperCase()
  }
  return null
}

describe('country-flags utility', () => {
  it('returns flag entry for known country codes', () => {
    const za = countryFlagEntry('ZA')
    expect(za).toBeTruthy()
    if (za) {
      expect(za.name).toBe('South Africa')
      expect(za.code).toBe('ZA')
      expect(za.flag).toBeTruthy()
    }
  })

  it('returns flag entry for USA', () => {
    const us = countryFlagEntry('US')
    expect(us).toBeTruthy()
    if (us) {
      expect(us.name).toBe('United States')
      expect(us.searchable).toContain('usa')
      expect(us.searchable).toContain('america')
    }
  })

  it('returns flag entry for UK (GB code)', () => {
    const gb = countryFlagEntry('GB')
    expect(gb).toBeTruthy()
    if (gb) {
      expect(gb.name).toBe('United Kingdom')
      expect(gb.searchable).toContain('uk')
      expect(gb.searchable).toContain('britain')
    }
  })

  it('returns null for unknown country codes', () => {
    expect(countryFlagEntry('XX')).toBeNull()
    expect(countryFlagEntry(null)).toBeNull()
    expect(countryFlagEntry(undefined)).toBeNull()
  })
})

describe('matchCountrySearch', () => {
  it('matches "South Africa" → ZA', () => {
    expect(matchCountrySearch('South Africa')).toBe('ZA')
  })

  it('matches "south africa" case-insensitive', () => {
    expect(matchCountrySearch('south africa')).toBe('ZA')
  })

  it('matches "SA" (Saudi Arabia ISO code)', () => {
    // SA is Saudi Arabia's ISO code, ZA is South Africa's
    expect(matchCountrySearch('SA')).toBe('SA')
  })

  it('matches "ZA" (ISO code) → ZA', () => {
    expect(matchCountrySearch('ZA')).toBe('ZA')
  })

  it('matches "USA" → US', () => {
    expect(matchCountrySearch('USA')).toBe('US')
  })

  it('matches "US" (ISO code) → US', () => {
    expect(matchCountrySearch('US')).toBe('US')
  })

  it('matches "United Kingdom" → GB', () => {
    expect(matchCountrySearch('United Kingdom')).toBe('GB')
  })

  it('matches "UK" → GB', () => {
    expect(matchCountrySearch('UK')).toBe('GB')
  })

  it('matches "GB" (ISO code) → GB', () => {
    expect(matchCountrySearch('GB')).toBe('GB')
  })

  it('matches "France" → FR', () => {
    expect(matchCountrySearch('France')).toBe('FR')
  })

  it('matches "Fra" partial → FR', () => {
    expect(matchCountrySearch('Fra')).toBe('FR')
  })

  it('matches "Nigeria" → NG', () => {
    expect(matchCountrySearch('Nigeria')).toBe('NG')
  })

  it('matches "Nig" partial → NG', () => {
    expect(matchCountrySearch('Nig')).toBe('NG')
  })

  it('matches "United" partial → US (sorted key order)', () => {
    // 'united' matches both US and GB.
    // Since keys are iterated in object order, first match wins
    // US comes before GB in FLAG_DATA
    expect(matchCountrySearch('United')).toBe('US')
  })

  it('returns null for no match', () => {
    expect(matchCountrySearch('Mongolia')).toBeNull()
  })

  it('returns null for empty query', () => {
    expect(matchCountrySearch('')).toBeNull()
    expect(matchCountrySearch('  ')).toBeNull()
  })
})

describe('extractCountryCode from _searchText', () => {
  it('extracts ZM from a Zambia package', () => {
    expect(extractCountryCode(makePkg({ _searchText: 'zambia 5gb | zm-5gb-30d | zm | zm | africa' }))).toBe('ZM')
  })

  it('extracts ZA from a South Africa package', () => {
    expect(extractCountryCode(makePkg({ _searchText: 'south africa 3gb | sa-3gb-7d | za | za | africa' }))).toBe('ZA')
  })

  it('extracts GB from a UK package', () => {
    expect(extractCountryCode(makePkg({ _searchText: 'united kingdom 5gb | uk-5gb-15d | gb | gb | europe' }))).toBe('GB')
  })

  it('extracts US from a USA package', () => {
    expect(extractCountryCode(makePkg({ _searchText: 'usa 3gb | us-3gb-30d | us | us | americas' }))).toBe('US')
  })

  it('extracts FR from a France package', () => {
    expect(extractCountryCode(makePkg({ _searchText: 'france 5gb | fr-5gb-30d | fr | fr | europe' }))).toBe('FR')
  })

  it('returns null for packages without a country code', () => {
    expect(extractCountryCode(makePkg({ _searchText: 'global 1gb | global-1gb-7d' }))).toBeNull()
  })

  it('returns null for empty _searchText', () => {
    expect(extractCountryCode(makePkg({ _searchText: '' }))).toBeNull()
  })
})

describe('buildCountryList functionality', () => {
  it('deduplicates countries from packages', () => {
    const pkgs = [
      makePkg({ id: 'a', _searchText: 'zambia 5gb | zm-5gb-30d | zm | zm | africa' }),
      makePkg({ id: 'b', _searchText: 'zambia 10gb | zm-10gb-30d | zm | zm | africa' }),
      makePkg({ id: 'c', _searchText: 'south africa 3gb | sa-3gb-7d | za | za | africa' }),
    ]
    const codes = new Set<string>()
    for (const p of pkgs) {
      const c = extractCountryCode(p)
      if (c) codes.add(c)
    }
    expect(codes.size).toBe(2) // ZM + ZA
    expect(codes.has('ZM')).toBe(true)
    expect(codes.has('ZA')).toBe(true)
  })

  it('sorts countries alphabetically', () => {
    const pkgs = [
      makePkg({ _searchText: 'a | a | zm | zm | africa' }),
      makePkg({ _searchText: 'a | a | za | za | africa' }),
      makePkg({ _searchText: 'a | a | us | us | americas' }),
    ]
    const entries: { code: string; name: string }[] = []
    for (const p of pkgs) {
      const code = extractCountryCode(p)
      if (code) {
        const entry = countryFlagEntry(code)
        if (entry) entries.push(entry)
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    // South Africa, United States, Zambia
    expect(entries[0].code).toBe('ZA')
    expect(entries[1].code).toBe('US')
    expect(entries[2].code).toBe('ZM')
  })
})
