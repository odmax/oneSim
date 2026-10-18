import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  usageRecordCreate: vi.fn(),
  esimUpdate: vi.fn().mockResolvedValue({}),
  connectorGetUsage: vi.fn(),
  capabilitySupported: vi.fn(),
  resolveUsageLookup: vi.fn(),
  buildProviderConnector: vi.fn(),
  mergeProviderPackageEsimId: vi.fn(),
  isUsageLookupSkip: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { findUnique: mocks.findUnique },
    $transaction: (fn: any) => fn({
      usageRecord: { create: mocks.usageRecordCreate },
      eSIM: { update: mocks.esimUpdate },
    }),
  },
}))

vi.mock('@/lib/services/esims/sync-lookup', () => ({
  capabilitySupported: mocks.capabilitySupported,
  resolveUsageLookup: mocks.resolveUsageLookup,
  buildProviderConnector: mocks.buildProviderConnector,
  mergeProviderPackageEsimId: mocks.mergeProviderPackageEsimId,
  isUsageLookupSkip: mocks.isUsageLookupSkip,
}))

import { syncESIMUsage, normalizeDataRemainingMB } from './sync-usage'

function esimRow(overrides: Record<string, any> = {}): any {
  return {
    id: 'esim-1',
    status: 'ACTIVE',
    dataUsedMB: 0,
    dataRemainingMB: 500,
    dataTotalMB: 500,
    providerStatus: null,
    providerResponse: null,
    purchase: { package: { providerId: 'prov-airhub' } },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.capabilitySupported.mockReturnValue(true)
  mocks.resolveUsageLookup.mockReturnValue({ ok: true, identifier: 'ICCID-1' })
  mocks.buildProviderConnector.mockReturnValue({ getUsage: mocks.connectorGetUsage })
  mocks.mergeProviderPackageEsimId.mockReturnValue(undefined)
  mocks.isUsageLookupSkip.mockReturnValue(false)
})

