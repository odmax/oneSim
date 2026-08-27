import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindManyProviders, mockCountPackages, mockFindManyPackages } = vi.hoisted(() => ({
  mockFindManyProviders: vi.fn(),
  mockCountPackages: vi.fn(),
  mockFindManyPackages: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findMany: mockFindManyProviders },
    providerPackage: { count: mockCountPackages, findMany: mockFindManyPackages },
  },
}))

import { getEligibleCustomPackageProviders, getEligibleProviderPackagesForProvider } from './eligible-providers'

function provider(id: string, overrides: any = {}) {
  return {
    id,
    name: 'Provider ' + id,
    code: 'PROV_' + id,
    status: 'ACTIVE',
    adapterStrategy: 'REST',
    enabledCapabilities: ['PURCHASE', 'STATUS', 'ESIM'],
    ...overrides,
  }
}

function pkg(id: string, providerId: string, overrides: any = {}) {
  return {
    id,
    providerId,
    name: 'Plan ' + id,
    dataGB: 10,
    validityDays: 30,
    country: 'ZAF',
    region: null,
    costPrice: { toString: () => '4' },
    sellingPrice: { toString: () => '8' },
    currency: 'USD',
    pricingStatus: 'READY',
    configurationStatus: 'CONFIGURED',
    publishStatus: 'PUBLISHED',
    ...overrides,
  }
}

describe('getEligibleCustomPackageProviders — provider-neutral eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCountPackages.mockResolvedValue(2)
  })

  it('CPB-UI-3: returns providers, one eligible provider is selectable', async () => {
    mockFindManyProviders.mockResolvedValue([provider('p-1')])
    const result = await getEligibleCustomPackageProviders()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('p-1')
    expect(result[0].eligiblePackageCount).toBe(2)
  })

  it('CPB-UI-4: multiple providers can be selected', async () => {
    mockFindManyProviders.mockResolvedValue([provider('p-1'), provider('p-2')])
    const result = await getEligibleCustomPackageProviders()
    expect(result).toHaveLength(2)
    expect(result.map(r => r.id)).toEqual(['p-1', 'p-2'])
  })

  it('CPB-UI-9: disabled/decommissioned/non-operational provider is excluded', async () => {
    const all = [
      provider('p-ok', { status: 'ACTIVE' }),
      provider('p-archived', { status: 'ARCHIVED' }),
      provider('p-inactive', { status: 'INACTIVE' }),
      provider('p-maintenance', { status: 'MAINTENANCE' }),
    ]
    // Simulate Prisma filtering by operational status.
    mockFindManyProviders.mockImplementation(async ({ where }: any) => {
      const ok = ['ACTIVE', 'DEGRADED', 'TESTING']
      return all.filter(p => ok.includes(p.status))
    })
    const result = await getEligibleCustomPackageProviders()
    expect(result.map(r => r.id)).toEqual(['p-ok'])
    // The underlying query must scope by operational statuses.
    const query = mockFindManyProviders.mock.calls[0][0]
    expect(query.where.status.in).toEqual(['ACTIVE', 'DEGRADED', 'TESTING'])
  })

  it('CPB-UI-10: provider without PURCHASE or CUSTOM_PACKAGE_CREATION capability is excluded', async () => {
    mockFindManyProviders.mockResolvedValue([
      provider('p-purchase', { enabledCapabilities: ['PURCHASE'] }),
      provider('p-no-cap', { enabledCapabilities: ['STATUS'] }),
    ])
    const result = await getEligibleCustomPackageProviders()
    expect(result.map(r => r.id)).toEqual(['p-purchase'])
  })

  it('CPB-UI-10b: provider with CUSTOM_PACKAGE_CREATION but no PURCHASE is eligible', async () => {
    mockFindManyProviders.mockResolvedValue([
      provider('p-custom', { enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] }),
    ])
    const result = await getEligibleCustomPackageProviders()
    expect(result.map(r => r.id)).toEqual(['p-custom'])
    expect(result[0].hasCustomPackageCreationCapability).toBe(true)
  })

  it('excludes providers with zero eligible ProviderPackages', async () => {
    mockFindManyProviders.mockResolvedValue([
      provider('p-1'),
      provider('p-2'),
    ])
    mockCountPackages.mockResolvedValueOnce(3).mockResolvedValueOnce(0)
    const result = await getEligibleCustomPackageProviders()
    expect(result.map(r => r.id)).toEqual(['p-1'])
  })

  it('never hard-codes a provider name (all names derived from data)', async () => {
    mockFindManyProviders.mockResolvedValue([provider('x-1'), provider('y-2')])
    const result = await getEligibleCustomPackageProviders()
    expect(result.every(r => r.name.startsWith('Provider '))).toBe(true)
  })
})

describe('getEligibleProviderPackagesForProvider — scope to provider', () => {
  beforeEach(() => vi.clearAllMocks())

  it('CPB-UI-8: provider package list is scoped to the selected provider', async () => {
    mockFindManyPackages.mockResolvedValue([pkg('pp-1', 'p-1'), pkg('pp-2', 'p-1')])
    const result = await getEligibleProviderPackagesForProvider('p-1')
    expect(result).toHaveLength(2)
    // The query must filter by providerId + eligible statuses.
    const query = mockFindManyPackages.mock.calls[0][0]
    expect(query.where.providerId).toBe('p-1')
    expect(query.where.sellingPrice.gt).toBe(0)
    expect(query.where.costPrice.gt).toBe(0)
  })
})
