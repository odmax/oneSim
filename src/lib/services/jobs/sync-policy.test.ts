import { describe, it, expect } from 'vitest'
import { getStatusNextSync, getUsageNextSync, shouldStopRetrying } from './sync-policy'

function msUntil(date: Date): number {
  return date.getTime() - Date.now()
}

describe('sync-policy — success cadence vs failure backoff', () => {
  it('success (retryCount 0) uses the base cadence: ACTIVE +6h, PENDING +1m, SUSPENDED +24h', () => {
    expect(msUntil(getStatusNextSync('ACTIVE', 0))).toBeGreaterThanOrEqual(6 * 3600 * 1000 - 2000)
    expect(msUntil(getStatusNextSync('ACTIVE', 0))).toBeLessThan(6 * 3600 * 1000 + 5000)
    expect(msUntil(getStatusNextSync('PENDING', 0))).toBeGreaterThanOrEqual(60 * 1000 - 2000)
    expect(msUntil(getStatusNextSync('SUSPENDED', 0))).toBeGreaterThanOrEqual(24 * 3600 * 1000 - 2000)
  })

  it('failure (retryCount > 0) uses backoff — a failed ACTIVE sync is NOT scheduled at +6h', () => {
    // The previous Math.max(base, backoff) bug scheduled a failed ACTIVE sync at
    // +6h. Regression: attempt 1 must be +5m.
    expect(msUntil(getStatusNextSync('ACTIVE', 1))).toBeGreaterThanOrEqual(5 * 60 * 1000 - 2000)
    expect(msUntil(getStatusNextSync('ACTIVE', 1))).toBeLessThan(6 * 3600 * 1000)
  })

  it('failure backoff schedule: +5m / +15m / +30m / +2h', () => {
    expect(msUntil(getStatusNextSync('ACTIVE', 1))).toBeGreaterThanOrEqual(5 * 60 * 1000 - 2000)
    expect(msUntil(getStatusNextSync('ACTIVE', 2))).toBeGreaterThanOrEqual(15 * 60 * 1000 - 2000)
    expect(msUntil(getStatusNextSync('ACTIVE', 3))).toBeGreaterThanOrEqual(30 * 60 * 1000 - 2000)
    expect(msUntil(getStatusNextSync('ACTIVE', 4))).toBeGreaterThanOrEqual(2 * 3600 * 1000 - 2000)
  })

  it('usage follows the same rule: failure +5m, success ACTIVE +6h', () => {
    expect(msUntil(getUsageNextSync('ACTIVE', 1))).toBeGreaterThanOrEqual(5 * 60 * 1000 - 2000)
    expect(msUntil(getUsageNextSync('ACTIVE', 1))).toBeLessThan(6 * 3600 * 1000)
    expect(msUntil(getUsageNextSync('ACTIVE', 0))).toBeGreaterThanOrEqual(6 * 3600 * 1000 - 2000)
  })

  it('shouldStopRetrying stops at attempt 5 and on permanent error codes', () => {
    expect(shouldStopRetrying(5)).toBe(true)
    expect(shouldStopRetrying(4)).toBe(false)
    expect(shouldStopRetrying(2, 'AUTH_FAILED')).toBe(true)
    expect(shouldStopRetrying(2, 'NOT_SUPPORTED')).toBe(true)
    expect(shouldStopRetrying(2, 'PROVIDER_UNAVAILABLE')).toBe(true)
    expect(shouldStopRetrying(2, 'TIMEOUT')).toBe(false)
  })
})
