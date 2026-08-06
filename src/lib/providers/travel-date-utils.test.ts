import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveEffectiveTravelDate, isValidTravelDate } from './travel-date-utils'

describe('resolveEffectiveTravelDate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T14:30:00Z'))
  })

  it('supplied valid date is preserved', () => {
    const result = resolveEffectiveTravelDate({
      requestedTravelDate: '2026-09-15',
      requiresTravelDate: true,
    })
    expect(result).toBe('2026-09-15')
  })

  it('missing date + provider requires date → today used', () => {
    const result = resolveEffectiveTravelDate({
      requestedTravelDate: undefined,
      requiresTravelDate: true,
    })
    expect(result).toBe('2026-08-06')
  })

  it('null date + provider requires date → today used', () => {
    const result = resolveEffectiveTravelDate({
      requestedTravelDate: null,
      requiresTravelDate: true,
    })
    expect(result).toBe('2026-08-06')
  })

  it('empty string + provider requires date → today used', () => {
    const result = resolveEffectiveTravelDate({
      requestedTravelDate: '',
      requiresTravelDate: true,
    })
    expect(result).toBe('2026-08-06')
  })

  it('package does not require date + no date → undefined', () => {
    const result = resolveEffectiveTravelDate({
      requestedTravelDate: undefined,
      requiresTravelDate: false,
    })
    expect(result).toBeUndefined()
  })

  it('package does not require date + supplied date → still defined', () => {
    const result = resolveEffectiveTravelDate({
      requestedTravelDate: '2026-08-02',
      requiresTravelDate: false,
    })
    expect(result).toBe('2026-08-02')
  })

  it('date formatted as YYYY-MM-DD', () => {
    const result = resolveEffectiveTravelDate({ requiresTravelDate: true })
    expect(isValidTravelDate(result)).toBe(true)
  })

  it('timezone boundary does not shift the day', () => {
    // 11:59 PM UTC → August 6
    vi.setSystemTime(new Date('2026-08-06T23:59:59Z'))
    let result = resolveEffectiveTravelDate({ requiresTravelDate: true })
    expect(result).toBe('2026-08-06')

    // 00:01 UTC → August 7
    vi.setSystemTime(new Date('2026-08-07T00:01:00Z'))
    result = resolveEffectiveTravelDate({ requiresTravelDate: true })
    expect(result).toBe('2026-08-07')
  })

  it('invalid client date + requires date → today used', () => {
    const result = resolveEffectiveTravelDate({
      requestedTravelDate: 'not-a-date',
      requiresTravelDate: true,
    })
    expect(result).toBe('2026-08-06')
  })

  it('malformed client date (DD-MM-YYYY) + requires → today', () => {
    const result = resolveEffectiveTravelDate({
      requestedTravelDate: '02-08-2026',
      requiresTravelDate: true,
    })
    expect(result).toBe('2026-08-06')
  })
})
