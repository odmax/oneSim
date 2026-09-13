import { describe, it, expect } from 'vitest'
import { serializePublicPackage } from './public-dto'

const PROVIDER_TOKENS = ['AIRHUB', 'CHOICE', 'TELNA', 'IBASIS', '24MOBILECONNECT', 'USMATRIX', 'SECRET_PROVIDER_X']

function leakedPkg(provider: string) {
  return {
    id: 'retail-1',
    providerPackageId: `pp-${provider.toLowerCase()}-0000`,
    sku: `OS-${provider}-XX-35GB-30D-AJ33VU`,
    packageCode: `OS-${provider}-XX-35GB-30D-AJ33VU`,
    name: 'Regional 35GB',
    displayName: 'Regional 35GB Plan',
    customerDescription: null,
    description: null,
    dataGB: 35,
    validityDays: 30,
    priceUSD: 29.99,
    currency: 'USD',
    productType: 'NEW_ESIM',
    isActive: true,
    requiresTravelDate: false,
    source: 'CATALOG_PRODUCT',
  }
}

describe('serializePublicPackage — public catalog provider neutrality', () => {
  it.each(PROVIDER_TOKENS)('public API package DTO never exposes provider %s', (provider) => {
    const dto = serializePublicPackage(leakedPkg(provider), { country: 'ZA', region: null })
    expect(dto.sku.startsWith('OS-ZA-35GB-30D-')).toBe(true)
    expect(dto.packageCode).toBe(dto.sku)
    expect(dto.sku.toUpperCase()).not.toContain(provider.toUpperCase().replace(/\s+/g, ''))
    expect((dto as any).providerName).toBeUndefined()
    expect((dto as any).providerId).toBeUndefined()
    expect((dto as any).providerPlanId).toBeUndefined()
  })

  it('is deterministic (same package -> same public SKU)', () => {
    const a = serializePublicPackage(leakedPkg('TELNA'), { country: 'GB' })
    const b = serializePublicPackage(leakedPkg('TELNA'), { country: 'GB' })
    expect(a.sku).toBe(b.sku)
  })
})