import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    provider: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  getAdapterForType: vi.fn(),
}))

const { prisma } = await import('@/lib/prisma')
const { getAdapterForType } = await import('@/lib/providers/adapter-manager')
const { reconcileMissingInstallationDetails, repairLegacyStaleInstallationRows, MAX_INSTALLATION_RETRIES, getRetryInterval } = await import('./qr-reconciliation')

const mockPrisma = vi.mocked(prisma)
const mockGetAdapter = vi.mocked(getAdapterForType)

function mockEsim(overrides: any = {}) {
  return {
    id: 'esim-1',
    iccid: '89012345678901234567',
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    installationStatus: 'PENDING',
    installationRetryCount: 0,
    installationLastCheckedAt: null,
    installationLastError: null,
    activationCode: null,
    qrCodeUrl: null,
    qrCode: null,
    smdpAddress: null,
    matchingId: null,
    providerResponse: null,
    purchase: { package: { providerId: 'p-1' } },
    ...overrides,
  }
}

function mockProvider(overrides: any = {}) {
  return {
    id: 'p-1', code: 'CHOICE', type: 'CHOICE', supportsQRCode: true,
    apiBaseUrl: '', apiToken: '', environment: 'test', authUrl: '',
    ...overrides,
  }
}

function mockAdapter(overrides: any = {}) {
  return {
    getQRCode: vi.fn().mockResolvedValue({ success: false, error: { code: 'NO_QR_CODE', message: 'none' } }),
    topUpESIM: vi.fn(),
    activateESIM: vi.fn(),
    suspendESIM: vi.fn(),
    ...overrides,
  }
}

const noDataAdapter = () => mockAdapter()
const qrAdapter = () => mockAdapter({ getQRCode: vi.fn().mockResolvedValue({ success: true, data: { qrCodeUrl: 'https://qr.example/q.png', activationCode: 'LPA:1$smdp.example$mid' } }) })
const actCodeAdapter = () => mockAdapter({ getQRCode: vi.fn().mockResolvedValue({ success: true, data: { activationCode: 'LPA:1$smdp.example$mid' } }) })
const manualPairAdapter = () => mockAdapter({ getQRCode: vi.fn().mockResolvedValue({ success: true, data: { smdpAddress: 'smdp.example.com', matchingId: 'mid-123' } }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.eSIM.findMany.mockReset()
  mockPrisma.eSIM.update.mockReset()
  mockPrisma.eSIM.updateMany.mockReset()
  mockPrisma.provider.findUnique.mockReset()
  mockGetAdapter.mockReset()
  mockPrisma.eSIM.update.mockResolvedValue({})
  mockPrisma.eSIM.updateMany.mockResolvedValue({ count: 0 })
})

describe('repairLegacyStaleInstallationRows', () => {
  it('requeues an incorrectly-stale legacy signature (STALE, retry=0, never checked, no data)', async () => {
    mockPrisma.eSIM.updateMany.mockResolvedValue({ count: 1 })
    const count = await repairLegacyStaleInstallationRows()
    expect(count).toBe(1)
    expect(mockPrisma.eSIM.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        installationStatus: 'STALE',
        installationRetryCount: 0,
        installationLastCheckedAt: null,
        installationLastError: null,
      }),
      data: { installationStatus: 'PENDING' },
    }))
  })

  it('never requeues a genuinely exhausted STALE row (retry > 0)', async () => {
    mockPrisma.eSIM.updateMany.mockResolvedValue({ count: 0 })
    const count = await repairLegacyStaleInstallationRows()
    expect(count).toBe(0)
    // The predicate requires retryCount = 0, so a retried row cannot match.
    const where = mockPrisma.eSIM.updateMany.mock.calls[0][0].where
    expect(where.installationRetryCount).toBe(0)
  })

  it('does not touch terminal NOT_SUPPORTED rows (status filter is STALE only)', async () => {
    await repairLegacyStaleInstallationRows()
    const where = mockPrisma.eSIM.updateMany.mock.calls[0][0].where
    expect(where.installationStatus).toBe('STALE')
  })
})

describe('STALE semantics — legacy eSIM age must not pre-empt an attempt', () => {
  it('an eSIM older than 24h with retry=0 and never checked gets a real provider lookup, not STALE', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ createdAt: new Date(Date.now() - 30 * 86400000) })])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    const adapter = qrAdapter()
    mockGetAdapter.mockResolvedValue(adapter as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.stale).toBe(0)
    expect(result.updated).toBe(1)
    expect(adapter.getQRCode).toHaveBeenCalledTimes(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ installationStatus: 'READY' }),
    }))
  })

  it('retry limit makes a PENDING row STALE', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ installationRetryCount: MAX_INSTALLATION_RETRIES })])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.stale).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ installationStatus: 'STALE' }),
    }))
  })

  it('retry budget is the sole STALE boundary — a 25h-old last-check with few retries is NOT stale and gets attempted', async () => {
    // Regression guard for the removed "time since last attempt > 24h" rule:
    // installationLastCheckedAt is rewritten every attempt, so it must never be
    // treated as reconciliation age. A row checked 25h ago with 3 retries is
    // due and must be attempted, never marked STALE.
    const lastChecked = new Date(Date.now() - 25 * 3600000)
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ installationRetryCount: 3, installationLastCheckedAt: lastChecked })])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    const adapter = qrAdapter()
    mockGetAdapter.mockResolvedValue(adapter as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.stale).toBe(0)
    expect(adapter.getQRCode).toHaveBeenCalledTimes(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ installationStatus: 'READY' }),
    }))
  })

  it('READY never regresses even when retries are exhausted', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ qrCodeUrl: 'https://qr.example/keep.png', installationRetryCount: MAX_INSTALLATION_RETRIES })])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.stale).toBe(0)
    expect(result.updated).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ installationStatus: 'READY' }),
    }))
    expect(mockGetAdapter).not.toHaveBeenCalled()
  })
})

