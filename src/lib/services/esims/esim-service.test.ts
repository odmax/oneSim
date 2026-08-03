import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { findUnique: vi.fn(), update: vi.fn() },
    provider: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  getAdapterForProvider: vi.fn(),
}))

vi.mock('@/lib/services/orders/order-state-machine', () => ({
  createTimelineEvent: vi.fn(),
}))

vi.mock('@/lib/services/orders/wallet-actions', () => ({
  reserveWalletFunds: vi.fn(),
  releaseReservedFunds: vi.fn(),
  captureReservedFunds: vi.fn(),
}))

const { prisma } = await import('@/lib/prisma')
const { getAdapterForProvider } = await import('@/lib/providers/adapter-manager')
const { createTimelineEvent } = await import('@/lib/services/orders/order-state-machine')
const { refreshEsimStatus, buildChoiceStatusLookup } = await import('./esim-service')

const mockPrisma = vi.mocked(prisma)
const mockGetAdapter = vi.mocked(getAdapterForProvider)
const mockCreateTimeline = vi.mocked(createTimelineEvent)

const CHOICE_ICCID = '89012345678901234567'

function makeEsim(overrides: any = {}) {
  return {
    id: 'esim-1',
    iccid: CHOICE_ICCID,
    imsi: null,
    status: 'PENDING_ACTIVATION',
    providerActivationId: '',
    providerResponse: null,
    expiresAt: new Date('2026-01-01'),
    purchase: { id: 'order-1', package: { providerId: 'p1' } },
    ...overrides,
  }
}

