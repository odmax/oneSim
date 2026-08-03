import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { findUnique: vi.fn(), update: vi.fn() },
    provider: { findUnique: vi.fn() },
    usageRecord: { create: vi.fn() },
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
const { refreshEsimStatus, refreshEsimUsage, buildChoiceStatusLookup, suspendEsim, resumeEsim } = await import('./esim-service')

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

describe('refreshEsimUsage (Choice)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue({ code: 'CHOICE' })
    mockPrisma.eSIM.update.mockResolvedValue({} as any)
    mockPrisma.usageRecord.create.mockResolvedValue({} as any)
    mockCreateTimeline.mockResolvedValue(undefined as any)
  })

  it('uses the Choice iccid identifier (never a local id) and persists usage + expiry + sanitized providerResponse', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim())
    const getUsage = vi.fn().mockResolvedValue({
      success: true,
      data: {
        iccid: CHOICE_ICCID,
        dataUsedMB: 512,
        dataTotalMB: 1024,
        dataRemainingMB: 512,
        percentageUsed: 50,
        expiresAt: '2026-08-31T00:00:00.000Z',
        status: 'ACTIVE',
        rawMetadata: { success: true, package: { iccid: '[REDACTED]', imsi_version: 70, status: 'active' } },
      },
    })
    mockGetAdapter.mockResolvedValue({ getUsage } as any)

    const result = await refreshEsimUsage('esim-1')
    expect(result.success).toBe(true)
    expect(result.data?.dataUsedMB).toBe(512)
    expect(result.data?.dataTotalMB).toBe(1024)
    expect(result.data?.expiresAt?.toISOString()).toBe('2026-08-31T00:00:00.000Z')

    const lookup = getUsage.mock.calls[0][0]
    expect(lookup).toMatchObject({ iccid: CHOICE_ICCID, currentStatus: 'PENDING_ACTIVATION' })
    expect(lookup).not.toHaveProperty('id')
    expect(lookup).not.toHaveProperty('purchaseId')

    const createData = mockPrisma.usageRecord.create.mock.calls[0][0].data
    expect(createData).toMatchObject({ esimId: 'esim-1', dataUsedMB: 512, dataTotalMB: 1024, dataRemainingMB: 512 })
    expect(createData.rawData).toEqual({ success: true, package: { iccid: '[REDACTED]', imsi_version: 70, status: 'active' } })

    const updateData = mockPrisma.eSIM.update.mock.calls[0][0].data
    expect(updateData).toMatchObject({
      dataUsedMB: 512,
      dataTotalMB: 1024,
      dataRemainingMB: 512,
      providerResponse: { success: true, package: { iccid: '[REDACTED]', imsi_version: 70, status: 'active' } },
    })
    expect(updateData.expiresAt).toBeInstanceOf(Date)
    expect(updateData.lastUsageSyncAt).toBeInstanceOf(Date)
    expect(updateData.lastSyncAt).toBeInstanceOf(Date)
  })

  it('returns normalized fractional MB but rounds only for Int DB persistence', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim())
    const getUsage = vi.fn().mockResolvedValue({
      success: true,
      data: { iccid: CHOICE_ICCID, dataUsedMB: 512.5, dataTotalMB: 1024.25, dataRemainingMB: 511.75 },
    })
    mockGetAdapter.mockResolvedValue({ getUsage } as any)

    const result = await refreshEsimUsage('esim-1')
    expect(result.data?.dataUsedMB).toBe(512.5)
    expect(result.data?.dataTotalMB).toBe(1024.25)
    expect(result.data?.dataRemainingMB).toBe(511.75)

    expect(mockPrisma.eSIM.update.mock.calls[0][0].data.dataUsedMB).toBe(513)
    expect(mockPrisma.eSIM.update.mock.calls[0][0].data.dataTotalMB).toBe(1024)
    expect(mockPrisma.eSIM.update.mock.calls[0][0].data.dataRemainingMB).toBe(512)
  })

  it('falls back to the persisted IMSI when no ICCID is available', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ iccid: '', imsi: '310410123456789' }))
    const getUsage = vi.fn().mockResolvedValue({ success: true, data: { iccid: '', dataUsedMB: 0, dataTotalMB: 1024 } })
    mockGetAdapter.mockResolvedValue({ getUsage } as any)

    await refreshEsimUsage('esim-1')
    const lookup = getUsage.mock.calls[0][0]
    expect(lookup.imsi).toBe('310410123456789')
    expect(lookup.iccid).toBeUndefined()
  })

  it('falls back to Choice imsi_version read from providerResponse', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ iccid: '', imsi: null, providerResponse: { package: { imsi_version: 70 } } }))
    const getUsage = vi.fn().mockResolvedValue({ success: true, data: { iccid: '', dataUsedMB: 0, dataTotalMB: 1024 } })
    mockGetAdapter.mockResolvedValue({ getUsage } as any)

    await refreshEsimUsage('esim-1')
    const lookup = getUsage.mock.calls[0][0]
    expect(lookup.imsiVersion).toBe(70)
  })

  it('returns an error without calling the provider when no Choice identifier exists (never sends esim.id)', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ iccid: '', imsi: null, providerResponse: {}, providerActivationId: 'order-1' }))
    const getUsage = vi.fn()
    mockGetAdapter.mockResolvedValue({ getUsage } as any)

    const result = await refreshEsimUsage('esim-1')
    expect(result.success).toBe(false)
    expect(result.error).toBe('No Choice usage identifier (ICCID/IMSI/imsi_version) available')
    expect(getUsage).not.toHaveBeenCalled()
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
    expect(mockPrisma.usageRecord.create).not.toHaveBeenCalled()
  })

  it('preserves the last valid usage snapshot and status on provider failure', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ status: 'ACTIVE' }))
    const getUsage = vi.fn().mockResolvedValue({ success: false, error: { code: 'CHOICE_USAGE_REJECTED', message: 'Bundle is expired' } })
    mockGetAdapter.mockResolvedValue({ getUsage } as any)

    const result = await refreshEsimUsage('esim-1')
    expect(result.success).toBe(false)
    expect(result.error).toBe('Bundle is expired')
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
    expect(mockPrisma.usageRecord.create).not.toHaveBeenCalled()
  })

  it('never overwrites the stored status from supplemental usage data', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ status: 'ACTIVE' }))
    const getUsage = vi.fn().mockResolvedValue({
      success: true,
      data: { iccid: CHOICE_ICCID, dataUsedMB: 0, dataTotalMB: 1024, status: 'EXPIRED' },
    })
    mockGetAdapter.mockResolvedValue({ getUsage } as any)

    const result = await refreshEsimUsage('esim-1')
    expect(result.data?.status).toBe('ACTIVE')
    const updateData = mockPrisma.eSIM.update.mock.calls[0][0].data
    expect(updateData).not.toHaveProperty('status')
    expect(updateData).not.toHaveProperty('providerStatus')
  })

  it('keeps legacy identifier behavior for non-Choice providers', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue({ code: 'AIRHUB' })
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ iccid: CHOICE_ICCID }))
    const getUsage = vi.fn().mockResolvedValue({ success: true, data: { iccid: CHOICE_ICCID, dataUsedMB: 10 } })
    mockGetAdapter.mockResolvedValue({ getUsage } as any)

    await refreshEsimUsage('esim-1')
    expect(getUsage).toHaveBeenCalledWith(CHOICE_ICCID)
  })

  it('returns an error when a non-Choice eSIM has no ICCID', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue({ code: 'AIRHUB' })
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ iccid: '' }))
    const getUsage = vi.fn()
    mockGetAdapter.mockResolvedValue({ getUsage } as any)

    const result = await refreshEsimUsage('esim-1')
    expect(result.success).toBe(false)
    expect(result.error).toBe('eSIM has no ICCID')
    expect(getUsage).not.toHaveBeenCalled()
  })
})