describe('provider lookup outcomes', () => {
  it('lookup returns QR + activation code → READY', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    const adapter = qrAdapter()
    mockGetAdapter.mockResolvedValue(adapter as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.updated).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ qrCodeUrl: 'https://qr.example/q.png', installationStatus: 'READY' }),
    }))
  })

  it('lookup returns activation code only → READY', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    mockGetAdapter.mockResolvedValue(actCodeAdapter() as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.updated).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ activationCode: 'LPA:1$smdp.example$mid', installationStatus: 'READY' }),
    }))
  })

  it('lookup returns SM-DP+ and matchingId → READY', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    mockGetAdapter.mockResolvedValue(manualPairAdapter() as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.updated).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ smdpAddress: 'smdp.example.com', matchingId: 'mid-123', installationStatus: 'READY' }),
    }))
  })

  it('no data → retry increment + checked timestamp', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    mockGetAdapter.mockResolvedValue(noDataAdapter() as any)

    const before = Date.now()
    const result = await reconcileMissingInstallationDetails(10)

    expect(result.failed).toBe(1)
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.installationRetryCount).toEqual({ increment: 1 })
    expect(updateCall.data.installationLastCheckedAt).toBeInstanceOf(Date)
    expect(updateCall.data.installationLastCheckedAt.getTime() - before).toBeLessThan(5000)
  })

  it('connector NOT_SUPPORTED is terminal', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    mockGetAdapter.mockResolvedValue(mockAdapter({ getQRCode: vi.fn().mockResolvedValue({ success: false, error: { code: 'NOT_SUPPORTED', message: 'Not supported by connector' } }) }) as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.notSupported).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ installationStatus: 'NOT_SUPPORTED' }),
    }))
  })

  it('never calls a provider mutation/purchase method during reconciliation', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    const adapter = mockAdapter({
      getQRCode: vi.fn().mockResolvedValue({ success: true, data: { qrCodeUrl: 'https://qr.example/x' } }),
    })
    mockGetAdapter.mockResolvedValue(adapter as any)

    await reconcileMissingInstallationDetails(10)

    expect(adapter.getQRCode).toHaveBeenCalledTimes(1)
    expect(adapter.topUpESIM).not.toHaveBeenCalled()
    expect(adapter.activateESIM).not.toHaveBeenCalled()
    expect(adapter.suspendESIM).not.toHaveBeenCalled()
  })

  it('resolves the provider through esim.purchase.package.providerId', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    mockGetAdapter.mockResolvedValue(noDataAdapter() as any)

    await reconcileMissingInstallationDetails(10)

    expect(mockPrisma.provider.findUnique).toHaveBeenCalledWith({ where: { id: 'p-1' } })
  })
})

describe('legacy retry behavior preserved', () => {
  it('extracts lpa/smdp from providerResponse into columns and marks READY', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ providerResponse: { lpa: 'LPA:1$smdp.example.com$mid', smdp: 'smdp.example.com' } })])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.updated).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ activationCode: 'LPA:1$smdp.example.com$mid', smdpAddress: 'smdp.example.com', installationStatus: 'READY' }),
    }))
  })

  it('does not call the provider when install data already exists', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ qrCodeUrl: 'https://qr.example/keep.png' })])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.updated).toBe(1)
    expect(mockGetAdapter).not.toHaveBeenCalled()
  })

  it('marks NOT_SUPPORTED only when no lookup could be made and provider declares no QR support', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider({ supportsQRCode: false }))

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.notSupported).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ installationStatus: 'NOT_SUPPORTED' }),
    }))
  })

  it('increments retry when the lookup fails with a retryable error', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    mockGetAdapter.mockResolvedValue(noDataAdapter() as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.failed).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ installationRetryCount: { increment: 1 } }),
    }))
  })
})

describe('retry/backoff policy', () => {
  it('matches the documented 1/5/30-minute window schedule exactly', () => {
    // 0–10 min: every 1 minute (retryCount 0–9)
    for (const rc of [0, 1, 5, 9]) expect(getRetryInterval(rc)).toBe(1)
    // 10–70 min: every 5 minutes (retryCount 10–21)
    for (const rc of [10, 11, 15, 21]) expect(getRetryInterval(rc)).toBe(5)
    // 70 min – 24h: every 30 minutes (retryCount 22+)
    for (const rc of [22, 23, 40, 69]) expect(getRetryInterval(rc)).toBe(30)
  })

  it('retry budget spans the full 24h schedule (10×1m + 12×5m + 48×30m = 70)', () => {
    expect(MAX_INSTALLATION_RETRIES).toBe(10 + 12 + 48)
  })

  it('a row one retry below the budget is not STALE and is still attempted', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ installationRetryCount: MAX_INSTALLATION_RETRIES - 1 })])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    const adapter = qrAdapter()
    mockGetAdapter.mockResolvedValue(adapter as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.stale).toBe(0)
    expect(adapter.getQRCode).toHaveBeenCalledTimes(1)
  })

  it('after reaching the budget, the row becomes STALE', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ installationRetryCount: MAX_INSTALLATION_RETRIES })])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.stale).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ installationStatus: 'STALE' }),
    }))
  })
})
