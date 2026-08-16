import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { findUnique: vi.fn(), update: vi.fn() },
  },
}))

vi.mock('@/lib/services/esims/sync-lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/esims/sync-lookup')>()
  return { ...actual, buildProviderConnector: vi.fn() }
})

const { prisma } = await import('@/lib/prisma')
const { buildProviderConnector } = await import('@/lib/services/esims/sync-lookup')
const { syncESIMStatus } = await import('./sync-esim-status')

const mockPrisma = vi.mocked(prisma)
const mockBuildConnector = vi.mocked(buildProviderConnector)

function makeEsim(overrides: any = {}) {
  return {
    id: 'esim-1',
    iccid: '8944501234567890123',
    providerActivationId: 'esim-uuid-1',
    status: 'PENDING_ACTIVATION',
    providerStatus: 'ACTIVE',
    dataUsedMB: 0,
    activatedAt: null,
    activationDetectedAt: null,
    usageNextSyncAt: null,
    providerResponse: null,
    purchase: { package: { providerId: 'p-1' } },
    ...overrides,
  }
}

function statusConnector(overrides: any = {}) {
  return {
    capabilities: { statusLookup: true, usageLookup: true },
    resolveStatusLookup: vi.fn((esim: any) => ({ providerActivationId: esim.providerActivationId, iccid: esim.iccid })),
    getStatus: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim() as any)
  mockPrisma.eSIM.update.mockResolvedValue({} as any)
})

