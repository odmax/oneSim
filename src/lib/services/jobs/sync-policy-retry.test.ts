import { describe, it, expect } from 'vitest'
import { shouldStopRetrying, nextStatusSyncDisposition, nextUsageSyncDisposition } from './sync-policy'

const MIN = 60 * 1000

describe('retry disposition — canonical RETRY vs STOP', () => {
  it('retry budget exhaustion stops (nextRetryCount reaches 5)', () => {
    const d = nextStatusSyncDisposition(4, 'NOT_FOUND')
    expect(d.nextRetryCount).toBe(5)
    expect(d.stop).toBe(true)
    expect(d.nextSyncAt).toBeNull()
  })

  it('bounded retries before exhaustion: backoff 5m/15m/30m/2h, never grows unbounded', () => {
    const expectBackoff = (count: number, ms: number) => {
      const d = nextStatusSyncDisposition(count, 'NOT_FOUND')
      expect(d.stop).toBe(false)
      expect(d.nextSyncAt).not.toBeNull()
      expect((d.nextSyncAt as Date).getTime() - Date.now()).toBeGreaterThanOrEqual(ms - 5000)
      expect((d.nextSyncAt as Date).getTime() - Date.now()).toBeLessThan(ms + 5000)
    }
    expectBackoff(0, 5 * MIN)
    expectBackoff(1, 15 * MIN)
    expectBackoff(2, 30 * MIN)
    expectBackoff(3, 2 * 3600 * 1000)
  })

  it('permanent error codes stop immediately (AUTH_FAILED / NOT_SUPPORTED only)', () => {
    for (const code of ['AUTH_FAILED', 'NOT_SUPPORTED']) {
      expect(nextStatusSyncDisposition(0, code).stop).toBe(true)
      expect(nextStatusSyncDisposition(0, code).nextSyncAt).toBeNull()
    }
  })

  it('PROVIDER_UNAVAILABLE at retryCount 0 SCHEDULES a retry (not a permanent stop)', () => {
    const d = nextStatusSyncDisposition(0, 'PROVIDER_UNAVAILABLE')
    expect(d.stop).toBe(false)
    expect(d.nextSyncAt).not.toBeNull()
  })

  it('PROVIDER_UNAVAILABLE uses bounded backoff', () => {
    const d = nextStatusSyncDisposition(1, 'PROVIDER_UNAVAILABLE')
    expect(d.stop).toBe(false)
    expect((d.nextSyncAt as Date).getTime() - Date.now()).toBeGreaterThanOrEqual(15 * 60 * 1000 - 5000)
  })

  it('repeated PROVIDER_UNAVAILABLE stops at budget exhaustion (no indefinite retry)', () => {
    expect(nextStatusSyncDisposition(4, 'PROVIDER_UNAVAILABLE').stop).toBe(true)
    expect(nextStatusSyncDisposition(4, 'PROVIDER_UNAVAILABLE').nextSyncAt).toBeNull()
  })

  it('NETWORK_ERROR keeps retrying with backoff (uses the transient policy)', () => {
    const d = nextStatusSyncDisposition(1, 'NETWORK_ERROR')
    expect(d.stop).toBe(false)
    expect(d.nextSyncAt).not.toBeNull()
  })

  it('NOT_FOUND (eventual consistency) retries within the bounded window', () => {
  for (const c of [0, 1, 2, 3]) {
    expect(nextStatusSyncDisposition(c, 'NOT_FOUND').stop).toBe(false)
  }
  // The 5th failure (nextRetryCount reached 5) stops the loop.
  expect(nextStatusSyncDisposition(4, 'NOT_FOUND').stop).toBe(true)
})

  it('retry counts cannot grow indefinitely — counts >= 5 stop', () => {
    for (let c = 5; c <= 233; c++) {
      expect(shouldStopRetrying(c)).toBe(true)
      expect(nextStatusSyncDisposition(c, 'NOT_FOUND').stop).toBe(true)
    }
  })

  it('usage disposition mirrors status disposition (backoff + stop)', () => {
    expect(nextUsageSyncDisposition(0).nextSyncAt).not.toBeNull()
    expect(nextUsageSyncDisposition(4).stop).toBe(true)
    expect(nextUsageSyncDisposition(4).nextSyncAt).toBeNull()
  })
})