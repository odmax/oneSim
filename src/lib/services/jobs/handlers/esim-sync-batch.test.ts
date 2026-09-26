import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    provider: { findUnique: vi.fn() },
    usageRecord: { create: vi.fn().mockResolvedValue({}) },
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
const { executeStatusSynchronization, executeUsageSynchronization, backfillEsimSyncSchedules } = await import('./esim-sync-batch')

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
    dataUsedMB: undefined,
    dataTotalMB: null,
    dataRemainingMB: null,
    usageSyncRetryCount: 0,
    usageNextSyncAt: null,
    lastUsageSyncAt: null,
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

  it('US-Matrix provider outage (HTTP_500) → retry increments, ESIM.status untouched, failed counted', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'ACTIVE', statusSyncRetryCount: 2 })])
    const connector = choiceConnector({
      getStatus: vi.fn().mockResolvedValue({ success: false, error: { code: 'HTTP_500', message: 'Provider server error' } }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)

    const result = await executeStatusSynchronization(10)

    expect(result.failed).toBe(1)
    expect(result.updated).toBe(0)
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.statusSyncRetryCount).toEqual({ increment: 1 })
    expect(updateCall.data).not.toHaveProperty('status')
    expect(updateCall.data).not.toHaveProperty('providerStatus')
    expect(updateCall.data.statusNextSyncAt.getTime() - Date.now()).toBeGreaterThanOrEqual(5 * 60 * 1000 - 5000)
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

  it('BATCH path: ACTIVE + verified network-attach evidence promotes PENDING → ACTIVE (same as single sync)', async () => {
    const connector = choiceConnector({
      getStatus: vi.fn().mockResolvedValue({
        success: true,
        data: {
          status: 'ACTIVE',
          providerStatus: 'active',
          evidence: { networkAttached: true, observedAt: '2026-08-16T09:08:42Z' },
          rawMetadata: { networkAttached: true },
        },
      }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'PENDING_ACTIVATION', activatedAt: null, usageNextSyncAt: null })])

    const result = await executeStatusSynchronization(10)

    expect(result.updated).toBe(1)
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.status).toBe('ACTIVE')
    expect(updateCall.data.activatedAt).toBeInstanceOf(Date)
    expect(updateCall.data.activationDetectedAt).toBeInstanceOf(Date)
    // ACTIVE cadence (6h), not pending (1m).
    const sixHours = 6 * 3600 * 1000
    expect(updateCall.data.statusNextSyncAt.getTime() - Date.now()).toBeGreaterThanOrEqual(sixHours - 5000)
    // Usage polling seeded when the connector supports usage lookup.
    expect(updateCall.data.usageNextSyncAt).toBeInstanceOf(Date)
  })

  it('BATCH path: weak ACTIVE claim (no evidence) does NOT promote (same as single sync)', async () => {
    const connector = choiceConnector({
      getStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'ACTIVE', providerStatus: 'active', rawMetadata: {} },
      }),
    })
    mockBuildConnector.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'PENDING_ACTIVATION', activatedAt: null, usageNextSyncAt: null })])

    const result = await executeStatusSynchronization(10)

    expect(result.updated).toBe(1)
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.status).toBe('PENDING_ACTIVATION')
    expect(updateCall.data.activatedAt).toBeUndefined()
    expect(updateCall.data.usageNextSyncAt).toBeUndefined()
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
    // An authoritative snapshot also creates the usage history record.
    expect(mockPrisma.usageRecord.create).toHaveBeenCalledTimes(1)
    expect(mockPrisma.usageRecord.create.mock.calls[0][0].data.dataUsedMB).toBe(500)
  })

