import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    provider: { findUnique: vi.fn() },
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  },
}))

vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  buildConnectorFromProvider: vi.fn(),
}))

vi.mock('../recurring-jobs', () => ({
  claimEsimForSync: vi.fn().mockResolvedValue(true),
}))

const { prisma } = await import('@/lib/prisma')
const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
const { executeStatusSynchronization } = await import('./esim-sync-batch')

const mockPrisma = vi.mocked(prisma)
const mockBuildConnector = vi.mocked(buildConnectorFromProvider)

function mockEsim(overrides: any = {}) {
  return {
    id: 'esim-1',
    iccid: '89012345678901234567',
    imsi: '310410123456789',
    imsiVersion: null,
    status: 'ACTIVE',
    providerStatus: 'ACTIVE',
    statusSyncRetryCount: 0,
    statusNextSyncAt: null,
    lastStatusSyncAt: null,
    providerSubscriptionId: null,
    providerActivationId: null,
    purchase: { package: { providerId: 'p-1' } },
    ...overrides,
  }
}

const provider = { id: 'p-1', code: 'CHOICE', type: 'CHOICE', adapterStrategy: 'CHOICE', status: 'ACTIVE', enabledCapabilities: [] }

function choiceConnector(overrides: any = {}) {
  return {
    capabilities: { statusLookup: true, usageLookup: true },
    resolveStatusLookup: vi.fn((esim: any) => ({
      ...(esim.iccid ? { iccid: esim.iccid } : {}),
      ...(esim.imsi ? { imsi: esim.imsi } : {}),
      ...(esim.status ? { currentStatus: esim.status } : {}),
    })),
    getStatus: vi.fn(),
    getUsage: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.eSIM.update.mockResolvedValue({})
  mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
  mockPrisma.provider.findUnique.mockResolvedValue(provider as any)
  mockBuildConnector.mockResolvedValue(choiceConnector() as any)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('executeStatusSynchronization — provider-neutral identifier', () => {
  it('passes a STRUCTURED object (iccid/imsi/currentStatus) to getStatus for a structured-lookup connector (Choice)', async () => {
    const connector = choiceConnector({
      getStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', providerStatus: 'active' } }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    await executeStatusSynchronization(10)

    expect(connector.getStatus).toHaveBeenCalledTimes(1)
    const arg = connector.getStatus.mock.calls[0][0]
    expect(typeof arg).toBe('object')
    expect(arg.iccid).toBe('89012345678901234567')
    expect(arg.imsi).toBe('310410123456789')
    expect(arg.currentStatus).toBe('ACTIVE')
    expect(arg).not.toHaveProperty('id')
    expect(arg).not.toContain('esim-1')
  })

  it('never sends a local OneSIM id — skips when no safe identifier exists', async () => {
    // No resolveStatusLookup + no iccid + no provider ref → identifier missing.
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ iccid: null, imsi: null, providerSubscriptionId: null, providerActivationId: null })])
    const connector = { getStatus: vi.fn() } // no resolveStatusLookup
    mockBuildConnector.mockResolvedValue(connector as any)

    const result = await executeStatusSynchronization(10)

    expect(connector.getStatus).not.toHaveBeenCalled()
    expect(result.skipped).toBe(1)
  })

  it('ACTIVE success keeps ACTIVE, updates providerStatus, sets lastStatusSyncAt, resets retry, schedules +6h', async () => {
    const connector = choiceConnector({
      getStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', providerStatus: 'active' } }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    await executeStatusSynchronization(10)

    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.status).toBe('ACTIVE')
    expect(updateCall.data.providerStatus).toBe('active')
    expect(updateCall.data.lastStatusSyncAt).toBeInstanceOf(Date)
    expect(updateCall.data.statusSyncRetryCount).toBe(0)
    const sixHours = 6 * 3600 * 1000
    expect(updateCall.data.statusNextSyncAt.getTime() - Date.now()).toBeGreaterThanOrEqual(sixHours - 5000)
    expect(updateCall.data.statusNextSyncAt.getTime() - Date.now()).toBeLessThan(sixHours + 5000)
  })

  it('ACTIVE regression guard: provider PENDING does NOT downgrade status (canonical monotonic)', async () => {
    const connector = choiceConnector({
      getStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PENDING' } }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    await executeStatusSynchronization(10)

    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    // Canonical deriveEsimLifecycleStatus preserves ACTIVE (never regress to PENDING).
    expect(updateCall.data.status).toBe('ACTIVE')
    expect(updateCall.data.statusNextSyncAt.getTime() - Date.now()).toBeGreaterThanOrEqual(6 * 3600 * 1000 - 5000)
  })

  it('skips a connector that does not declare status lookup (US-Matrix pattern)', async () => {
    mockBuildConnector.mockResolvedValue({ capabilities: { statusLookup: false }, getStatus: vi.fn() } as any)
    const result = await executeStatusSynchronization(10)
    expect(result.skipped).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'esim-1' },
      data: expect.objectContaining({ statusNextSyncAt: null }),
    }))
  })

  it('failure schedules +5m backoff (not the +6h success cadence) and increments retry', async () => {
    const connector = choiceConnector({
      getStatus: vi.fn().mockResolvedValue({ success: false, error: { code: 'PROVIDER_REJECTED', message: 'rejected' } }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    await executeStatusSynchronization(10)

    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.statusSyncRetryCount).toEqual({ increment: 1 })
    const fiveMin = 5 * 60 * 1000
    expect(updateCall.data.statusNextSyncAt.getTime() - Date.now()).toBeGreaterThanOrEqual(fiveMin - 5000)
    expect(updateCall.data.statusNextSyncAt.getTime() - Date.now()).toBeLessThan(fiveMin + 5000)
  })

  it('logs a safe failure diagnostic (masked ICCID, no payload)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const connector = choiceConnector({
      getStatus: vi.fn().mockResolvedValue({ success: false, error: { code: 'HTTP_500', message: 'boom' } }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    await executeStatusSynchronization(10)

    const message = logSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('[ESIM_STATUS_SYNC_FAILURE]'))
    expect(message).toBeTruthy()
    expect(message).toContain('providerId=p-1')
    expect(message).toContain('errorCode=HTTP_500')
    expect(message).toContain('retryCount=1')
    expect(message).toContain('iccid=8901••••4567')
    expect(message).not.toContain('boom') // no raw provider message/payload
    expect(message).not.toContain('test-token')
  })
})

