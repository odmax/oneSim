import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPackage: { findMany: mockFindMany },
  },
}))

vi.mock('@/lib/providers/capabilities/exposure', () => ({
  isCapabilityExposedToPortal: vi.fn(async () => true),
  isCapabilityExposedToApi: vi.fn(async () => true),
}))

import { queryPurchasablePackages } from './query-purchasable'

function makeRetail(publishStatus: string, overrides: Record<string, any> = {}) {
  return {
    id: 'retail-1',
    priceUSD: 7.69,
    isActive: true,
    hiddenFromCatalog: false,
    archivedAt: null,
    source: 'CATALOG_PRODUCT',
    providerPackageId: 'pp-1',
    providerPackage: {
      country: 'ZA',
      region: null,
      normalizedCountry: 'ZA',
      providerRawData: null,
      costStatus: 'VALID',
      pricingStatus: 'READY',
      publishStatus,
      configurationStatus: 'CONFIGURED',
      activePriceSnapshotId: 'snap-1',
      sellingPrice: { toString: () => '7.69' },
      costPrice: { toString: () => '7.00' },
      providerId: 'prov-1',
    },
    provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'USMATRIX', id: 'prov-1' },
    ...overrides,
  } as any
}

describe('queryPurchasablePackages — client-facing flows stay strict PURCHASE', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindMany.mockReset()
  })

  it('READY package (otherwise valid) is NOT returned by portal query', async () => {
    mockFindMany.mockResolvedValue([makeRetail('READY')])
    const result = await queryPurchasablePackages('portal')
    expect(result).toHaveLength(0)
  })

  it('READY package (otherwise valid) is NOT returned by API query', async () => {
    mockFindMany.mockResolvedValue([makeRetail('READY')])
    const result = await queryPurchasablePackages('api')
    expect(result).toHaveLength(0)
  })

  it('PUBLISHED package with valid readiness + exposure IS returned by portal', async () => {
    mockFindMany.mockResolvedValue([makeRetail('PUBLISHED')])
    const result = await queryPurchasablePackages('portal')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('retail-1')
  })

  it('PUBLISHED package with valid readiness + exposure IS returned by API', async () => {
    mockFindMany.mockResolvedValue([makeRetail('PUBLISHED')])
    const result = await queryPurchasablePackages('api')
    expect(result).toHaveLength(1)
  })

  it('HIDDEN package is NOT returned', async () => {
    mockFindMany.mockResolvedValue([makeRetail('PUBLISHED', { hiddenFromCatalog: true })])
    const result = await queryPurchasablePackages('portal')
    expect(result).toHaveLength(0)
  })

  it('ARCHIVED package is NOT returned', async () => {
    mockFindMany.mockResolvedValue([makeRetail('ARCHIVED', { archivedAt: new Date() })])
    const result = await queryPurchasablePackages('portal')
    expect(result).toHaveLength(0)
  })

  it('provider-neutral: READY excluded and PUBLISHED included for every provider code', async () => {
    for (const code of ['USMATRIX', 'CHOICE', 'AIRHUB', 'IBASIS']) {
      mockFindMany.mockResolvedValue([makeRetail('READY', { provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code, id: 'prov-1' } })])
      expect(await queryPurchasablePackages('portal')).toHaveLength(0)
      mockFindMany.mockResolvedValue([makeRetail('PUBLISHED', { provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code, id: 'prov-1' } })])
      expect(await queryPurchasablePackages('portal')).toHaveLength(1)
    }
  })
})
