import { describe, it, expect } from 'vitest'
import { buildPackageSearchText } from './search-text'

function pkg(over?: any) {
  return {
    displayName: 'Zambia 5GB',
    name: 'Zambia 5GB',
    providerPackage: { country: 'ZM', normalizedCountry: 'ZM', region: null },
    ...over,
  }
}

describe('buildPackageSearchText', () => {
  it('includes display name, country, and normalized country', () => {
    expect(buildPackageSearchText(pkg())).toBe('zambia 5gb | zm | zm')
  })

  it('includes name separately when different from displayName', () => {
    const s = buildPackageSearchText(pkg({ displayName: 'ZM Bundle', name: 'Zambia 5GB 30 day', providerPackage: { country: 'ZM', normalizedCountry: 'ZM', region: null } }))
    expect(s).toContain('zm bundle')
    expect(s).toContain('zambia 5gb 30 day')
    expect(s).toContain('zm')
  })

  it('includes region when available', () => {
    const s = buildPackageSearchText(pkg({ providerPackage: { country: 'FR', normalizedCountry: 'FR', region: 'Europe' } }))
    expect(s).toContain('europe')
    expect(s).toContain('fr')
  })

  it('supports partial country-name matching through combined text', () => {
    const s = buildPackageSearchText(pkg({ displayName: 'South Africa 3GB', providerPackage: { country: 'ZA', normalizedCountry: 'ZA', region: 'Africa' } }))
    expect(s.includes('south africa')).toBe(true)
    expect(s.includes('za')).toBe(true)
    expect(s.includes('africa')).toBe(true)
  })

  it('supports country-code matching', () => {
    expect(buildPackageSearchText(pkg({ providerPackage: { country: 'ZM', normalizedCountry: 'ZM', region: null } }))).toContain('zm')
    expect(buildPackageSearchText(pkg({ providerPackage: { country: 'GB', normalizedCountry: 'GB', region: null } }))).toContain('gb')
    expect(buildPackageSearchText(pkg({ providerPackage: { country: 'US', normalizedCountry: 'US', region: null } }))).toContain('us')
  })

  it('handles packages without providerPackage gracefully', () => {
    const s = buildPackageSearchText(pkg({ providerPackage: null }))
    expect(s).toBe('zambia 5gb')
    expect(s).not.toContain('zm')
  })

  it('handles packages without displayName', () => {
    const s = buildPackageSearchText({ name: 'ZM Plan', providerPackage: { country: 'ZM', normalizedCountry: 'ZM', region: null } })
    expect(s).toBe('zm plan | zm | zm')
  })
})
