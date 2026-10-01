import { describe, it, expect } from 'vitest'
import { esimUsageSnapshotValues, serializePublicEsimUsageDetail } from './esim-usage-serialize'

describe('esimUsageSnapshotValues — snapshot zero preserved, missing remains unknown', () => {
  it('a real stored zero is preserved and never replaced by a history aggregate', () => {
    const esim = { dataUsedMB: 0, dataTotalMB: 1024, dataRemainingMB: 1024, usageRecords: [{ dataUsedMB: 5 }] }
    expect(esimUsageSnapshotValues(esim)).toEqual({ dataUsedMB: 0, dataTotalMB: 1024, dataRemainingMB: 1024 })
  })

  it('missing values stay null (unknown, not fabricated zero)', () => {
    expect(esimUsageSnapshotValues({})).toEqual({ dataUsedMB: null, dataTotalMB: null, dataRemainingMB: null })
  })

  it('non-finite values are treated as unknown', () => {
    expect(esimUsageSnapshotValues({ dataUsedMB: Number.NaN, dataTotalMB: Number.POSITIVE_INFINITY })).toEqual({
      dataUsedMB: null,
      dataTotalMB: null,
      dataRemainingMB: null,
    })
  })
})

describe('serializePublicEsimUsageDetail — safe public usage payload', () => {
  it('exposes the real successful lastUsageSyncAt', () => {
    const last = new Date('2026-06-01T12:00:00Z')
    const out = serializePublicEsimUsageDetail({ id: 'e1', iccid: '89012345678901234567', status: 'ACTIVE', lastUsageSyncAt: last })
    expect(out.lastUsageSyncAt).toBe(last.toISOString())
  })

  it('renders lastUsageSyncAt null when never synchronized', () => {
    const out = serializePublicEsimUsageDetail({ id: 'e1', iccid: 'x', status: 'ACTIVE' })
    expect(out.lastUsageSyncAt).toBeNull()
  })

  it('never exposes provider internals or credentials', () => {
    const out = serializePublicEsimUsageDetail({
      id: 'e1', iccid: '89012345678901234567', imsi: '310410123456789', status: 'ACTIVE',
      providerResponse: { token: 'secret', apiToken: 'abc' },
      providerActivationId: 'act-1', providerSubscriptionId: 'sub-1', providerStatus: 'ACTIVE',
      config: { apiKey: 'k' },
    })
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('providerResponse')
    expect(serialized).not.toContain('providerActivationId')
    expect(serialized).not.toContain('providerSubscriptionId')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('providerStatus')
  })

  it('returns normalized service/setup fields (provider-neutral)', () => {
    const out = serializePublicEsimUsageDetail({
      id: 'e1', iccid: '89012345678901234567', status: 'PENDING_ACTIVATION', installationStatus: 'READY',
      activatedAt: null, activationDetectedAt: null, dataUsedMB: 0,
      qrCodeUrl: 'https://qr.example', activationCode: null, qrCode: null, smdpAddress: null, matchingId: null,
    })
    expect(out.status).toBe('PENDING_ACTIVATION')
    expect(out.serviceStatus).toBe('PENDING_ACTIVATION')
    expect(out.serviceStatusLabel).toBe('Provisioned')
    expect(out.installationStatus).toBe('READY')
    expect(out.installationStatusLabel).toBe('Ready to install')
  })
})