describe('syncESIMUsage — canonical DEPLETED persistence', () => {
  it('remaining = 0 results in DEPLETED', async () => {
    mocks.findUnique.mockResolvedValue(esimRow())
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 400, dataTotalMB: 500, dataRemainingMB: 0 } })
    const r = await syncESIMUsage('esim-1')
    expect(r.status).toBe('DEPLETED')
    const data = mocks.esimUpdate.mock.calls[0][0].data
    expect(data.status).toBe('DEPLETED')
    expect(data.dataRemainingMB).toBe(0)
  })

  it('preserves original provider lifecycle status in providerStatus while setting DEPLETED', async () => {
    mocks.findUnique.mockResolvedValue(esimRow())
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 500, dataTotalMB: 500, dataRemainingMB: 0, status: 'ACTIVE' } })
    const r = await syncESIMUsage('esim-1')
    expect(r.status).toBe('DEPLETED')
    const data = mocks.esimUpdate.mock.calls[0][0].data
    expect(data.status).toBe('DEPLETED')
    expect(data.providerStatus).toBe('ACTIVE') // raw provider lifecycle preserved, not overwritten
  })

  it('explicit EXHAUSTED provider status normalizes to DEPLETED even without numeric remaining', async () => {
    mocks.findUnique.mockResolvedValue(esimRow())
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 100, status: 'EXHAUSTED' } })
    const r = await syncESIMUsage('esim-1')
    expect(r.status).toBe('DEPLETED')
    expect(mocks.esimUpdate.mock.calls[0][0].data.status).toBe('DEPLETED')
  })

  it('EXPIRED eSIM remains EXPIRED even when remaining = 0', async () => {
    mocks.findUnique.mockResolvedValue(esimRow({ status: 'EXPIRED' }))
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 500, dataTotalMB: 500, dataRemainingMB: 0 } })
    const r = await syncESIMUsage('esim-1')
    expect(r.status).toBe('EXPIRED')
    const data = mocks.esimUpdate.mock.calls[0][0].data
    expect(data.status).toBeUndefined()
  })

  it('DEPLETED with authoritative remaining > 0 returns to ACTIVE (top-up reactivation)', async () => {
    mocks.findUnique.mockResolvedValue(esimRow({ status: 'DEPLETED', dataRemainingMB: 0 }))
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 300, dataTotalMB: 500, dataRemainingMB: 200 } })
    const r = await syncESIMUsage('esim-1')
    expect(r.status).toBe('ACTIVE')
    expect(mocks.esimUpdate.mock.calls[0][0].data.status).toBe('ACTIVE')
  })

  it('repeated identical depletion sync is idempotent (no status write)', async () => {
    mocks.findUnique.mockResolvedValue(esimRow({ status: 'DEPLETED', dataRemainingMB: 0 }))
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 500, dataTotalMB: 500, dataRemainingMB: 0 } })
    const r = await syncESIMUsage('esim-1')
    expect(r.status).toBe('DEPLETED')
    const data = mocks.esimUpdate.mock.calls[0][0].data
    expect(data.status).toBeUndefined()
  })

  it('missing/unknown remaining data never results in DEPLETED', async () => {
    mocks.findUnique.mockResolvedValue(esimRow())
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 100 } })
    await syncESIMUsage('esim-1')
    const data = mocks.esimUpdate.mock.calls[0][0].data
    expect(data.status).toBeUndefined()
  })

  it('usage failure preserves the existing status', async () => {
    mocks.findUnique.mockResolvedValue(esimRow())
    mocks.connectorGetUsage.mockResolvedValue({ success: false, error: { code: 'UPSTREAM_ERROR', message: 'boom' } })
    const r = await syncESIMUsage('esim-1')
    expect(r.success).toBe(false)
    expect(mocks.esimUpdate).not.toHaveBeenCalled()
  })

  it('successful manual refresh resets the usage retry budget so a STOPPED row becomes scheduler-eligible again', async () => {
    mocks.findUnique.mockResolvedValue(esimRow({ status: 'ACTIVE', usageSyncRetryCount: 5, usageNextSyncAt: null, dataUsedMB: 100 }))
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 150, dataTotalMB: 500, dataRemainingMB: 350 } })
    const r = await syncESIMUsage('esim-1')
    expect(r.success).toBe(true)
    const data = mocks.esimUpdate.mock.calls[0][0].data
    expect(data.usageSyncRetryCount).toBe(0)
    expect(data.usageNextSyncAt).toBeInstanceOf(Date)
  })

  it('authoritative usage > 0 promotes PENDING_ACTIVATION → ACTIVE via canonical activation (manual path parity)', async () => {
    mocks.findUnique.mockResolvedValue(esimRow({ status: 'PENDING_ACTIVATION', providerStatus: 'ACTIVE', dataUsedMB: 0, dataRemainingMB: null }))
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 128, dataTotalMB: 1024, dataRemainingMB: 896 } })
    const r = await syncESIMUsage('esim-1')
    expect(r.status).toBe('ACTIVE')
    const data = mocks.esimUpdate.mock.calls[0][0].data
    expect(data.status).toBe('ACTIVE')
    expect(data.activatedAt).toBeInstanceOf(Date)
    expect(data.activationDetectedAt).toBeInstanceOf(Date)
    // The raw stored provider lifecycle is preserved (not overwritten to ACTIVE
    // by the usage sync when the usage payload carries no status).
    expect(data.providerStatus).toBeUndefined()
  })

  it('zero-used snapshot (valid) does NOT promote PENDING → ACTIVE', async () => {
    mocks.findUnique.mockResolvedValue(esimRow({ status: 'PENDING_ACTIVATION', dataUsedMB: 0, dataRemainingMB: null }))
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 0, dataTotalMB: 1024, dataRemainingMB: 1024 } })
    const r = await syncESIMUsage('esim-1')
    expect(r.status).toBe('PENDING_ACTIVATION')
    const data = mocks.esimUpdate.mock.calls[0][0].data
    expect(data.status).toBeUndefined()
    expect(data.activatedAt).toBeUndefined()
  })

  it('missing usage does NOT promote PENDING → ACTIVE', async () => {
    mocks.findUnique.mockResolvedValue(esimRow({ status: 'PENDING_ACTIVATION', dataUsedMB: 0, dataRemainingMB: null }))
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataRemainingMB: null, status: 'ACTIVE' } })
    const r = await syncESIMUsage('esim-1')
    // Missing remaining is unknown (never DEPLETED); missing used is unknown
    // (never activation evidence). PENDING_ACTIVATION stays.
    expect(r.status).toBe('PENDING_ACTIVATION')
  })

  it('PENDING with dataRemaining 0 on a valid snapshot → DEPLETED (depletion precedence over activation)', async () => {
    mocks.findUnique.mockResolvedValue(esimRow({ status: 'PENDING_ACTIVATION', dataUsedMB: 0, dataRemainingMB: null }))
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 100, dataTotalMB: 100, dataRemainingMB: 0 } })
    const r = await syncESIMUsage('esim-1')
    expect(r.status).toBe('DEPLETED')
    const data = mocks.esimUpdate.mock.calls[0][0].data
    expect(data.status).toBe('DEPLETED')
  })
})