describe('suspendEsim / resumeEsim (Choice lifecycle)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue({ code: 'CHOICE' })
    mockPrisma.eSIM.update.mockResolvedValue({} as any)
    mockCreateTimeline.mockResolvedValue(undefined as any)
  })

  it('suspends a Choice eSIM using the iccid identifier (never a local id) and persists SUSPENDED + provider status', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ purchaseId: 'order-1' }))
    const suspendESIM = vi.fn().mockResolvedValue({
      success: true,
      data: { status: 'SUSPENDED', providerStatus: 'suspended', message: 'IMSI: 310410123456789 suspended', rawMetadata: { success: true, package: { iccid: '[REDACTED]' } } },
    })
    mockGetAdapter.mockResolvedValue({ suspendESIM } as any)

    const result = await suspendEsim('esim-1')

    expect(result.success).toBe(true)
    expect(result.status).toBe('SUSPENDED')
    expect(result.providerStatus).toBe('suspended')

    const lookup = suspendESIM.mock.calls[0][0]
    expect(lookup).toMatchObject({ iccid: CHOICE_ICCID })
    expect(lookup).not.toHaveProperty('id')
    expect(lookup).not.toHaveProperty('purchaseId')

    const updateData = mockPrisma.eSIM.update.mock.calls[0][0].data
    expect(updateData).toMatchObject({
      status: 'SUSPENDED',
      providerStatus: 'suspended',
      providerResponse: { success: true, package: { iccid: '[REDACTED]' } },
    })
    expect(updateData.lastStatusSyncAt).toBeInstanceOf(Date)
    expect(updateData.lastSyncAt).toBeInstanceOf(Date)

    expect(mockCreateTimeline).toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'ESIM_SUSPENDED' }))
  })

  it('resumes a Choice eSIM and persists ACTIVE + provider status', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ purchaseId: 'order-1' }))
    const resumeESIM = vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', providerStatus: 'active' } })
    mockGetAdapter.mockResolvedValue({ resumeESIM } as any)

    const result = await resumeEsim('esim-1')

    expect(result.success).toBe(true)
    expect(result.status).toBe('ACTIVE')
    expect(result.providerStatus).toBe('active')

    const updateData = mockPrisma.eSIM.update.mock.calls[0][0].data
    expect(updateData).toMatchObject({ status: 'ACTIVE', providerStatus: 'active' })
    expect(updateData).not.toHaveProperty('providerResponse')

    expect(mockCreateTimeline).toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'ESIM_RESUMED' }))
  })

  it('does not persist anything when the provider rejects a suspend (preserves current status)', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ status: 'ACTIVE', purchaseId: 'order-1' }))
    const suspendESIM = vi.fn().mockResolvedValue({ success: false, error: { code: 'CHOICE_SUSPEND_REJECTED', message: 'SIM already suspended' } })
    mockGetAdapter.mockResolvedValue({ suspendESIM } as any)

    const result = await suspendEsim('esim-1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('SIM already suspended')
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
    expect(mockCreateTimeline).toHaveBeenCalledWith('order-1', expect.objectContaining({ eventType: 'ESIM_SUSPEND_FAILED' }))
  })

  it('forwards the raw ICCID for non-Choice providers', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue({ code: 'AIRHUB' })
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ status: 'ACTIVE' }))
    const suspendESIM = vi.fn().mockResolvedValue({ success: true, data: { status: 'SUSPENDED', providerStatus: 'suspended' } })
    mockGetAdapter.mockResolvedValue({ suspendESIM } as any)

    const result = await suspendEsim('esim-1')

    expect(result.success).toBe(true)
    expect(suspendESIM).toHaveBeenCalledWith(CHOICE_ICCID)
  })

  it('returns an error when a non-Choice eSIM has no ICCID', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue({ code: 'AIRHUB' })
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ iccid: '' }))
    const suspendESIM = vi.fn()
    mockGetAdapter.mockResolvedValue({ suspendESIM } as any)

    const result = await suspendEsim('esim-1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('eSIM has no ICCID')
    expect(suspendESIM).not.toHaveBeenCalled()
  })

  it('returns an error without calling the provider when no Choice identifier exists (never sends esim.id)', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ iccid: '', imsi: null, providerResponse: {} }))
    const suspendESIM = vi.fn()
    mockGetAdapter.mockResolvedValue({ suspendESIM } as any)

    const result = await suspendEsim('esim-1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('No Choice suspend identifier (ICCID/IMSI/imsi_version) available')
    expect(suspendESIM).not.toHaveBeenCalled()
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
  })

  it('returns an error when the eSIM is not found', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(null)

    const result = await resumeEsim('esim-1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('eSIM not found')
  })

  it('returns an error when no provider adapter is available', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim())
    mockGetAdapter.mockResolvedValue(null)

    const result = await suspendEsim('esim-1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Provider adapter unavailable')
  })

  it('falls back to a persisted IMSI identifier for Choice lifecycle', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue(makeEsim({ iccid: '', imsi: '310410123456789' }))
    const resumeESIM = vi.fn().mockResolvedValue({ success: true, data: { status: 'ACTIVE', providerStatus: 'active' } })
    mockGetAdapter.mockResolvedValue({ resumeESIM } as any)

    await resumeEsim('esim-1')

    const lookup = resumeESIM.mock.calls[0][0]
    expect(lookup.imsi).toBe('310410123456789')
    expect(lookup.iccid).toBeUndefined()
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
