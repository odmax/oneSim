import { describe, expect, it } from 'vitest'
import { normalizeTelnaWebhook } from './telna-webhook-normalizer'

describe('normalizeTelnaWebhook', () => {
  it('maps successful RSP notification points to install-axis events', () => {
    const base = {
      iccid: '89012345678901234567',
      notificationPointStatus: { status: 'Executed-Success' },
    }
    expect(normalizeTelnaWebhook({ ...base, notificationPointId: '3' })).toMatchObject({ eventType: 'ESIM_PROFILE_DOWNLOADED', installationStatus: 'DOWNLOADED' })
    expect(normalizeTelnaWebhook({ ...base, notificationPointId: '4' })).toMatchObject({ eventType: 'ESIM_INSTALLED', installationStatus: 'INSTALLED' })
    expect(normalizeTelnaWebhook({ ...base, notificationPointId: '6' })).toMatchObject({ eventType: 'ESIM_INSTALLED', installationStatus: 'ENABLED' })
    expect(normalizeTelnaWebhook({ ...base, notificationPointId: '7' })).toMatchObject({ eventType: 'ESIM_PROFILE_DISABLED', installationStatus: 'DISABLED' })
    expect(normalizeTelnaWebhook({ ...base, notificationPointId: '8' })).toMatchObject({ eventType: 'ESIM_PROFILE_DELETED', installationStatus: 'DELETED' })
  })

  it('treats failed RSP notifications as install failures and does not accept pending callbacks', () => {
    expect(normalizeTelnaWebhook({ iccid: 'i', notificationPointId: '4', notificationPointStatus: { status: 'Failed' } }))
      .toMatchObject({ eventType: 'ESIM_INSTALLATION_FAILED', installationStatus: 'FAILED' })
    expect(normalizeTelnaWebhook({ iccid: 'i', notificationPointId: '4', notificationPointStatus: { status: 'Expired' } }))
      .toMatchObject({ eventType: 'ESIM_INSTALLATION_FAILED', installationStatus: 'FAILED' })
    expect(normalizeTelnaWebhook({ iccid: 'i', notificationPointId: '4', notificationPointStatus: { status: 'Waiting' } }).eventType)
      .toBe('UNKNOWN')
  })

  it('normalizes byte usage alerts and safely accepts numeric or ISO timestamps', () => {
    const base = {
      eventName: 'PACKAGE_DATA_USAGE_ALERT',
      eventDetails: { sim: { iccid: '890123' }, package: { id: 'pkg-1', packageUsedBytes: 1, packageTotalBytes: 10 * 1024 * 1024 } },
    }
    expect(normalizeTelnaWebhook({ ...base, eventTimestamp: 1_689_714_160_492 })).toMatchObject({
      eventType: 'USAGE_UPDATED', iccid: '890123', dataUsedMB: 1, dataTotalMB: 10, dataRemainingMB: 9,
      usageDate: '2023-07-18T21:02:40.492Z',
    })
    expect(normalizeTelnaWebhook({ ...base, eventTimestamp: '2026-09-29T12:00:00Z' }).usageDate)
      .toBe('2026-09-29T12:00:00.000Z')
    expect(normalizeTelnaWebhook({ ...base, eventTimestamp: 9e99 }).usageDate).toBeUndefined()
  })

  it('maps package status events without treating ACTIVATED alone as verified activation', () => {
    const payload = { eventName: 'PACKAGE_STATUS_CHANGE', eventDetails: { sim: { iccid: 'i' }, package: { id: 'p', status: { currentValue: 'ACTIVATED' } } } }
    expect(normalizeTelnaWebhook(payload)).toMatchObject({ eventType: 'ESIM_ACTIVATED', iccid: 'i', providerStatus: 'ACTIVATED' })
    expect(normalizeTelnaWebhook({ ...payload, eventDetails: { ...payload.eventDetails, package: { id: 'p', status: { currentValue: 'TERMINATED' } } } }).eventType)
      .toBe('ESIM_EXPIRED')
  })
})