describe('executeUsageSynchronization — capability gate + isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.eSIM.update.mockResolvedValue({})
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(provider as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('skips a connector that does not declare usage lookup (US-Matrix pattern)', async () => {
    const { executeUsageSynchronization } = await import('./esim-sync-batch')
    mockBuildConnector.mockResolvedValue({ capabilities: { usageLookup: false }, getUsage: vi.fn() } as any)

    const result = await executeUsageSynchronization(10)
    expect(result.skipped).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'esim-1' },
      data: expect.objectContaining({ usageNextSyncAt: null }),
    }))
  })

  it('syncs usage for a connector that declares usage lookup', async () => {
    const { executeUsageSynchronization } = await import('./esim-sync-batch')
    mockBuildConnector.mockResolvedValue({
      capabilities: { usageLookup: true, statusLookup: true },
      getUsage: vi.fn().mockResolvedValue({ success: true, data: { iccid: '89012345678901234567', dataUsedMB: 500, dataTotalMB: 1024, dataRemainingMB: 524 } }),
    } as any)

    const result = await executeUsageSynchronization(10)
    expect(result.updated).toBe(1)
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.dataUsedMB).toBe(500)
    expect(updateCall.data.dataTotalMB).toBe(1024)
    expect(updateCall.data.dataRemainingMB).toBe(524)
  })
})
