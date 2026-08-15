import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    provider: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  buildConnectorFromProvider: vi.fn(),
}))

const { prisma } = await import('@/lib/prisma')
const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
const { lookupEsimInstallationData, persistInstallationLookup } = await import('./installation-lookup')

const mockPrisma = vi.mocked(prisma)
const mockBuild = vi.mocked(buildConnectorFromProvider)

const esim = {
  id: 'esim-1',
  iccid: '89012345678901234567',
  imsi: null,
  imsiVersion: null,
  providerSubscriptionId: null,
  providerActivationId: null,
  purchase: { package: { providerId: 'p-1' } },
}

function choiceConnector(overrides: any = {}) {
  return {
    name: 'Choice Wireless',
    capabilities: { installationLookup: true },
    lookupInstallationData: vi.fn().mockResolvedValue({
      success: true, state: 'READY', data: { qrCodeUrl: 'https://qr.example/q.png' },
    }),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.eSIM.findUnique.mockResolvedValue({ ...esim })
  mockPrisma.provider.findUnique.mockResolvedValue({ id: 'p-1', code: 'CHOICE', name: 'Choice Wireless', supportsQRCode: false })
  mockBuild.mockResolvedValue(choiceConnector() as any)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('lookupEsimInstallationData — canonical service', () => {
  it('resolves the provider through esim.purchase.package.providerId', async () => {
    await lookupEsimInstallationData('esim-1')
    expect(mockPrisma.provider.findUnique).toHaveBeenCalledWith({ where: { id: 'p-1' } })
  })

  it('missing provider → PERMANENT_FAILURE PROVIDER_NOT_FOUND', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue({ ...esim, purchase: { package: { providerId: null } } })
    const result = await lookupEsimInstallationData('esim-1')
    expect(result.state).toBe('PERMANENT_FAILURE')
    expect(result.errorCode).toBe('PROVIDER_NOT_FOUND')
  })

  it('missing identifier → IDENTIFIER_MISSING (never a local id)', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue({
      id: 'esim-1', iccid: null, imsi: null, imsiVersion: null, providerSubscriptionId: null, providerActivationId: null,
      purchase: { package: { providerId: 'p-1' } },
    })
    let captured: any = null
    mockBuild.mockImplementation(() => { captured = choiceConnector(); return captured })
    const result = await lookupEsimInstallationData('esim-1')
    expect(result.state).toBe('PERMANENT_FAILURE')
    expect(result.errorCode).toBe('IDENTIFIER_MISSING')
    expect(captured.lookupInstallationData).not.toHaveBeenCalled()
  })

  it('connector without lookupInstallationData → NOT_SUPPORTED', async () => {
    mockBuild.mockResolvedValue({ name: 'Generic', capabilities: { installationLookup: false } } as any)
    const result = await lookupEsimInstallationData('esim-1')
    expect(result.state).toBe('NOT_SUPPORTED')
    expect(result.errorCode).toBe('LOOKUP_NOT_SUPPORTED')
  })

  it('a provider with DB supportsQRCode=false still uses the connector lookup (DB flag is not runtime truth)', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue({ id: 'p-1', code: 'CHOICE', name: 'Choice', supportsQRCode: false })
    const connector = choiceConnector()
    mockBuild.mockResolvedValue(connector as any)
    const result = await lookupEsimInstallationData('esim-1')
    expect(connector.lookupInstallationData).toHaveBeenCalledTimes(1)
    expect(result.state).toBe('READY')
    expect(result.data?.qrCodeUrl).toBe('https://qr.example/q.png')
  })

  it('passes a safe canonical identifier (iccid/imsi/refs), never a local esim.id', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue({ ...esim, imsi: '310410123456789', providerActivationId: 'act-9' })
    const connector = choiceConnector()
    mockBuild.mockResolvedValue(connector as any)
    await lookupEsimInstallationData('esim-1')
    const input = connector.lookupInstallationData.mock.calls[0][0]
    expect(input).toMatchObject({ esimId: 'esim-1', iccid: '89012345678901234567', imsi: '310410123456789', providerActivationId: 'act-9' })
    expect(Object.keys(input)).not.toContain('localId')
  })

  it('logs a safe [INSTALLATION_LOOKUP] diagnostic', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await lookupEsimInstallationData('esim-1')
    const line = logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('[INSTALLATION_LOOKUP]'))
    expect(line).toContain('esimId=esim-1')
    expect(line).toContain('resultState=READY')
    expect(line).toContain('connector=Choice Wireless')
    logSpy.mockRestore()
  })
})

describe('persistInstallationLookup — fill-only merge, no null overwrite', () => {
  it('only fills missing fields and never overwrites with null/empty', async () => {
    mockPrisma.eSIM.update.mockResolvedValue({})
    const persisted = await persistInstallationLookup('esim-1', { qrCodeUrl: 'https://old.example/x.png', activationCode: null }, { qrCodeUrl: 'https://new.example/y.png', activationCode: 'LPA:1$s$c' })
    expect(persisted.qrCodeUrl).toBeUndefined() // already present, not overwritten
    expect(persisted.activationCode).toBe('LPA:1$s$c') // missing field filled
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ activationCode: 'LPA:1$s$c' }),
    }))
    expect(mockPrisma.eSIM.update.mock.calls[0][0].data.qrCodeUrl).toBeUndefined()
  })

  it('no-op when nothing new', async () => {
    const persisted = await persistInstallationLookup('esim-1', { qrCodeUrl: 'x' }, {})
    expect(persisted).toEqual({})
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
  })
})
