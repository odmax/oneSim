import { describe, it, expect } from 'vitest'
import { derivePublicPackagePresentation, sanitizePublicText } from './public-package-presentation'

const PROVIDER_TOKENS = ['AIRHUB', 'CHOICE', 'TELNA', 'IBASIS', '24MOBILECONNECT', 'USMATRIX', 'SECRET_PROVIDER_X']

const REALISTIC_METADATA: Record<string, string> = {
  AIRHUB: 'Airhub USA 10GB 30 Days',
  CHOICE: 'Choice Europe 5GB 30 Days',
  TELNA: 'Telna Test - 1GB - Global - 7 Days',
  IBASIS: 'Powered by iBASIS global roaming',
  USMATRIX: 'USMatrix North America package',
  SECRET_PROVIDER_X: 'SECRET_PROVIDER_X Premium Asia 3GB',
}

describe('derivePublicPackagePresentation — provider-neutral public text', () => {
  it.each(PROVIDER_TOKENS)('%s identity is absent from name/displayName', (provider) => {
    const token = provider.toUpperCase().replace(/\s+/g, '')
    const p = derivePublicPackagePresentation({
      name: REALISTIC_METADATA[provider],
      displayName: REALISTIC_METADATA[provider],
      dataGB: 5,
      validityDays: 30,
      provider: { name: provider, code: provider },
      providerName: provider,
    })
    expect(p.name.toUpperCase()).not.toContain(token)
    expect(p.displayName?.toUpperCase() ?? '').not.toContain(token)
  })

  it.each(PROVIDER_TOKENS)('%s identity is absent from description/customerDescription prose', (provider) => {
    const token = provider.toUpperCase().replace(/\s+/g, '')
    const p = derivePublicPackagePresentation({
      name: REALISTIC_METADATA[provider],
      description: `Powered by ${provider} with global roaming`,
      customerDescription: `Includes ${provider} global coverage`,
      dataGB: 5,
      validityDays: 30,
      providerName: provider,
    })
    expect(p.description?.toUpperCase() ?? '').not.toContain(token)
    expect(p.customerDescription?.toUpperCase() ?? '').not.toContain(token)
  })

  it('sanitizes realistic "Telna Test - 1GB - Global - 7 Days" to a neutral name preserving geography', () => {
    const p = derivePublicPackagePresentation({
      name: 'Telna Test - 1GB - Global - 7 Days',
      displayName: 'Telna Test - 1GB - Global - 7 Days',
      country: 'Global',
      dataGB: 1,
      validityDays: 7,
      providerName: 'Telna',
    })
    expect(p.name.toUpperCase()).not.toContain('TELNA')
    expect(p.displayName?.toUpperCase() ?? '').not.toContain('TELNA')
    // Geography/data/validity survive.
    expect(p.name).toMatch(/Global/i)
    expect(p.name).toMatch(/1GB|GB/i)
    expect(p.name).toMatch(/7D|7 Days|Days/i)
  })

  it('preserves legitimate "Europe 5GB 30 Days" (provider word removed, geography kept)', () => {
    const p = derivePublicPackagePresentation({
      name: 'Choice Europe 5GB 30 Days',
      displayName: 'Choice Europe 5GB 30 Days',
      dataGB: 5,
      validityDays: 30,
      providerName: 'CHOICE',
    })
    expect(p.name.toUpperCase()).not.toContain('CHOICE')
    expect(p.name).toMatch(/Europe/i)
    expect(p.name).toMatch(/5GB/i)
    expect(p.name).toMatch(/30/i)
  })

  it('generates a neutral fallback when nothing meaningful survives', () => {
    const p = derivePublicPackagePresentation({
      name: 'TELNA',
      displayName: 'TELNA',
      dataGB: 1,
      validityDays: 7,
      country: 'Global',
      providerName: 'TELNA',
    })
    expect(p.name.toUpperCase()).not.toContain('TELNA')
    expect(p.name).toMatch(/OneSIM/i)
    expect(p.displayName).toBeTruthy()
  })

  it('preserves manually curated provider-neutral customer copy unchanged', () => {
    const p = derivePublicPackagePresentation({
      name: 'Telna Test - 1GB',
      displayName: 'Global Travel 1GB',
      customerDescription: 'Works in 200 countries',
      dataGB: 1,
      validityDays: 7,
      providerName: 'Telna',
    })
    expect(p.displayName).toBe('Global Travel 1GB')
    expect(p.customerDescription).toBe('Works in 200 countries')
  })

  it('is deterministic and stable', () => {
    const input = { name: 'Airhub USA 10GB 30 Days', displayName: 'Airhub USA 10GB 30 Days', dataGB: 10, validityDays: 30, providerName: 'Airhub' }
    expect(derivePublicPackagePresentation(input)).toEqual(derivePublicPackagePresentation(input))
  })

  it('case-insensitive provider variants (mixed case) do not leak', () => {
    const p = derivePublicPackagePresentation({
      name: 'aiRhUb USA 10GB',
      displayName: 'AirHuB USA 10GB',
      dataGB: 10,
      validityDays: 30,
      provider: { name: 'AirHub', code: 'AIRHUB' },
      providerName: 'Airhub Outreach',
    })
    const joined = `${p.name}\n${p.displayName ?? ''}`.toUpperCase().replace(/\s+/g, '')
    expect(joined).not.toContain('AIRHUB')
  })
})

describe('sanitizePublicText', () => {
  it('removes the provider token while keeping surrounding words', () => {
    expect(sanitizePublicText('Powerful iBASIS roaming bundle', null, 'iBASIS')).toBe('Powerful roaming bundle')
  })

  it('strips leading "Powered by ..." phrasing', () => {
    expect(sanitizePublicText('Powered by TELNA with global roaming', null, 'TELNA')).toBe('with global roaming')
  })

  it('handles the multi-word provider alias "24 Mobile Connect"', () => {
    expect(sanitizePublicText('24 Mobile Connect Asia 3GB', null, '24MOBILECONNECT')).not.toContain('Mobile Connect')
  })

  it('is case-insensitive', () => {
    expect(sanitizePublicText('IncludeS TELNA global', null, 'telna')).not.toContain('TELNA')
  })
})