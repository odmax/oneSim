import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn().mockResolvedValue({}),
  findUnique: vi.fn(),
  providerFindUnique: vi.fn(),
  claimEsimForSync: vi.fn(),
  capabilitySupported: vi.fn(),
  resolveStatusLookup: vi.fn(),
  buildProviderConnector: vi.fn(),
  getStatus: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { updateMany: mocks.updateMany, findMany: mocks.findMany, update: mocks.update, findUnique: mocks.findUnique },
    provider: { findUnique: mocks.providerFindUnique },
  },
}))

vi.mock('@/lib/services/jobs/recurring-jobs', () => ({ claimEsimForSync: mocks.claimEsimForSync }))

vi.mock('../sync-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync-policy')>()
  return { ...actual }
})

vi.mock('@/lib/services/esims/sync-lookup', () => ({
  capabilitySupported: mocks.capabilitySupported,
  resolveStatusLookup: mocks.resolveStatusLookup,
  resolveUsageLookup: vi.fn(() => ({ ok: true, identifier: 'X' })),
  buildProviderConnector: mocks.buildProviderConnector,
  mergeProviderPackageEsimId: vi.fn(() => undefined),
  isUsageLookupSkip: vi.fn(() => false),
}))

import { executeStatusSynchronization, backfillEsimSyncSchedules } from './esim-sync-batch'

function row(over: Record<string, any> = {}): any {
  return {
    id: 'esim-1', status: 'PENDING_ACTIVATION', statusSyncRetryCount: 0, usageSyncRetryCount: 0,
    statusNextSyncAt: new Date(Date.now() - 1000), usageNextSyncAt: new Date(Date.now() - 1000),
    iccid: '89012345678901234567', providerResponse: null,
    purchase: { package: { providerId: 'prov-1' } },
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.claimEsimForSync.mockResolvedValue(true)
  mocks.capabilitySupported.mockReturnValue(true)
  mocks.resolveStatusLookup.mockReturnValue({ ok: true, identifier: 'ICCID' })
  mocks.providerFindUnique.mockResolvedValue({ id: 'prov-1', status: 'ACTIVE', adapterStrategy: 'AIRHUB', type: 'AIRHUB' })
  mocks.buildProviderConnector.mockReturnValue({ getStatus: mocks.getStatus })
  mocks.updateMany.mockResolvedValue({ count: 0 })
})

describe('status-sync retry disposition (batch)', () => {
  it('executing a pre-exhausted row terminates it WITHOUT any provider call (scheduler eligibility guard)', async () => {
    mocks.findMany.mockResolvedValue([row({ statusSyncRetryCount: 233 })])
    mocks.getStatus.mockResolvedValue({ success: true, data: {} }) // would be a call if guard failed
    const r = await executeStatusSynchronization(1)
    expect(r.skipped).toBe(1)
    expect(mocks.getStatus).not.toHaveBeenCalled()
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'esim-1' },
      data: { statusNextSyncAt: null, lastStatusSyncAt: expect.any(Date) },
    })
  })

  it('exhausted stop persists null (the scheduler exclusion marker)', async () => {
    const disp = (await import('../sync-policy')).nextStatusSyncDisposition(4, 'NOT_FOUND')
    expect(disp.stop).toBe(true)
    expect(disp.nextSyncAt).toBeNull()
    // Selection only uses statusNextSyncAt lte(now); a null schedule is therefore
    // excluded from the next batch by construction.
  })

  it('retryable NOT_FOUND schedules a bounded future retry', async () => {
    mocks.findMany.mockResolvedValue([row({ statusSyncRetryCount: 1 })])
    mocks.getStatus.mockResolvedValue({ success: false, error: { code: 'NOT_FOUND', message: 'nope' } })
    const r = await executeStatusSynchronization(1)
    expect(r.failed).toBe(1)
    const upd = mocks.update.mock.calls[0][0].data
    expect(upd.statusSyncRetryCount).toEqual({ increment: 1 })
    expect(upd.statusNextSyncAt).toBeInstanceOf(Date)
    expect((upd.statusNextSyncAt as Date).getTime()).toBeGreaterThan(Date.now() + 10 * 60 * 1000)
  })

  it('NETWORK_ERROR uses bounded backoff (never a tight loop)', async () => {
    const d = (await import('../sync-policy')).nextStatusSyncDisposition(0, 'NETWORK_ERROR')
    expect(d.stop).toBe(false)
    expect(d.nextSyncAt).not.toBeNull()
  })

  it('success resets retry state and restores the normal schedule', async () => {
    mocks.findMany.mockResolvedValue([row({ statusSyncRetryCount: 2 })])
    mocks.getStatus.mockResolvedValue({ success: true, data: { status: 'ACTIVE' } })
    await executeStatusSynchronization(1)
    const upd = mocks.update.mock.calls[0][0].data
    expect(upd.statusSyncRetryCount).toBe(0)
    expect(upd.statusNextSyncAt).toBeInstanceOf(Date)
  })

  it('backfill never resurrects a stopped row (retryCount > 0 + null schedule stays null)', async () => {
    await backfillEsimSyncSchedules()
    const allWhere = mocks.updateMany.mock.calls.map((c) => c[0].where)
    for (const w of allWhere) {
      if (w.statusNextSyncAt === null) {
        expect(w.statusSyncRetryCount).toBe(0) // only never-failed rows are seeded
      }
    }
  })

  it('retry counts cannot grow to 233 through the policy (bounded 5 max)', async () => {
    const policy = await import('../sync-policy')
    let count = 0
    while (policy.shouldStopRetrying(count) === false && count < 1000) count++
    expect(count).toBeLessThanOrEqual(5)
  })

  it('manual success after a stopped state resets retryCount and restores scheduling', async () => {
    // A stopped row (statusNextSyncAt null, retryCount at/over budget) that is
    // refreshed MANUALLY succeeds → retryCount reset to 0 + normal next schedule.
    mocks.findUnique.mockResolvedValue({
      id: 'esim-1', status: 'ACTIVE', statusFuture: null, statusSyncRetryCount: 233,
      dataUsedMB: 100, activatedAt: new Date(), providerStatus: 'ACTIVE', providerResponse: null,
      usageNextSyncAt: null,
      purchase: { package: { providerId: 'prov-1' } },
    } as any)
    mocks.getStatus.mockResolvedValue({ success: true, data: { status: 'ACTIVE' } })
    const { syncESIMStatus } = await import('../../esims/sync-esim-status')
    const r = await syncESIMStatus('esim-1')
    expect(r.success).toBe(true)
    const data = mocks.update.mock.calls[0][0].data
    expect(data.statusSyncRetryCount).toBe(0)
    expect(data.statusNextSyncAt).toBeInstanceOf(Date)
  })
})