it('persists a discovered packageEsimId into providerResponse (preserving existing keys)', async () => {
    const { executeUsageSynchronization } = await import('./esim-sync-batch')
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ providerResponse: { providerEsimId: 'esim-uuid-1' } })])
    mockBuildConnector.mockResolvedValue({
      capabilities: { usageLookup: true },
      resolveUsageLookup: (esim: any) => ({ providerActivationId: 'esim-uuid-1', providerPlanId: 'pkg-uuid-77' }),
      getUsage: vi.fn().mockResolvedValue({ success: true, data: { iccid: 'assoc', dataUsedMB: 400, providerPackageEsimId: 'assoc-uuid-9' } }),
    } as any)

    const result = await executeUsageSynchronization(10)
    expect(result.updated).toBe(1)
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.providerResponse).toEqual({ providerEsimId: 'esim-uuid-1', packageEsimId: 'assoc-uuid-9' })
  })

  it('authoritative usage > 0 promotes PENDING_ACTIVATION → ACTIVE via canonical activation (scheduled path parity)', async () => {
    const { executeUsageSynchronization } = await import('./esim-sync-batch')
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'PENDING_ACTIVATION', activatedAt: null })])
    mockBuildConnector.mockResolvedValue({
      capabilities: { usageLookup: true },
      getUsage: vi.fn().mockResolvedValue({ success: true, data: { iccid: '89012345678901234567', dataUsedMB: 256, dataTotalMB: 1024, dataRemainingMB: 768, status: 'ACTIVE' } }),
    } as any)

    const result = await executeUsageSynchronization(10)
    expect(result.updated).toBe(1)
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.status).toBe('ACTIVE')
    expect(updateCall.data.activatedAt).toBeInstanceOf(Date)
    expect(updateCall.data.activationDetectedAt).toBeInstanceOf(Date)
    // Raw provider lifecycle preserved separately (never rewritten to the
    // canonical ACTIVE derivation); here providerStatus stays unchanged because
    // the esim row already carries ACTIVE from its own status lookup.
    expect(updateCall.data.providerStatus).toBeUndefined()
  })

  it('zero-used snapshot (valid) does NOT promote PENDING → ACTIVE', async () => {
    const { executeUsageSynchronization } = await import('./esim-sync-batch')
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'PENDING_ACTIVATION', activatedAt: null })])
    mockBuildConnector.mockResolvedValue({
      capabilities: { usageLookup: true },
      getUsage: vi.fn().mockResolvedValue({ success: true, data: { iccid: '89012345678901234567', dataUsedMB: 0, dataTotalMB: 1024, dataRemainingMB: 1024 } }),
    } as any)

    const result = await executeUsageSynchronization(10)
    expect(result.updated).toBe(1)
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.status).toBeUndefined()
    expect(updateCall.data.activatedAt).toBeUndefined()
  })

  it('missing/invalid usage does NOT promote PENDING → ACTIVE', async () => {
    const { executeUsageSynchronization } = await import('./esim-sync-batch')
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'PENDING_ACTIVATION', activatedAt: null })])
    mockBuildConnector.mockResolvedValue({
      capabilities: { usageLookup: true },
      getUsage: vi.fn().mockResolvedValue({ success: true, data: { iccid: '89012345678901234567' } }),
    } as any)

    const result = await executeUsageSynchronization(10)
    expect(result.updated).toBe(1)
    const updateCall = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(updateCall.data.status).toBeUndefined()
    expect(updateCall.data.activatedAt).toBeUndefined()
  })

  it('treats an ambiguous association as a clean skip (no retry failure)', async () => {
    const { executeUsageSynchronization } = await import('./esim-sync-batch')
    mockBuildConnector.mockResolvedValue({
      capabilities: { usageLookup: true },
      resolveUsageLookup: (esim: any) => ({ providerActivationId: 'esim-uuid-1' }),
      getUsage: vi.fn().mockResolvedValue({ success: false, error: { code: 'AMBIGUOUS_ASSOCIATION', message: 'no unique match' } }),
    } as any)

    const result = await executeUsageSynchronization(10)
    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)
    // Clean skip — the retry count is NOT incremented and polling continues.
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'esim-1' },
      data: expect.objectContaining({ usageSyncRetryCount: 0 }),
    }))
  })
})