describe('refreshEsimStatus (Choice)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue({ code: 'CHOICE' })
    mockPrisma.eSIM.update.mockResolvedValue({} as any)
    mockCreateTimeline.mockResolvedValue(undefined as any)
  })

  it('uses the Choice iccid identifier (never a local id) and persists providerStatus + timestamps + sanitized providerResponse', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim())
    const getActivationStatus = vi.fn().mockResolvedValue({
      success: true,
      data: {
        status: 'ACTIVE',
        rawStatus: 'active',
        iccid: CHOICE_ICCID,
        imsiVersion: 70,
        rawMetadata: { success: true, package: { iccid: '[REDACTED]', imsi_version: 70, status: 'active' } },
      },
    })
    mockGetAdapter.mockResolvedValue({ getActivationStatus } as any)

    const result = await refreshEsimStatus('esim-1')

    expect(result.success).toBe(true)
    expect(result.status).toBe('ACTIVE')
    expect(result.providerStatus).toBe('active')

    const lookup = getActivationStatus.mock.calls[0][0]
    expect(lookup).toMatchObject({ iccid: CHOICE_ICCID, currentStatus: 'PENDING_ACTIVATION' })
    expect(lookup).not.toHaveProperty('id')
    expect(lookup).not.toHaveProperty('purchaseId')

    const updateData = mockPrisma.eSIM.update.mock.calls[0][0].data
    expect(updateData).toMatchObject({
      providerStatus: 'active',
      status: 'ACTIVE',
      providerResponse: { success: true, package: { iccid: '[REDACTED]', imsi_version: 70 } },
      activatedAt: expect.any(Date),
      activationDetectedAt: expect.any(Date),
    })
    expect(updateData.lastStatusSyncAt).toBeInstanceOf(Date)
    expect(updateData.lastSyncAt).toBeInstanceOf(Date)
  })

  it('prioritizes ICCID over IMSI', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ imsi: '310410123456789' }))
    const getActivationStatus = vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', rawStatus: 'active' } })
    mockGetAdapter.mockResolvedValue({ getActivationStatus } as any)

    await refreshEsimStatus('esim-1')
    const lookup = getActivationStatus.mock.calls[0][0]
    expect(lookup.iccid).toBe(CHOICE_ICCID)
    expect(lookup.imsi).toBeUndefined()
  })

  it('falls back to the persisted IMSI when no ICCID is available', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ iccid: '', imsi: '310410123456789' }))
    const getActivationStatus = vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', rawStatus: 'active' } })
    mockGetAdapter.mockResolvedValue({ getActivationStatus } as any)

    await refreshEsimStatus('esim-1')
    const lookup = getActivationStatus.mock.calls[0][0]
    expect(lookup.imsi).toBe('310410123456789')
    expect(lookup.iccid).toBeUndefined()
  })

  it('falls back to Choice imsi_version read from providerResponse', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ iccid: '', imsi: null, providerResponse: { package: { imsi_version: 70 } } }))
    const getActivationStatus = vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', rawStatus: 'active' } })
    mockGetAdapter.mockResolvedValue({ getActivationStatus } as any)

    await refreshEsimStatus('esim-1')
    const lookup = getActivationStatus.mock.calls[0][0]
    expect(lookup.imsiVersion).toBe(70)
  })

  it('returns an error without calling the provider when no Choice identifier exists (never sends esim.id)', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ iccid: '', imsi: null, providerResponse: {}, providerActivationId: 'order-1' }))
    const getActivationStatus = vi.fn()
    mockGetAdapter.mockResolvedValue({ getActivationStatus } as any)

    const result = await refreshEsimStatus('esim-1')
    expect(result.success).toBe(false)
    expect(result.error).toBe('No Choice status identifier (ICCID/IMSI/imsi_version) available')
    expect(getActivationStatus).not.toHaveBeenCalled()
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
  })

  it('preserves the existing meaningful status when Choice returns an unknown value and stores the raw provider status', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ status: 'ACTIVE' }))
    const getActivationStatus = vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', rawStatus: 'weird_unknown' } })
    mockGetAdapter.mockResolvedValue({ getActivationStatus } as any)

    await refreshEsimStatus('esim-1')
    const lookup = getActivationStatus.mock.calls[0][0]
    expect(lookup.currentStatus).toBe('ACTIVE')
    const updateData = mockPrisma.eSIM.update.mock.calls[0][0].data
    expect(updateData.status).toBe('ACTIVE')
    expect(updateData.providerStatus).toBe('weird_unknown')
  })

  it('persists ACTIVE when Choice reports status=active with package_status=New', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim())
    const getActivationStatus = vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', rawStatus: 'active' } })
    mockGetAdapter.mockResolvedValue({ getActivationStatus } as any)

    const result = await refreshEsimStatus('esim-1')
    expect(result.status).toBe('ACTIVE')
    expect(result.providerStatus).toBe('active')
    const updateData = mockPrisma.eSIM.update.mock.calls[0][0].data
    expect(updateData.status).toBe('ACTIVE')
    expect(updateData.providerStatus).toBe('active')
  })

  it('does not persist anything on provider failure (preserves current status and prior sync timestamp)', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim())
    const getActivationStatus = vi.fn().mockResolvedValue({ success: false, error: { code: 'CHOICE_STATUS_REJECTED', message: 'Bundle is expired' } })
    mockGetAdapter.mockResolvedValue({ getActivationStatus } as any)

    const result = await refreshEsimStatus('esim-1')
    expect(result.success).toBe(false)
    expect(result.error).toBe('Bundle is expired')
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
  })

  it('keeps legacy identifier behavior for non-Choice providers', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue({ code: 'AIRHUB' })
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ providerActivationId: 'act-1' }))
    const getActivationStatus = vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', rawStatus: 'ACTIVE' } })
    mockGetAdapter.mockResolvedValue({ getActivationStatus } as any)

    await refreshEsimStatus('esim-1')
    expect(getActivationStatus).toHaveBeenCalledWith('act-1')
  })

  it('keeps the esim.id fallback only for non-Choice providers', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue({ code: 'IBASIS' })
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ providerActivationId: null }))
    const getActivationStatus = vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', rawStatus: 'ACTIVE' } })
    mockGetAdapter.mockResolvedValue({ getActivationStatus } as any)

    await refreshEsimStatus('esim-1')
    expect(getActivationStatus).toHaveBeenCalledWith('esim-1')
  })
})

describe('buildChoiceStatusLookup', () => {
  it('uses ICCID when present', () => {
    const lookup = buildChoiceStatusLookup({ iccid: CHOICE_ICCID, imsi: '310410123456789', status: 'ACTIVE' })
    expect(lookup.iccid).toBe(CHOICE_ICCID)
    expect(lookup.imsi).toBeUndefined()
    expect(lookup.currentStatus).toBe('ACTIVE')
  })

  it('uses IMSI when ICCID is absent', () => {
    const lookup = buildChoiceStatusLookup({ iccid: '', imsi: '310410123456789', status: 'PENDING' })
    expect(lookup.imsi).toBe('310410123456789')
    expect(lookup.iccid).toBeUndefined()
  })

  it('uses imsi_version when neither ICCID nor IMSI is present', () => {
    const lookup = buildChoiceStatusLookup({ iccid: '', imsi: null, providerResponse: { imsi_version: 70 } })
    expect(lookup.imsiVersion).toBe(70)
  })

  it('never includes a local identifier', () => {
    const lookup = buildChoiceStatusLookup({ iccid: '', imsi: null, providerResponse: {} })
    expect(lookup.iccid).toBeUndefined()
    expect(lookup.imsi).toBeUndefined()
    expect(lookup.imsiVersion).toBeUndefined()
    expect(Object.keys(lookup)).not.toContain('id')
  })
})
