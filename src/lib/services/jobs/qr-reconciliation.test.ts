import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}))

vi.mock('@/lib/providers/installation-lookup', () => ({
  lookupEsimInstallationData: vi.fn(),
  persistInstallationLookup: vi.fn().mockResolvedValue({}),
}))

const { prisma } = await import('@/lib/prisma')
const { lookupEsimInstallationData, persistInstallationLookup } = await import('@/lib/providers/installation-lookup')
const { reconcileMissingInstallationDetails, repairLegacyStaleInstallationRows, MAX_INSTALLATION_RETRIES, getRetryInterval } = await import('./qr-reconciliation')

const mockPrisma = vi.mocked(prisma)
const mockLookup = vi.mocked(lookupEsimInstallationData)
const mockPersist = vi.mocked(persistInstallationLookup)

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

const readyLookup = (data: any = { qrCodeUrl: 'https://qr.example/q.png', activationCode: 'LPA:1$smdp.example$mid' }) => ({
  esimId: 'esim-1', success: true, state: 'READY', data,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.eSIM.findMany.mockReset()
  mockPrisma.eSIM.update.mockReset()
  mockPrisma.eSIM.updateMany.mockReset()
  mockLookup.mockReset()
  mockPersist.mockReset()
  mockPersist.mockResolvedValue({})
  mockPrisma.eSIM.update.mockResolvedValue({})
  mockPrisma.eSIM.updateMany.mockResolvedValue({ count: 0 })
})

describe('repairLegacyStaleInstallationRows', () => {
  it('requeues an incorrectly-stale legacy signature (STALE, retry=0, never checked, no data)', async () => {
    mockPrisma.eSIM.updateMany.mockResolvedValue({ count: 1 })
    const count = await repairLegacyStaleInstallationRows()
    expect(count).toBe(1)
    expect(mockPrisma.eSIM.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ installationStatus: 'STALE', installationRetryCount: 0, installationLastCheckedAt: null, installationLastError: null }),
      data: { installationStatus: 'PENDING' },
    }))
  })

  it('never requeues a genuinely exhausted STALE row (retry > 0)', async () => {
    await repairLegacyStaleInstallationRows()
    expect(mockPrisma.eSIM.updateMany.mock.calls[0][0].where.installationRetryCount).toBe(0)
  })

  it('does not touch terminal NOT_SUPPORTED rows', async () => {
    await repairLegacyStaleInstallationRows()
    expect(mockPrisma.eSIM.updateMany.mock.calls[0][0].where.installationStatus).toBe('STALE')
  })
})

describe('STALE semantics — legacy eSIM age must not pre-empt an attempt', () => {
  it('an eSIM older than 24h with retry=0 and never checked gets a lookup via the canonical service, not STALE', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ createdAt: new Date(Date.now() - 30 * 86400000) })])
    mockLookup.mockResolvedValue(readyLookup() as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.stale).toBe(0)
    expect(result.updated).toBe(1)
    expect(mockLookup).toHaveBeenCalledTimes(1)
    expect(mockLookup).toHaveBeenCalledWith('esim-1')
  })

  it('retry limit makes a PENDING row STALE before any lookup', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ installationRetryCount: MAX_INSTALLATION_RETRIES })])
    const result = await reconcileMissingInstallationDetails(10)
    expect(result.stale).toBe(1)
    expect(mockLookup).not.toHaveBeenCalled()
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ installationStatus: 'STALE' }) }))
  })

  it('a row checked 25h ago with few retries is NOT stale and is still looked up', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ installationRetryCount: 3, installationLastCheckedAt: new Date(Date.now() - 25 * 3600000) })])
    mockLookup.mockResolvedValue(readyLookup() as any)
    const result = await reconcileMissingInstallationDetails(10)
    expect(result.stale).toBe(0)
    expect(mockLookup).toHaveBeenCalledTimes(1)
  })

  it('READY never regresses even when retries are exhausted', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ qrCodeUrl: 'https://qr.example/keep.png', installationRetryCount: MAX_INSTALLATION_RETRIES })])
    const result = await reconcileMissingInstallationDetails(10)
    expect(result.stale).toBe(0)
    expect(result.updated).toBe(1)
    expect(mockLookup).not.toHaveBeenCalled()
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ installationStatus: 'READY' }) }))
  })
})

describe('canonical lookup state handling', () => {
  it('READY → persists data, marks READY, clears lastError, resets retry', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockLookup.mockResolvedValue(readyLookup() as any)
    mockPersist.mockResolvedValue({ qrCodeUrl: 'https://qr.example/q.png' })

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.updated).toBe(1)
    expect(mockPersist).toHaveBeenCalledWith('esim-1', expect.anything(), expect.objectContaining({ qrCodeUrl: 'https://qr.example/q.png' }))
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ installationStatus: 'READY', installationLastError: null, installationRetryCount: 0 }),
    }))
  })

  it('NOT_AVAILABLE_YET → retry increment + checked timestamp + meaningful lastError (never terminal)', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockLookup.mockResolvedValue({ esimId: 'esim-1', success: false, state: 'NOT_AVAILABLE_YET', errorCode: 'NO_INSTALL_DATA', diagnostics: { note: 'package_detail is status-only; NOT proof QR is unavailable' } } as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.failed).toBe(1)
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.installationRetryCount).toEqual({ increment: 1 })
    expect(updateCall.data.installationLastCheckedAt).toBeInstanceOf(Date)
    expect(updateCall.data.installationLastError).toBe('NO_INSTALL_DATA')
    expect(updateCall.data.installationStatus).toBeUndefined() // stays PENDING, not NOT_SUPPORTED/FAILED
  })

  it('NOT_SUPPORTED is terminal', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockLookup.mockResolvedValue({ esimId: 'esim-1', success: false, state: 'NOT_SUPPORTED', errorCode: 'LOOKUP_NOT_SUPPORTED' } as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.notSupported).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ installationStatus: 'NOT_SUPPORTED' }) }))
  })

  it('PERMANENT_FAILURE marks FAILED', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockLookup.mockResolvedValue({ esimId: 'esim-1', success: false, state: 'PERMANENT_FAILURE', errorCode: 'PROVIDER_AUTH_FAILED' } as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.failed).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ installationStatus: 'FAILED' }) }))
  })

  it('is provider-neutral — never calls a provider mutation itself', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockLookup.mockResolvedValue(readyLookup() as any)
    await reconcileMissingInstallationDetails(10)
    expect(mockLookup).toHaveBeenCalledTimes(1)
    // The reconciliation delegates everything to the canonical read-only service.
    expect(mockPersist).toHaveBeenCalledTimes(1)
  })
})

describe('retry/backoff policy', () => {
  it('matches the documented 1/5/30-minute window schedule exactly', () => {
    for (const rc of [0, 1, 5, 9]) expect(getRetryInterval(rc)).toBe(1)
    for (const rc of [10, 11, 15, 21]) expect(getRetryInterval(rc)).toBe(5)
    for (const rc of [22, 23, 40, 69]) expect(getRetryInterval(rc)).toBe(30)
  })

  it('retry budget spans the full 24h schedule (10×1m + 12×5m + 48×30m = 70)', () => {
    expect(MAX_INSTALLATION_RETRIES).toBe(10 + 12 + 48)
  })

  it('after reaching the budget, the row becomes STALE', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ installationRetryCount: MAX_INSTALLATION_RETRIES })])
    const result = await reconcileMissingInstallationDetails(10)
    expect(result.stale).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ installationStatus: 'STALE' }) }))
  })
})