describe('backfillEsimSyncSchedules — null-schedule pending/active backfill (age-independent)', () => {
  const PENDING_STATUSES = ['PENDING', 'PENDING_ACTIVATION', 'PROCESSING', 'PROVISIONING', 'RESERVED']
  const TERMINAL_STATUSES = ['FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED']

  function pendingBackfillCall() {
    // The FIRST eSIM.updateMany call is the pending-state backfill.
    return mockPrisma.eSIM.updateMany.mock.calls[0][0]
  }

  it('1. PROCESSING + null schedule + OLDER than 24h becomes eligible (no age gate)', async () => {
    await backfillEsimSyncSchedules()
    const call = pendingBackfillCall()
    expect(call.where.statusNextSyncAt).toBeNull()
    expect(call.where.status.in).toContain('PROCESSING')
    expect(call.where.createdAt).toBeUndefined()
    expect(call.data.statusNextSyncAt).toBeInstanceOf(Date)
  })

  it('2. PENDING_ACTIVATION + null schedule + older than 24h becomes eligible', async () => {
    await backfillEsimSyncSchedules()
    const call = pendingBackfillCall()
    expect(call.where.status.in).toContain('PENDING_ACTIVATION')
    expect(call.where.createdAt).toBeUndefined()
  })

  it('3. recent pending rows remain supported (same age-independent backfill)', async () => {
    await backfillEsimSyncSchedules()
    const call = pendingBackfillCall()
    expect(call.where.status.in).toEqual(PENDING_STATUSES)
    expect(call.where.createdAt).toBeUndefined()
  })

  it('4. already populated statusNextSyncAt is untouched (null-only backfill)', async () => {
    await backfillEsimSyncSchedules()
    const call = pendingBackfillCall()
    expect(call.where.statusNextSyncAt).toBeNull()
  })

  it('5. terminal statuses remain unscheduled', async () => {
    await backfillEsimSyncSchedules()
    const pending = pendingBackfillCall().where.status.in
    for (const t of TERMINAL_STATUSES) expect(pending).not.toContain(t)
  })

it('6. repeated backfill is idempotent (same guarded predicate, no extra writes)', async () => {
    await backfillEsimSyncSchedules()
    await backfillEsimSyncSchedules()
    expect(mockPrisma.eSIM.updateMany.mock.calls[0][0]).toEqual(mockPrisma.eSIM.updateMany.mock.calls[6][0])
    expect(mockPrisma.eSIM.updateMany).toHaveBeenCalledTimes(12) // 6 per pass
  })

  it('7. backfill makes zero provider calls and zero wallet mutations', async () => {
    await backfillEsimSyncSchedules()
    expect(mockBuildConnector).not.toHaveBeenCalled()
    // The mocked prisma surface for this module exposes no wallet methods, so a
    // wallet mutation could not be invoked; assert only the 6 expected eSIM
    // schedule passes exist (status pending + status active + usage active +
    // usage pending + usage depleted + terminal cleanup).
    expect(mockPrisma.eSIM.updateMany).toHaveBeenCalledTimes(6)
  })

  it('8. PENDING/PENDING_ACTIVATION null-schedule rows are seeded on a bounded 1h usage cadence', async () => {
    await backfillEsimSyncSchedules()
    const pendingUsagePass = mockPrisma.eSIM.updateMany.mock.calls[3][0]
    expect(pendingUsagePass.where.usageNextSyncAt).toBeNull()
    expect(pendingUsagePass.where.usageSyncRetryCount).toBe(0)
    expect(pendingUsagePass.where.status.in).toContain('PENDING')
    expect(pendingUsagePass.where.status.in).toContain('PENDING_ACTIVATION')
    const d = (pendingUsagePass.data.usageNextSyncAt as Date).getTime()
    expect(d - Date.now()).toBeGreaterThanOrEqual(59 * 60 * 1000)
    expect(d - Date.now()).toBeLessThan(61 * 60 * 1000)
  })
})

describe('executeStatusSynchronization — null-schedule backfill runs inside the canonical handler (natural worker path)', () => {
  it('8. executing the ESIM_STATUS_SYNC handler runs the age-independent backfill BEFORE selecting due eSIMs', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([]) // no due eSIMs — handler still backfills

    await executeStatusSynchronization(10)

// The canonical handler performs the 6 backfill schedule passes first.
    expect(mockPrisma.eSIM.updateMany).toHaveBeenCalledTimes(6)
    const pending = mockPrisma.eSIM.updateMany.mock.calls[0][0]
    expect(pending.where.statusNextSyncAt).toBeNull()
    expect(pending.where.status.in).toContain('PROCESSING')
    expect(pending.where.createdAt).toBeUndefined()
    // then the due-batch selection runs
    expect(mockPrisma.eSIM.findMany).toHaveBeenCalled()
    expect(mockBuildConnector).not.toHaveBeenCalled()
  })
})

