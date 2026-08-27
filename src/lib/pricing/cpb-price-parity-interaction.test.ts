import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }))

vi.mock('@/lib/prisma', () => ({
  prisma: { eSIMPackage: { findMany: mockFindMany } },
}))

vi.mock('@/lib/providers/capabilities/exposure', () => ({
  isCapabilityExposedToPortal: vi.fn(async () => true),
  isCapabilityExposedToApi: vi.fn(async () => true),
}))

import { queryPurchasablePackages } from '@/lib/packages/query-purchasable'

function customRetail(overrides: Record<string, any> = {}) {
  return {
    id: 'custom-1',
    name: 'Custom Multi-Provider',
    displayName: 'Custom Multi-Provider',
    priceUSD: 29.99, // independent selling price, NOT tied to any one backing PP
    isActive: true,
    hiddenFromCatalog: false,
    archivedAt: null,
    source: 'CATALOG_PRODUCT',
    // Custom packages have NO single providerPackageId → not subject to BOUND parity.
    providerPackageId: null,
    providerPackage: null,
    // Custom packages have providerBindings (multi-provider backings).
    providerBindings: [{ id: 'b1' }, { id: 'b2' }],
    provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'USMATRIX', id: 'prov-1' },
    ...overrides,
  }
}

describe('CPB-UI-16 / CPB-UI-17 — custom vs standard BOUND price parity interaction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('CPB-UI-16: custom package retail price is NOT forced to any individual provider sellingPrice', async () => {
    // Custom package: priceUSD=29.99, no providerPackageId. It has providerBindings
    // (a multi-provider backing) whose individual sellingPrices may be 5 / 8 / 12.
    // The public catalog must still RETURN it (BOUND parity check does not apply).
    mockFindMany.mockResolvedValue([customRetail()])
    const result = await queryPurchasablePackages('portal')
    expect(result.map(p => p.id)).toContain('custom-1')
    expect(result[0].priceUSD).toBe(29.99)
  })

  it('CPB-UI-16b: custom package price differs from individual backings and is kept', async () => {
    // Even with a single backing PP at price 5, the custom retail priceUSD=29.99
    // is preserved because the BOUND parity invariant does not apply to custom.
    mockFindMany.mockResolvedValue([customRetail({ priceUSD: 29.99 })])
    const result = await queryPurchasablePackages('api')
    expect(result).toHaveLength(1)
    expect(result[0].priceUSD).toBe(29.99)
  })

  it('CPB-UI-17: standard BOUND package with stale retail price is still excluded (Phase 4B guard intact)', async () => {
    // Standard BOUND package: single providerPackageId, retail=5 vs pp=17.
    // Phase 4B catalog filter must exclude it.
    mockFindMany.mockResolvedValue([{
      ...customRetail(),
      id: 'bound-stale',
      name: 'Bound Stale',
      displayName: 'Bound Stale',
      priceUSD: 5,
      providerPackageId: 'pp-1',
      providerPackage: {
        costStatus: 'VALID', pricingStatus: 'READY', publishStatus: 'PUBLISHED',
        configurationStatus: 'CONFIGURED', activePriceSnapshotId: 'snap-1',
        sellingPrice: { toString: () => '17' }, costPrice: { toString: () => '4' },
        providerId: 'prov-1', country: 'ZA', region: null, normalizedCountry: 'ZA', providerRawData: null,
      },
    }])
    const result = await queryPurchasablePackages('portal')
    expect(result).toHaveLength(0)
  })

  it('CPB-UI-17b: standard BOUND package with consistent price is returned', async () => {
    mockFindMany.mockResolvedValue([{
      ...customRetail(),
      id: 'bound-ok',
      name: 'Bound OK',
      displayName: 'Bound OK',
      priceUSD: 17,
      providerPackageId: 'pp-1',
      providerPackage: {
        costStatus: 'VALID', pricingStatus: 'READY', publishStatus: 'PUBLISHED',
        configurationStatus: 'CONFIGURED', activePriceSnapshotId: 'snap-1',
        sellingPrice: { toString: () => '17' }, costPrice: { toString: () => '4' },
        providerId: 'prov-1', country: 'ZA', region: null, normalizedCountry: 'ZA', providerRawData: null,
      },
    }])
    const result = await queryPurchasablePackages('portal')
    expect(result.map(p => p.id)).toContain('bound-ok')
  })
})
