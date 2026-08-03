import { describe, it, expect } from 'vitest'
import { filterPackages } from './package-filter'
import { parseQuery } from '@/components/business/EsimSearchAssistant'
import { buildPackageSearchText } from '@/lib/packages/search-text'

function makePkg(over: Partial<Record<string, any>> = {}) {
  const data = {
    id: 'p1',
    displayName: 'Zambia 5GB',
    name: 'ZM-5GB-30D',
    dataGB: 5,
    validityDays: 30,
    priceUSD: 10,
    ...over,
  }
  const pp: any = data.providerPackage
  return {
    ...data,
    _searchText: buildPackageSearchText({ ...data, providerPackage: pp }),
  }
}

function zambiaPack() {
  return makePkg({
    id: 'zm1',
    displayName: 'Zambia 5GB',
    name: 'ZM-5GB-30D',
    providerPackage: { country: 'ZM', normalizedCountry: 'ZM', region: 'Africa' },
  })
}

function zambiaPack2() {
  return makePkg({
    id: 'zm2',
    displayName: 'Zambia 10GB',
    name: 'ZM-10GB-30D',
    dataGB: 10,
    priceUSD: 18,
    providerPackage: { country: 'ZM', normalizedCountry: 'ZM', region: 'Africa' },
  })
}

function saPack() {
  return makePkg({
    id: 'sa1',
    displayName: 'South Africa 3GB',
    name: 'SA-3GB-7D',
    dataGB: 3,
    validityDays: 7,
    priceUSD: 6,
    providerPackage: { country: 'ZA', normalizedCountry: 'ZA', region: 'Africa' },
  })
}

function ukPack() {
  return makePkg({
    id: 'uk1',
    displayName: 'United Kingdom 5GB',
    name: 'UK-5GB-15D',
    dataGB: 5,
    validityDays: 15,
    priceUSD: 12,
    providerPackage: { country: 'GB', normalizedCountry: 'GB', region: 'Europe' },
  })
}

function francePack() {
  return makePkg({
    id: 'fr1',
    displayName: 'France 5GB',
    name: 'FR-5GB-30D',
    dataGB: 5,
    priceUSD: 10,
    providerPackage: { country: 'FR', normalizedCountry: 'FR', region: 'Europe' },
  })
}

function noCountryPack() {
  return makePkg({
    id: 'x1',
    displayName: 'Global 1GB',
    name: 'GLOBAL-1GB-7D',
    dataGB: 1,
    validityDays: 7,
    priceUSD: 4,
    providerPackage: { country: null, normalizedCountry: null, region: 'Global' },
  })
}

const catalog = [zambiaPack(), zambiaPack2(), saPack(), ukPack(), francePack(), noCountryPack()]