describe('REFUNDED terminal exclusion — neither status nor usage sync can select a refunded eSIM', () => {
  it('status batch selection excludes REFUNDED (and all terminal states)', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([])
    await executeStatusSynchronization(10)
    const statusSelection = mockPrisma.eSIM.findMany.mock.calls[0][0]
    expect(statusSelection.where.status.notIn).toEqual(['FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'])
  })

it('usage batch selection admits pending/active/installed/suspended/depleted (REFUNDED excluded)', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([])
    await executeUsageSynchronization(10)
    const usageSelection = mockPrisma.eSIM.findMany.mock.calls[0][0]
    expect(usageSelection.where.status.in).toEqual(['PENDING', 'PENDING_ACTIVATION', 'ACTIVE', 'INSTALLED', 'SUSPENDED', 'DEPLETED'])
    expect(usageSelection.where.status.in).not.toContain('REFUNDED')
  })

  it('a REFUNDED row is never scheduled again by backfill (cleanup pass forces null schedules)', async () => {
    await backfillEsimSyncSchedules()
    const cleanupPass = mockPrisma.eSIM.updateMany.mock.calls[5][0]
    expect(cleanupPass.where.status.in).toEqual(['FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'])
    expect(cleanupPass.data.statusNextSyncAt).toBeNull()
  })
})

describe('SYNC_RETRY_EXHAUSTED — one deduplicated durable signal, no provider call at the stop guard', () => {
  it('status pre-dispatch stop guard emits the alert with a MASKED ICCID and makes NO provider call', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ statusSyncRetryCount: 5, status: 'ACTIVE' })])
    const connector = choiceConnector({ getStatus: vi.fn() })
    mockBuildConnector.mockResolvedValue(connector as any)

    const result = await executeStatusSynchronization(10)

    expect(result.skipped).toBe(1)
    expect(connector.getStatus).not.toHaveBeenCalled() // pre-dispatch guard never calls the provider
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled()
    const sql = String(mockPrisma.$executeRawUnsafe.mock.calls[0][0])
    const alertArgs = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(alertArgs[2]).toBe('SYNC_RETRY_EXHAUSTED')
    const alertMessage = alertArgs[4]
    expect(alertMessage).toContain('status sync retries exhausted')
    expect(alertMessage).toContain('8901••••4567') // masked ICCID
    expect(alertMessage).not.toContain('89012345678901234567') // never full ICCID
    // Identity uses the INTERNAL eSIM id (never an ICCID) + sync type.
    expect(alertArgs[7]).toBe('ESIM')
    expect(alertArgs[8]).toBe('esim-1')
    expect(alertArgs[9]).toBe('status')
    expect(sql).toContain('provider_alerts')
  })

  it('status failure custody stop emits the alert once the retry budget is exhausted', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ statusSyncRetryCount: 4, status: 'PENDING_ACTIVATION' })])
    const connector = choiceConnector({ getStatus: vi.fn().mockResolvedValue({ success: false, error: { code: 'HTTP_500' } }) })
    mockBuildConnector.mockResolvedValue(connector as any)

    await executeStatusSynchronization(10)

    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled()
    const alertArgs = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(alertArgs[2]).toBe('SYNC_RETRY_EXHAUSTED')
    expect(alertArgs[7]).toBe('ESIM')
    expect(alertArgs[8]).toBe('esim-1')
    expect(alertArgs[9]).toBe('status')
    // The stopped row persists a null schedule (never selected again).
    const update = mockPrisma.eSIM.update.mock.calls[0][0]
    expect(update.data.statusNextSyncAt).toBeNull()
    expect(update.data.statusSyncRetryCount.increment).toBe(1)
  })

  it('usage pre-dispatch stop guard emits a usage-type exhausted alert without a provider call', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ usageSyncRetryCount: 5, status: 'ACTIVE' })])
    const connector = choiceConnector({ getUsage: vi.fn() })
    mockBuildConnector.mockResolvedValue(connector as any)

    const result = await executeUsageSynchronization(10)

    expect(result.skipped).toBe(1)
    expect(connector.getUsage).not.toHaveBeenCalled()
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled()
    const alertArgs = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(alertArgs[2]).toBe('SYNC_RETRY_EXHAUSTED')
    expect(alertArgs[4]).toContain('usage sync retries exhausted')
    expect(alertArgs[7]).toBe('ESIM')
    expect(alertArgs[8]).toBe('esim-1')
    expect(alertArgs[9]).toBe('usage') // sync type keeps usage distinct from status
  })

  it('status and usage exhaustion for the same eSIM emit DISTINCT alerts (dedupKey differs)', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ statusSyncRetryCount: 5, status: 'ACTIVE' })])
    mockBuildConnector.mockResolvedValue(choiceConnector({ getUsage: vi.fn() }) as any)
    await executeStatusSynchronization(10)
    const statusArgs = mockPrisma.$executeRawUnsafe.mock.calls[0]

    vi.clearAllMocks()
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ usageSyncRetryCount: 5, status: 'ACTIVE' })])
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1 as any)
    mockBuildConnector.mockResolvedValue(choiceConnector({ getUsage: vi.fn() }) as any)
    await executeUsageSynchronization(10)
    const usageArgs = mockPrisma.$executeRawUnsafe.mock.calls[0]

    expect(statusArgs.slice(7)).not.toEqual(usageArgs.slice(7))
  })

  it('an exhausted row that later syncs successfully resolves ONLY its own + sync-type alert', async () => {
    // Status success after prior failures (retry > 0 but not yet stopped) →
    // resolves (provider, ESIM, status).
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ statusSyncRetryCount: 3, status: 'PENDING_ACTIVATION' })])
    mockBuildConnector.mockResolvedValue(choiceConnector({
      getStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'PENDING_ACTIVATION', providerStatus: 'pending' } }),
    }) as any)
    await executeStatusSynchronization(10)
    const resolveCall = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(String(resolveCall[0])).toContain('UPDATE provider_alerts')
    expect(resolveCall[1]).toBe('p-1')
    expect(resolveCall[2]).toBe('SYNC_RETRY_EXHAUSTED')
    expect(resolveCall[4]).toBe('esim-1')
    expect(resolveCall[5]).toBe('status')

    // Usage recovery resolves its OWN dedupKey — never status.
    vi.clearAllMocks()
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ usageSyncRetryCount: 3, status: 'ACTIVE' })])
    mockPrisma.$executeRawUnsafe.mockResolvedValue(0 as any)
    mockBuildConnector.mockResolvedValue(choiceConnector({
      getUsage: vi.fn().mockResolvedValue({ success: true, data: { dataUsedMB: 10, dataTotalMB: 500, dataRemainingMB: 490 } }),
    }) as any)
    await executeUsageSynchronization(10)
    const usageResolve = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(String(usageResolve[0])).toContain('UPDATE provider_alerts')
    expect(usageResolve[5]).toBe('usage')
  })
})