describe('syncESIMStatus — canonical evidence pipeline (root-cause fix)', () => {
  it('ACTIVE + verified network-attach evidence promotes PENDING_ACTIVATION → ACTIVE (root cause)', async () => {
    const connector = statusConnector({
      getStatus: vi.fn().mockResolvedValue({
        success: true,
        data: {
          status: 'ACTIVE',
          rawStatus: 'network_attach',
          evidence: { networkAttached: true, observedAt: '2026-08-16T09:08:42Z', reason: 'diameter-success-attach' },
          rawMetadata: { source: 'esims/location-event-logs', networkAttached: true, servingNetwork: '65501' },
        },
      }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    const result = await syncESIMStatus('esim-1')

    expect(result.success).toBe(true)
    expect(result.status).toBe('ACTIVE')
    expect(result.newStatus).toBe('ACTIVE')
    expect(result.statusChanged).toBe(true)
    expect(result.activated).toBe(true)

    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.status).toBe('ACTIVE')
    // Activation timestamps populated (both null → both set).
    expect(updateCall.data.activatedAt).toBeInstanceOf(Date)
    expect(updateCall.data.activationDetectedAt).toBeInstanceOf(Date)
    // ACTIVE cadence — NOT the pending 1-minute cadence.
    const sixHours = 6 * 3600 * 1000
    expect(updateCall.data.statusNextSyncAt.getTime() - Date.now()).toBeGreaterThanOrEqual(sixHours - 5000)
    expect(updateCall.data.statusNextSyncAt.getTime() - Date.now()).toBeLessThan(sixHours + 5000)
    expect(updateCall.data.statusSyncRetryCount).toBe(0)
    // Sanitized evidence audit trail persisted (no raw /esims/info credentials).
    expect(updateCall.data.providerResponse).toEqual({
      source: 'esims/location-event-logs',
      networkAttached: true,
      servingNetwork: '65501',
      evidence: 'network-attach-evidence',
      evidenceObservedAt: expect.any(String),
    })
  })

  it('seeds usageNextSyncAt when ACTIVE + usageLookup supported + never scheduled', async () => {
    const connector = statusConnector({
      getStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'ACTIVE', evidence: { networkAttached: true }, rawMetadata: { networkAttached: true } },
      }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    const result = await syncESIMStatus('esim-1')
    expect(result.status).toBe('ACTIVE')
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.usageNextSyncAt).toBeInstanceOf(Date)
    const sixHours = 6 * 3600 * 1000
    expect(updateCall.data.usageNextSyncAt.getTime() - Date.now()).toBeGreaterThanOrEqual(sixHours - 5000)
  })

  it('does NOT seed usageNextSyncAt when the connector does not declare usage lookup', async () => {
    const connector = statusConnector({
      capabilities: { statusLookup: true, usageLookup: false },
      getStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'ACTIVE', evidence: { networkAttached: true }, rawMetadata: { networkAttached: true } },
      }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    await syncESIMStatus('esim-1')
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.usageNextSyncAt).toBeUndefined()
  })

  it('device-installed evidence → INSTALLED (PENDING_ACTIVATION → INSTALLED)', async () => {
    const connector = statusConnector({
      getStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'INSTALLED', evidence: { deviceInstalled: true }, rawMetadata: { source: 'esims/info', deviceInstalled: true } },
      }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    const result = await syncESIMStatus('esim-1')
    expect(result.status).toBe('INSTALLED')
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.status).toBe('INSTALLED')
    expect(updateCall.data.activatedAt).toBeInstanceOf(Date)
    expect(updateCall.data.activationDetectedAt).toBeInstanceOf(Date)
  })

  it('weak ACTIVE claim (no evidence) stays PENDING_ACTIVATION at the pending cadence', async () => {
    const connector = statusConnector({
      getStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'ACTIVE', rawStatus: 'active', rawMetadata: { source: 'esims/info' } },
      }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    const result = await syncESIMStatus('esim-1')
    expect(result.status).toBe('PENDING_ACTIVATION')
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.status).toBeUndefined() // unchanged
    const oneMinute = 60 * 1000
    expect(updateCall.data.statusNextSyncAt.getTime() - Date.now()).toBeGreaterThanOrEqual(oneMinute - 5000)
    expect(updateCall.data.statusNextSyncAt.getTime() - Date.now()).toBeLessThan(oneMinute + 5000)
    expect(updateCall.data.activatedAt).toBeUndefined()
    expect(updateCall.data.activationDetectedAt).toBeUndefined()
  })

  it('does not regress existing ACTIVE from a weaker pending report (monotonic)', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ status: 'ACTIVE', activatedAt: new Date('2026-01-01') }) as any)
    const connector = statusConnector({
      getStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'PENDING_ACTIVATION', rawMetadata: { source: 'esims/info' } },
      }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    const result = await syncESIMStatus('esim-1')
    expect(result.status).toBe('ACTIVE')
    expect(result.statusChanged).toBe(false)
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.status).toBeUndefined()
  })

  it('does not overwrite an existing activatedAt when ACTIVE is re-confirmed', async () => {
    const existing = new Date('2026-01-01')
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ status: 'ACTIVE', activatedAt: existing, usageNextSyncAt: null }) as any)
    const connector = statusConnector({
      getStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'ACTIVE', evidence: { networkAttached: true }, rawMetadata: { networkAttached: true } },
      }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    const result = await syncESIMStatus('esim-1')
    expect(result.activated).toBe(false)
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.activatedAt).toBeUndefined()
    expect(updateCall.data.activationDetectedAt).toBeUndefined()
  })

  it('propagates a real provider failure (no status change)', async () => {
    const connector = statusConnector({
      getStatus: vi.fn().mockResolvedValue({ success: false, error: { code: 'HTTP_500', message: 'boom' } }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    const result = await syncESIMStatus('esim-1')
    expect(result.success).toBe(false)
    expect(result.error).toBe('boom')
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
  })

  it('skips cleanly when the connector does not declare status lookup', async () => {
    mockBuildConnector.mockResolvedValue({ capabilities: { statusLookup: false }, getStatus: vi.fn() } as any)
    const result = await syncESIMStatus('esim-1')
    expect(result.success).toBe(true)
    expect(result.skipped).toBe(true)
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
  })

  it('ESIM with ONLY a local OneSIM id → provider getStatus is NEVER called', async () => {
    // No iccid, no provider identifiers — only the local database id exists.
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({
      iccid: null,
      providerActivationId: null,
      providerSubscriptionId: null,
      providerSubscriberId: null,
      providerResponse: null,
    }) as any)
    // US-Matrix-shaped resolver: returns null when no provider eSIM UUID exists.
    const connector = statusConnector({
      resolveStatusLookup: vi.fn((esim: any) => (esim.providerActivationId ? { providerActivationId: esim.providerActivationId, iccid: esim.iccid } : null)),
      getStatus: vi.fn(),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    const result = await syncESIMStatus('esim-1')
    expect(result.success).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('IDENTIFIER_MISSING')
    // No provider call, no DB write — a local id is never forwarded upstream.
    expect(connector.getStatus).not.toHaveBeenCalled()
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
  })
})
