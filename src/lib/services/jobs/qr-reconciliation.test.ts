import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { findMany: vi.fn(), update: vi.fn() },
    provider: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  getAdapterForType: vi.fn(),
}))

const { prisma } = await import('@/lib/prisma')
const { getAdapterForType } = await import('@/lib/providers/adapter-manager')
const { reconcileMissingInstallationDetails } = await import('./qr-reconciliation')

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
    id: 'p-1', code: 'AIRHUB', type: 'AIRHUB', supportsQRCode: false,
    apiBaseUrl: '', apiToken: '', environment: 'test', authUrl: '',
    ...overrides,
  }
}

describe('reconcileMissingInstallationDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('extracts lpa/smdp from providerResponse into columns and marks READY', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ providerResponse: { lpa: 'LPA:1$smdp.example.com$mid', smdp: 'smdp.example.com' } })])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.updated).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        activationCode: 'LPA:1$smdp.example.com$mid',
        smdpAddress: 'smdp.example.com',
        installationStatus: 'READY',
      }),
    }))
  })

  it('extracts matchingId+smdpAddress manual-install pair and marks READY', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ providerResponse: { smdpAddress: 'smdp.example.com', matchingId: 'mid-123' } })])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.updated).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        smdpAddress: 'smdp.example.com',
        matchingId: 'mid-123',
        installationStatus: 'READY',
      }),
    }))
  })

  it('persists getQRCode result and marks READY for QR-capable providers', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider({ supportsQRCode: true }))
    mockGetAdapter.mockResolvedValue({
      getQRCode: vi.fn().mockResolvedValue({ success: true, data: { qrCodeUrl: 'https://qr.example/q.png', activationCode: 'LPA:1$smdp.example.com$mid' } }),
    } as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.updated).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        qrCodeUrl: 'https://qr.example/q.png',
        activationCode: 'LPA:1$smdp.example.com$mid',
        installationStatus: 'READY',
      }),
    }))
  })

  it('does not call the provider when install data already exists (marks READY only)', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ qrCodeUrl: 'https://qr.example/keep.png' })])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.updated).toBe(1)
    expect(mockGetAdapter).not.toHaveBeenCalled()
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ installationStatus: 'READY' }),
    }))
  })

  it('marks NOT_SUPPORTED when no install data and provider lacks QR support', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider({ supportsQRCode: false }))

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.notSupported).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ installationStatus: 'NOT_SUPPORTED' }),
    }))
  })

  it('increments retry count when QR fetch fails', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim()])
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider({ supportsQRCode: true }))
    mockGetAdapter.mockResolvedValue({
      getQRCode: vi.fn().mockResolvedValue({ success: false, error: { code: 'NO_QR_CODE', message: 'none' } }),
    } as any)

    const result = await reconcileMissingInstallationDetails(10)

    expect(result.failed).toBe(1)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ installationRetryCount: { increment: 1 } }),
    }))
  })
})