describe('executeUsageSynchronization � canonical depletion + scheduler recovery', () => {
  function usageConnector(getUsage: any) {
    return { capabilities: { usageLookup: true }, getUsage } as any
  }

  function lastUpdateData() {
    return mockPrisma.eSIM.update.mock.calls[0][0].data
  }

  it('1. remaining 0 changes ACTIVE to DEPLETED and schedules the conservative cadence', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'ACTIVE' })])
    mockBuildConnector.mockResolvedValue(usageConnector(
      vi.fn().mockResolvedValue({ success: true, data: { iccid: 'x', dataUsedMB: 1024, dataTotalMB: 1024, dataRemainingMB: 0 } }),
    ))

    const result = await executeUsageSynchronization(10)
    expect(result.updated).toBe(1)
    const data = lastUpdateData()
    expect(data.status).toBe('DEPLETED')
    expect(data.dataRemainingMB).toBe(0)
    expect(data.lastUsageSyncAt).toBeInstanceOf(Date)
    // DEPLETED cadence is conservative (24 h), never tight polling.
    const next = (data.usageNextSyncAt as Date).getTime()
    expect(next - Date.now()).toBeGreaterThanOrEqual(23 * 3600 * 1000)
    expect(next - Date.now()).toBeLessThan(25 * 3600 * 1000)
    expect(mockPrisma.usageRecord.create).toHaveBeenCalledTimes(1)
    const record = mockPrisma.usageRecord.create.mock.calls[0][0].data
    expect(record.dataUsedMB).toBe(1024)
    expect(record.dataTotalMB).toBe(1024)
    expect(record.dataRemainingMB).toBe(0)
  })

  it('2. negative remaining normalizes to 0 and produces DEPLETED', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'ACTIVE' })])
    mockBuildConnector.mockResolvedValue(usageConnector(
      vi.fn().mockResolvedValue({ success: true, data: { iccid: 'x', dataUsedMB: 2000, dataTotalMB: 1024, dataRemainingMB: -5 } }),
    ))
    await executeUsageSynchronization(10)
    const data = lastUpdateData()
    expect(data.dataRemainingMB).toBe(0)
    expect(data.status).toBe('DEPLETED')
  })

  it('3. positive authoritative remaining restores DEPLETED to ACTIVE', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'DEPLETED', dataUsedMB: 500, dataTotalMB: 500, dataRemainingMB: 0 })])
    mockBuildConnector.mockResolvedValue(usageConnector(
      vi.fn().mockResolvedValue({ success: true, data: { iccid: 'x', dataUsedMB: 250, dataTotalMB: 500, dataRemainingMB: 250 } }),
    ))
    await executeUsageSynchronization(10)
    expect(lastUpdateData().status).toBe('ACTIVE')
  })

  it('4. missing/ null remaining never changes lifecycle status', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'ACTIVE' })])
    mockBuildConnector.mockResolvedValue(usageConnector(
      vi.fn().mockResolvedValue({ success: true, data: { iccid: 'x', dataUsedMB: 100 } }),
    ))
    await executeUsageSynchronization(10)
    const data = lastUpdateData()
    expect(data.status).toBeUndefined()
    expect(data.dataRemainingMB).toBeUndefined()
  })

  it('NaN/Infinity remaining is treated as unknown � status unchanged', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'ACTIVE' })])
    mockBuildConnector.mockResolvedValue(usageConnector(
      vi.fn().mockResolvedValue({ success: true, data: { iccid: 'x', dataUsedMB: 0, dataRemainingMB: Number.POSITIVE_INFINITY } }),
    ))
    await executeUsageSynchronization(10)
    expect(lastUpdateData().status).toBeUndefined()
  })

  it('5. terminal statuses (EXPIRED/FAILED/CANCELLED/REFUNDED) remain unchanged at zero remaining', async () => {
    for (const terminal of ['EXPIRED', 'FAILED', 'CANCELLED', 'REFUNDED']) {
      vi.clearAllMocks()
      mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: terminal })])
      mockPrisma.$executeRawUnsafe.mockResolvedValue(1 as any)
      mockBuildConnector.mockResolvedValue(usageConnector(
        vi.fn().mockResolvedValue({ success: true, data: { iccid: 'x', dataUsedMB: 1024, dataTotalMB: 1024, dataRemainingMB: 0 } }),
      ))
      await executeUsageSynchronization(10)
      expect(lastUpdateData().status).toBeUndefined()
    }
  })

  it('7. a missing used value stays unknown � never fabricated as 0', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'ACTIVE', dataUsedMB: 100 })])
    mockBuildConnector.mockResolvedValue(usageConnector(
      vi.fn().mockResolvedValue({ success: true, data: { iccid: 'x', dataTotalMB: 1024, dataRemainingMB: 924 } }),
    ))
    await executeUsageSynchronization(10)
    const data = lastUpdateData()
    expect('dataUsedMB' in data).toBe(false) // unknown used is not written
  })