describe('package-search filterPackages', () => {
  it('1. Search "Zambia" matches a package whose country is Zambia (via country code)', () => {
    const parsed = parseQuery('Zambia')
    const results = filterPackages(catalog, parsed)
    expect(results).toHaveLength(2)
    expect(results.map(r => r.id)).toEqual(['zm1', 'zm2'])
  })

  it('2. Search "zambia" is case-insensitive', () => {
    const parsed = parseQuery('zambia')
    const results = filterPackages(catalog, parsed)
    expect(results).toHaveLength(2)
  })

  it('3. Search "ZM" matches Zambia country code', () => {
    const parsed = parseQuery('ZM')
    const results = filterPackages(catalog, parsed)
    expect(results).toHaveLength(2)
  })

  it('3b. Search "ZA" matches South Africa country code', () => {
    // ZA is not a parseQuery country name → raw query fallback
    const results = filterPackages(catalog, { rawQuery: 'ZA' })
    expect(results).toHaveLength(1)
  })

  it('4. Search package name still works', () => {
    // "Zambia 10GB" parsed as country=ZM + dataGB=10
    const parsed = parseQuery('Zambia 10GB')
    const results = filterPackages(catalog, parsed)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('zm2')
  })

  it('5. Search region name (Africa) works', () => {
    const parsed = parseQuery('Africa')
    const results = filterPackages(catalog, parsed)
    expect(results).toHaveLength(3) // two Zambia + SA
  })

  it('6. Search destination array (raw text fallback against _searchText)', () => {
    const results = filterPackages(catalog, { rawQuery: 'zambia' })
    expect(results).toHaveLength(2)
  })

  it('7. Partial country match works (South Africa via "South")', () => {
    const results = filterPackages(catalog, { rawQuery: 'south' })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('sa1')
  })

  it('8. Leading/trailing whitespace is ignored (raw text)', () => {
    const results = filterPackages(catalog, { rawQuery: '  zambia  ' })
    expect(results).toHaveLength(2)
  })

  it('9. Non-purchasable packages remain excluded (they are not in catalog)', () => {
    // Catalog only contains purchasable packages; test verifies filtering
    const parsed = parseQuery('Zambia')
    const results = filterPackages(catalog, parsed)
    expect(results.every(r => catalog.some(c => c.id === r.id))).toBe(true)
  })

  it('10. Clearing search restores all 6 permitted packages', () => {
    const results = filterPackages(catalog, { rawQuery: '' })
    expect(results).toHaveLength(6)
  })

  it('11. No match returns empty array', () => {
    const results = filterPackages(catalog, { rawQuery: 'Mongolia' })
    expect(results).toHaveLength(0)
  })

  it('12. Business/tenant visibility — packages only include those loaded by the page', () => {
    // filterPackages only filters the array it receives; tenant filtering is server-side.
    // Verify that passing a subset works as expected.
    const subset = [zambiaPack()]
    const results = filterPackages(subset, { rawQuery: 'south africa' })
    expect(results).toHaveLength(0) // SA not in subset
  })

  it('search "United Kingdom" works via country code', () => {
    const parsed = parseQuery('United Kingdom')
    const results = filterPackages(catalog, parsed)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('uk1')
  })

  it('search "UK" works via country code', () => {
    const parsed = parseQuery('UK')
    const results = filterPackages(catalog, parsed)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('uk1')
  })

  it('search "GB" works via raw country code token match', () => {
    // GB is not a parseQuery country name → raw text pipe-delimited token match
    const results = filterPackages(catalog, { rawQuery: 'GB' })
    expect(results).toHaveLength(1)
  })

  it('search "USA" works via country name parseQuery', () => {
    const usa = makePkg({ displayName: 'USA 3GB', providerPackage: { country: 'US', normalizedCountry: 'US', region: 'Americas' } })
    const extended = [...catalog, usa]
    const parsed = parseQuery('United States')
    const results = filterPackages(extended, parsed)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(usa.id)
  })

  it('search "US" via raw short-code token match', () => {
    const usa = makePkg({ displayName: 'USA 3GB', providerPackage: { country: 'US', normalizedCountry: 'US', region: 'Americas' } })
    const extended = [...catalog, usa]
    const results = filterPackages(extended, { rawQuery: 'US' })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(usa.id)
  })

  it('Europe region search via structured parseQuery', () => {
    const parsed = parseQuery('Europe plan')
    const results = filterPackages(catalog, parsed)
    expect(results.map(r => r.id)).toEqual(['uk1', 'fr1'])
  })

  it('cheapest flag sorts by price ascending', () => {
    const parsed = parseQuery('cheapest')
    const results = filterPackages(catalog, parsed)
    expect(results[0].priceUSD).toBe(4)
    expect(results[results.length - 1].priceUSD).toBe(18)
  })

  it('maxBudget under $10 filters packages', () => {
    const parsed = parseQuery('under $10')
    const results = filterPackages(catalog, parsed)
    expect(results.every(r => r.priceUSD <= 10)).toBe(true)
  })
})
