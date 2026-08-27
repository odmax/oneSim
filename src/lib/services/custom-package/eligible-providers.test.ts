import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindManyProviders, mockCountPackages, mockFindManyPackages, mockBuildConnector, mockReadiness } = vi.hoisted(() => ({
  mockFindManyProviders: vi.fn(),
  mockCountPackages: vi.fn(),
  mockFindManyPackages: vi.fn(),
  mockBuildConnector: vi.fn(),
  mockReadiness: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findMany: mockFindManyProviders },
    providerPackage: { count: mockCountPackages, findMany: mockFindManyPackages },
  },
}))

vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  buildConnectorFromProvider: mockBuildConnector,
}))

vi.mock('@/lib/providers/capability-state', () => ({
  getCustomPackageCreationReadiness: mockReadiness,
}))

import { getEligibleCustomPackageProviders, getEligibleProviderPackagesForProvider, getEligibleUpstreamCreationProviders } from './eligible-providers'

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

  it('CPB-UI-4-modeA: requires PURCHASE — provider with CUSTOM_PACKAGE_CREATION but no PURCHASE is NOT a Mode A backing provider', async () => {
    mockFindManyProviders.mockResolvedValue([
      provider('p-custom', { enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] }),
    ])
    const result = await getEligibleCustomPackageProviders()
    // Mode A (build-from-existing) requires PURCHASE; customPackageCreation alone
    // does NOT qualify a provider as a backing provider.
    expect(result).toHaveLength(0)
  })

  it('CPB-UI-4-modeA2: provider with PURCHASE but WITHOUT CUSTOM_PACKAGE_CREATION is eligible (Mode A)', async () => {
    mockFindManyProviders.mockResolvedValue([
      provider('p-purchase-only', { enabledCapabilities: ['PURCHASE'] }),
    ])
    const result = await getEligibleCustomPackageProviders()
    expect(result.map(r => r.id)).toEqual(['p-purchase-only'])
    expect(result[0].hasCustomPackageCreationCapability).toBe(false)
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

describe('getEligibleUpstreamCreationProviders — MODE B (capability-driven)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadiness.mockResolvedValue({ ready: false, reason: 'account-not-enabled' })
  })

  function upstreamConnector(overrides = {}) {
    return {
      constructor: { name: 'AnyConnector' },
      capabilities: { customPackageCreation: true, ...overrides },
      getCustomPackageDefinition: vi.fn().mockResolvedValue({ success: true, definition: { providerFields: [] } }),
      createCustomPackage: vi.fn(),
    }
  }

  it('CPB-UI-5: excludes providers without upstream creation support (AirHub/iBASIS/Rakuten/US-Matrix/Choice-not-enabled)', async () => {
    mockFindManyProviders.mockResolvedValue([
      provider('p-airhub', { code: 'AIRHUB', enabledCapabilities: ['PURCHASE'] }),
      provider('p-ibasis', { code: 'IBASIS', enabledCapabilities: ['PURCHASE'] }),
      provider('p-rakuten', { code: 'RAKUTEN', enabledCapabilities: ['PURCHASE'] }),
      provider('p-usmatrix', { code: 'USMATRIX', enabledCapabilities: ['PURCHASE'] }),
    ])
    mockBuildConnector.mockResolvedValue({ capabilities: { customPackageCreation: false } })
    const result = await getEligibleUpstreamCreationProviders()
    expect(result).toHaveLength(0)
    expect(mockReadiness).not.toHaveBeenCalled()
  })

  it('CPB-UI-5b: connector with customPackageCreation capability but missing createCustomPackage methods is NOT contract-supported', async () => {
    mockFindManyProviders.mockResolvedValue([provider('p-1', { enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] })])
    mockBuildConnector.mockResolvedValue({ capabilities: { customPackageCreation: true } }) // no methods
    const result = await getEligibleUpstreamCreationProviders()
    expect(result).toHaveLength(0)
  })

  it('CPB-UI-6: Choice qualifies for Mode B when capability + account enabled', async () => {
    mockFindManyProviders.mockResolvedValue([provider('p-choice', { code: 'CHOICE', enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] })])
    mockBuildConnector.mockResolvedValue(upstreamConnector())
    mockReadiness.mockResolvedValue({ ready: true })
    const result = await getEligibleUpstreamCreationProviders()
    expect(result).toHaveLength(1)
    expect(result[0].code).toBe('CHOICE')
    expect(result[0].accountEnabled).toBe(true)
    expect(result[0].contractSupported).toBe(true)
    expect(result[0].implementationSupported).toBe(true)
  })

  it('CPB-UI-7: Telna remains gated while accountEnabled=false (account certification required)', async () => {
    mockFindManyProviders.mockResolvedValue([provider('p-telna', { code: 'TELNA', enabledCapabilities: [] })])
    mockBuildConnector.mockResolvedValue(upstreamConnector())
    mockReadiness.mockResolvedValue({ ready: false, reason: 'account-not-enabled' })
    const result = await getEligibleUpstreamCreationProviders()
    expect(result).toHaveLength(1)
    expect(result[0].accountEnabled).toBe(false)
    expect(result[0].gatedReason).toContain('account certification required')
  })

  it('CPB-UI-8-modeB: US-Matrix remains gated while implementation not certified/wired', async () => {
    mockFindManyProviders.mockResolvedValue([provider('p-usmatrix', { code: 'USMATRIX', enabledCapabilities: [] })])
    // US-Matrix does NOT declare customPackageCreation → not contract-supported.
    mockBuildConnector.mockResolvedValue({ capabilities: { customPackageCreation: false } })
    const result = await getEligibleUpstreamCreationProviders()
    expect(result.map(r => r.id)).not.toContain('p-usmatrix')
    expect(mockReadiness).not.toHaveBeenCalled()
  })

  it('CPB-UI-11: never fabricates support flags — a connector without customPackageCreation is never surfaced', async () => {
    mockFindManyProviders.mockResolvedValue([provider('p-x', { code: 'X', enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] })])
    mockBuildConnector.mockResolvedValue(null)
    const result = await getEligibleUpstreamCreationProviders()
    expect(result).toHaveLength(0)
  })

  it('CPB-UI-10: provider-neutral — no provider-name branch; eligibility derived purely from capabilities', async () => {
    // A future provider code is eligible when capability + readiness line up.
    mockFindManyProviders.mockResolvedValue([provider('p-future', { code: 'SOME_FUTURE', enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] })])
    mockBuildConnector.mockResolvedValue(upstreamConnector())
    mockReadiness.mockResolvedValue({ ready: true })
    const result = await getEligibleUpstreamCreationProviders()
    expect(result).toHaveLength(1)
    expect(result[0].code).toBe('SOME_FUTURE')
    expect(result[0].accountEnabled).toBe(true)
  })
})