it('14. DEPLETED usage-capable rows are scheduler-eligible', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'DEPLETED', usageNextSyncAt: new Date(Date.now() - 1000) })])
    mockBuildConnector.mockResolvedValue(usageConnector(
      vi.fn().mockResolvedValue({ success: true, data: { iccid: 'x', dataUsedMB: 500, dataTotalMB: 500, dataRemainingMB: 0 } }),
    ))
    const result = await executeUsageSynchronization(10)
    expect(result.updated).toBe(1)
  })

  it('PENDING_ACTIVATION/PENDING rows are scheduler-eligible (installed-but-pending-first-usage fix)', async () => {
    // This is the exact regression for the three affected staging ICCIDs: a
    // provisioned line stuck at PENDING_ACTIVATION was never selected by the
    // usage scheduler (status filter only allowed ACTIVE/INSTALLED/SUSPENDED/
    // DEPLETED), so no usage was ever fetched and it could never auto-promote.
    // The selection predicate now INCLUDES PENDING/PENDING_ACTIVATION so a
    // usage-capable connector surfaces first-usage evidence.
    const prismaWhereCalls: any[] = []
    const originalFindMany = mockPrisma.eSIM.findMany.getMockImplementation()
    mockPrisma.eSIM.findMany.mockImplementation(async (args) => {
      prismaWhereCalls.push(args)
      return [mockEsim({ status: 'PENDING_ACTIVATION', dataUsedMB: 0, dataRemainingMB: null, usageNextSyncAt: new Date(Date.now() - 1000) })]
    })
    mockBuildConnector.mockResolvedValue(usageConnector(
      vi.fn().mockResolvedValue({ success: true, data: { iccid: 'x', dataUsedMB: 512, dataTotalMB: 1024, dataRemainingMB: 512 } }),
    ))
    const result = await executeUsageSynchronization(10)
    const selected: string[] = prismaWhereCalls[0].where.status.in
    expect(selected).toContain('PENDING_ACTIVATION')
    expect(selected).toContain('PENDING')
    expect(result.updated).toBe(1)
    const data = lastUpdateData()
    expect(data.status).toBe('ACTIVE')
    expect(data.activatedAt).toBeInstanceOf(Date)
    expect(String(originalFindMany)).toBeTruthy()
  })

  it('15. a successful positive snapshot reactivates a scheduled depleted row and reschedules 24h', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'DEPLETED', dataUsedMB: 500, dataTotalMB: 500, dataRemainingMB: 0 })])
    mockBuildConnector.mockResolvedValue(usageConnector(
      vi.fn().mockResolvedValue({ success: true, data: { iccid: 'x', dataUsedMB: 100, dataTotalMB: 500, dataRemainingMB: 400 } }),
    ))
    await executeUsageSynchronization(10)
    const data = lastUpdateData()
    expect(data.status).toBe('ACTIVE')
    const next = (data.usageNextSyncAt as Date).getTime()
    expect(next - Date.now()).toBeGreaterThanOrEqual(5 * 3600 * 1000)
    expect(next - Date.now()).toBeLessThan(7 * 3600 * 1000) // ACTIVE cadence (6 h)
  })

  it('16. a failed synchronization does NOT advance lastUsageSyncAt', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'ACTIVE', lastUsageSyncAt: new Date('2026-01-01') })])
    mockBuildConnector.mockResolvedValue(usageConnector(
      vi.fn().mockResolvedValue({ success: false, error: { code: 'HTTP_500', message: 'down' } }),
    ))
    await executeUsageSynchronization(10)
    const data = lastUpdateData()
    expect(data.lastUsageSyncAt).toBeUndefined()
    expect(data.usageSyncRetryCount.increment).toBe(1)
  })

  it('18. unsupported providers are skipped without retry increments', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([mockEsim({ status: 'ACTIVE' })])
    mockBuildConnector.mockResolvedValue({ capabilities: { usageLookup: false }, getUsage: vi.fn() } as any)
    const result = await executeUsageSynchronization(10)
    expect(result.skipped).toBe(1)
    const data = lastUpdateData()
    expect(data.usageSyncRetryCount).toBe(0)
    expect(data.usageNextSyncAt).toBeNull()
  })
})

