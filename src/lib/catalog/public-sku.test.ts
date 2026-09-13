import { describe, it, expect } from 'vitest'
import { derivePublicSku, PUBLIC_SKU_PREFIX } from './public-sku'

const PROVIDER_TOKENS = ['AIRHUB', 'CHOICE', 'TELNA', 'IBASIS', '24MOBILECONNECT', 'USMATRIX', 'SECRET_PROVIDER_X']

describe('derivePublicSku — provider confidentiality', () => {
  it.each(PROVIDER_TOKENS)('never encodes the provider %s (uppercase and lowercase inputs)', (provider) => {
    // Feed the provider name/code as every provider-ish source we can imagine.
    const sku = derivePublicSku({
      id: `retail_${provider.toLowerCase()}`,
      providerPackageId: `pp_${provider.toLowerCase()}`,
      country: 'ZA',
      dataGB: 5,
      validityDays: 30,
    })
    expect(sku).toMatch(/^OS-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]+GB-[0-9]+D-[A-Z0-9]{6,}$/)
    expect(sku.toUpperCase()).not.toContain(provider.toUpperCase().replace(/\s+/g, ''))
    expect(sku).not.toContain(provider)
    expect(sku).not.toContain(provider.toLowerCase())
  })

  it('produces the documented neutral format OS-{COUNTRY}-{DATA}GB-{VALIDITY}D-{SUFFIX}', () => {
    const sku = derivePublicSku({ id: 'x1', providerPackageId: 'cmtpp123456', country: 'ZA', dataGB: 5, validityDays: 30 })
    expect(sku.startsWith('OS-ZA-5GB-30D-')).toBe(true)
    expect(sku.length).toBeGreaterThan('OS-ZA-5GB-30D-'.length)
  })

  it('uses XX when no country/region is available', () => {
    const sku = derivePublicSku({ id: 'x1', providerPackageId: 'pp-9', country: null, region: null, dataGB: 35, validityDays: 30 })
    expect(sku.startsWith('OS-XX-35GB-30D-')).toBe(true)
  })

  it('is deterministic and stable across identical inputs (no per-request randomness)', () => {
    const a = derivePublicSku({ id: 'retail-1', providerPackageId: 'cmtpp00000000000000000001', dataGB: 10, validityDays: 7, country: 'GB' })
    const b = derivePublicSku({ id: 'retail-1', providerPackageId: 'cmtpp00000000000000000001', dataGB: 10, validityDays: 7, country: 'GB' })
    expect(a).toBe(b)
  })

  it('two different retail packages of equal shape produce different suffixes (no cross-package alias)', () => {
    const a = derivePublicSku({ id: 'retail-a', providerPackageId: 'pp-aaaaaaaaaa', dataGB: 10, validityDays: 7, country: 'GB' })
    const b = derivePublicSku({ id: 'retail-b', providerPackageId: 'pp-bbbbbbbbbb', dataGB: 10, validityDays: 7, country: 'GB' })
    expect(a).not.toBe(b)
  })

it('never contains the internal provider package id in full (only a stable hash suffix)', () => {
  const full = 'clx1a2b3c4d5e6f7g8h9i0j1k'
  const sku = derivePublicSku({ id: 'retail-1', providerPackageId: full, dataGB: 20, validityDays: 30 })
  // The full upstream identity must never appear; the suffix is a non-invertible
  // stable hash, so even a word-bearing id cannot leak a provider token.
  expect(sku).not.toContain(full)
  expect(sku).toMatch(/^OS-XX-20GB-30D-[A-Z0-9]{6}$/)
})

  it('public prefix is OS-', () => {
    expect(PUBLIC_SKU_PREFIX).toBe('OS-')
  })
})