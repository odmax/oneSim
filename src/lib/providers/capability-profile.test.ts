import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: { provider: { findUnique: vi.fn() }, $queryRawUnsafe: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  buildConnectorFromProvider: vi.fn(),
}))

vi.mock('@/lib/providers/capabilities/exposure', () => ({
  isCapabilityExposedToPortal: vi.fn().mockResolvedValue(true),
  isCapabilityExposedToApi: vi.fn().mockResolvedValue(true),
}))

const { prisma } = await import('@/lib/prisma')
const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
const { getProviderCapabilityProfile } = await import('./capability-profile')

const mockPrisma = vi.mocked(prisma)
const mockBuild = vi.mocked(buildConnectorFromProvider)

function choiceProvider() {
  return { id: 'p-1', code: 'CHOICE', name: 'Choice', supportsQRCode: false, supportsESIM: true, supportsUsage: false, supportsUsageSync: false, supportsTopUp: true, enabledCapabilities: [] }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.provider.findUnique.mockResolvedValue(choiceProvider() as any)
  mockBuild.mockResolvedValue({
    name: 'Choice Wireless',
    capabilities: { installationLookup: true, statusLookup: true, usageLookup: true, topUp: true, suspend: true, resume: true, balance: true, inventory: false, webhooks: false },
  } as any)
})

describe('getProviderCapabilityProfile', () => {
  it('reports connector capability from the connector, not the stale DB boolean', async () => {
    const profile = await getProviderCapabilityProfile('p-1')
    // DB supportsQRCode=false but connector declares installationLookup=true.
    expect(profile.connector?.capabilities.installationLookup).toBe(true)
    expect(profile.configured.supportsQRCode).toBe(false)
  })

  it('flags the installationLookup capability mismatch (connector true, DB flag false)', async () => {
    const profile = await getProviderCapabilityProfile('p-1')
    expect(profile.mismatches.some(m => m.capability === 'installationLookup')).toBe(true)
    const row = profile.matrix.find(r => r.capability === 'installationLookup')
    expect(row?.connector).toBe('SUPPORTED')
    expect(row?.dbConfigured).toBe(false)
    expect(row?.mismatch).toBe(true)
  })

  it('an unsupported connector reports NOT_SUPPORTED and no mismatch when the DB flag agrees', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue({ ...choiceProvider(), supportsQRCode: false } as any)
    mockBuild.mockResolvedValue({
      name: 'Generic',
      capabilities: { installationLookup: false, statusLookup: true, usageLookup: false, topUp: false, suspend: false, resume: false, balance: false, inventory: false, webhooks: false },
    } as any)
    const profile = await getProviderCapabilityProfile('p-1')
    const row = profile.matrix.find(r => r.capability === 'installationLookup')
    expect(row?.connector).toBe('NOT_SUPPORTED')
    expect(row?.dbConfigured).toBe(false)
    expect(row?.mismatch).toBe(false)
  })

  it('missing connector → capabilities NOT_IMPLEMENTED', async () => {
    mockBuild.mockResolvedValue(null as any)
    const profile = await getProviderCapabilityProfile('p-1')
    expect(profile.connector).toBeNull()
    expect(profile.matrix.find(r => r.capability === 'installationLookup')?.connector).toBe('NOT_IMPLEMENTED')
  })

  it('separates the four capability layers', async () => {
    const profile = await getProviderCapabilityProfile('p-1')
    expect(profile).toHaveProperty('connector')
    expect(profile).toHaveProperty('configured')
    expect(profile).toHaveProperty('exposure')
    expect(profile.matrix[0]).toHaveProperty('portalExposure')
    expect(profile.matrix[0]).toHaveProperty('apiExposure')
  })
})