describe('usage history + zero preservation', () => {
  it('UsageRecord preserves an authoritative total of zero', async () => {
    mocks.findUnique.mockResolvedValue(esimRow())
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 0, dataTotalMB: 0, dataRemainingMB: 0 } })
    await syncESIMUsage('esim-1')
    const rec = mocks.usageRecordCreate.mock.calls[0][0].data
    expect(rec.dataTotalMB).toBe(0)
    expect(rec.dataUsedMB).toBe(0)
    expect(rec.dataRemainingMB).toBe(0)
  })

  it('a missing used value stays unknown — never fabricated as 0 on the eSIM snapshot', async () => {
    mocks.findUnique.mockResolvedValue(esimRow({ dataUsedMB: 400 }))
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataRemainingMB: 100, dataTotalMB: 500 } })
    await syncESIMUsage('esim-1')
    const data = mocks.esimUpdate.mock.calls[0][0].data
    expect('dataUsedMB' in data).toBe(false)
  })

  it('a successful authoritative fetch reschedules DEPLETED on the conservative cadence', async () => {
    mocks.findUnique.mockResolvedValue(esimRow({ status: 'DEPLETED', dataRemainingMB: 0 }))
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 500, dataTotalMB: 500, dataRemainingMB: 0 } })
    await syncESIMUsage('esim-1')
    const data = mocks.esimUpdate.mock.calls[0][0].data
    const next = (data.usageNextSyncAt as Date).getTime()
    expect(next - Date.now()).toBeGreaterThanOrEqual(23 * 3600 * 1000)
    expect(next - Date.now()).toBeLessThan(25 * 3600 * 1000)
  })
})

describe('normalizeDataRemainingMB — negative/NaN canonicalization', () => {
  it('-1 persists as 0 and produces DEPLETED', async () => {
    mocks.findUnique.mockResolvedValue(esimRow())
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 500, dataTotalMB: 500, dataRemainingMB: -1 } })
    const r = await syncESIMUsage('esim-1')
    expect(r.dataRemainingMB).toBe(0)
    expect(r.status).toBe('DEPLETED')
    const data = mocks.esimUpdate.mock.calls[0][0].data
    expect(data.dataRemainingMB).toBe(0)
    expect(mocks.usageRecordCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dataRemainingMB: 0 }) }))
  })

  it('0 persists as 0 and produces DEPLETED', async () => {
    mocks.findUnique.mockResolvedValue(esimRow())
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 500, dataTotalMB: 500, dataRemainingMB: 0 } })
    const r = await syncESIMUsage('esim-1')
    expect(r.dataRemainingMB).toBe(0)
    expect(r.status).toBe('DEPLETED')
    expect(mocks.esimUpdate.mock.calls[0][0].data.dataRemainingMB).toBe(0)
  })

  it('positive reported value remains unchanged', async () => {
    expect(normalizeDataRemainingMB(250)).toBe(250)
  })

  it('null/missing/NaN/Infinity do not falsely produce DEPLETED and are not persisted', async () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity, 'garbage']) {
      expect(normalizeDataRemainingMB(v)).toBeNull()
    }
    mocks.findUnique.mockResolvedValue(esimRow())
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 100, dataTotalMB: 500, dataRemainingMB: NaN } })
    await syncESIMUsage('esim-1')
    const data = mocks.esimUpdate.mock.calls[0][0].data
    expect(data.status).toBeUndefined()
    expect(data.dataRemainingMB).toBeUndefined()
  })
})

describe('sync timestamp semantics — successful authoritative fetch', () => {
  it('repeat identical snapshot: no lifecycle transition, timestamps advance, history recorded', async () => {
    // First sync establishes DEPLETED.
    mocks.findUnique.mockResolvedValue(esimRow())
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 500, dataTotalMB: 500, dataRemainingMB: 0 } })
    await syncESIMUsage('esim-1')

    // Second, identical snapshot against a row already DEPLETED at remaining 0
    // carrying the post-first-sync usage values.
    mocks.findUnique.mockResolvedValue(esimRow({ status: 'DEPLETED', dataRemainingMB: 0, dataUsedMB: 500, dataTotalMB: 500 }))
    mocks.connectorGetUsage.mockResolvedValue({ success: true, data: { dataUsedMB: 500, dataTotalMB: 500, dataRemainingMB: 0 } })
    const r = await syncESIMUsage('esim-1')
    expect(r.status).toBe('DEPLETED')
    const data = mocks.esimUpdate.mock.calls[mocks.esimUpdate.mock.calls.length - 1][0].data
    // No false lifecycle transition and no usage-value rewrite:
    expect(data.status).toBeUndefined()
    expect(data.dataUsedMB).toBeUndefined()
    expect(data.dataRemainingMB).toBeUndefined()
    // Successful sync timestamps still advance (never appears stale):
    expect(data.lastSyncAt).toBeInstanceOf(Date)
    expect(data.lastUsageSyncAt).toBeInstanceOf(Date)
    // History contract: each authoritative snapshot is recorded.
    expect(mocks.usageRecordCreate).toHaveBeenCalledTimes(2)
  })
})