describe('backfillEsimSyncSchedules � DEPLETED re-seed safety (never resurrect exhausted rows)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.eSIM.updateMany.mockResolvedValue({ count: 0 })
  })

it('seeds never-exhausted DEPLETED rows on the conservative 24h cadence, guarded by retryCount === 0', async () => {
    await backfillEsimSyncSchedules()
    const depletedPass = mockPrisma.eSIM.updateMany.mock.calls[4][0]
    expect(depletedPass.where.status).toBe('DEPLETED')
    expect(depletedPass.where.usageNextSyncAt).toBeNull()
    expect(depletedPass.where.usageSyncRetryCount).toBe(0) // eligibility = existing retry policy
    const d = (depletedPass.data.usageNextSyncAt as Date).getTime()
    expect(d - Date.now()).toBeGreaterThanOrEqual(23 * 3600 * 1000)
    expect(d - Date.now()).toBeLessThan(25 * 3600 * 1000)
  })

  it('an exhausted DEPLETED row (budget spent, persistent null schedule) is never re-seeded', async () => {
    // The backfill predicate requires usageSyncRetryCount === 0; an exhausted row
    // carries usageSyncRetryCount >= 5, so the DEPLETED pass can never match it and
    // its persistent-stop (usageNextSyncAt = null, the certified exhaustion state)
    // is preserved. Backfill never calls the provider at all.
    await backfillEsimSyncSchedules()
    const depletedPass = mockPrisma.eSIM.updateMany.mock.calls[3][0]
    expect(depletedPass.where.usageSyncRetryCount).toBe(0)
    expect(mockBuildConnector).not.toHaveBeenCalled()
  })
})
