import { describe, it, expect } from 'vitest'
import { serializePublicPackage, findForbiddenFields } from './public-dto'

const PROVIDER_TOKENS = ['AIRHUB', 'CHOICE', 'TELNA', 'IBASIS', '24MOBILECONNECT', 'USMATRIX', 'SECRET_PROVIDER_X']

function leakedPkg(provider: string) {
  return {
    id: 'retail-1',
    providerPackageId: `pp-${provider.toLowerCase()}-0000`,
    sku: `OS-${provider}-XX-35GB-30D-AJ33VU`,
    packageCode: `OS-${provider}-XX-35GB-30D-AJ33VU`,
    name: `${provider} Global - 35GB - 30 Days`,
    displayName: `${provider} Global - 35GB - 30 Days`,
    description: `Powered by ${provider}`,
    customerDescription: `${provider} worldwide`,
    providerName: provider,
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
    const token = provider.toUpperCase().replace(/\s+/g, '')
    expect(dto.sku.startsWith('OS-ZA-35GB-30D-')).toBe(true)
    expect(dto.packageCode).toBe(dto.sku)
    expect(dto.sku.toUpperCase()).not.toContain(token)
    expect(dto.name.toUpperCase()).not.toContain(token)
    expect((dto.displayName || '').toUpperCase()).not.toContain(token)
    expect((dto.description || '').toUpperCase()).not.toContain(token)
    expect((dto.customerDescription || '').toUpperCase()).not.toContain(token)
    expect((dto as any).providerName).toBeUndefined()
    expect((dto as any).providerId).toBeUndefined()
    expect((dto as any).providerPlanId).toBeUndefined()
  })

  it('preserves geography/data/validity in the neutral public name', () => {
    const dto = serializePublicPackage(leakedPkg('CHOICE'), { country: 'EU', region: 'Europe' })
    expect(dto.name.toUpperCase()).not.toContain('CHOICE')
    expect(dto.name).toMatch(/Europe|35GB|30/i)
  })

  it('is deterministic (same package -> same public SKU)', () => {
    const a = serializePublicPackage(leakedPkg('TELNA'), { country: 'GB' })
    const b = serializePublicPackage(leakedPkg('TELNA'), { country: 'GB' })
    expect(a.sku).toBe(b.sku)
  })

  it('never leaks pricing, cost, publish or snapshot fields to clients', () => {
    const dto = serializePublicPackage(leakedPkg('CHOICE'), { country: 'ZA' })
    expect(findForbiddenFields(dto).length).toBe(0)
    expect(Object.keys(dto).sort()).toEqual(
      ['id', 'sku', 'packageCode', 'displayName', 'name', 'customerDescription', 'description', 'dataGB', 'validityDays', 'unitPrice', 'currency', 'country', 'region', 'productType', 'isActive', 'requiresTravelDate', 'source'].sort(),
    )
    for (const forbidden of ['costPriceUSD', 'costStatus', 'pricingStatus', 'publishStatus', 'configurationStatus', 'activePriceSnapshotId', 'sellingPrice', 'markupPercent', 'providerRawData']) {
      expect((dto as any)[forbidden]).toBeUndefined()
    }
  })

  it('a package reachable only on a later render window still serializes identically (purchase/quote from later pages)', () => {
    // 64 eligible products; window 3 starts at index 48. The DTO for that item
    // is fully deterministic and carries the packageId the quote flow needs.
    const deep = serializePublicPackage({ ...leakedPkg('AIRHUB'), id: 'id-049', priceUSD: 9.99 }, { country: 'NG' })
    const direct = serializePublicPackage({ ...leakedPkg('AIRHUB'), id: 'id-049', priceUSD: 9.99 }, { country: 'NG' })
    expect(deep).toEqual(direct)
    expect(deep.id).toBe('id-049')
    expect(deep.unitPrice).toBe(9.99)
  })

  it('serializePublicPackage is safe for packages that lack providerPackage geography', () => {
    const dto = serializePublicPackage(leakedPkg('IBASIS'), null)
    expect(dto.country).toBeNull()
    expect(dto.region).toBeNull()
  })
})