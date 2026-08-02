import { describe, it, expect } from 'vitest'
import {
  isValidTravelDate,
  normalizeTravelDateRequirement,
  requiresTravelDateForPackage,
  withTravelDateMarker,
} from './travel-date-utils'

describe('isValidTravelDate', () => {
  it('accepts a valid YYYY-MM-DD date', () => {
    expect(isValidTravelDate('2026-08-02')).toBe(true)
  })

  it('rejects ISO timestamp strings', () => {
    expect(isValidTravelDate('2026-08-02T00:00:00Z')).toBe(false)
    expect(isValidTravelDate('2026-08-02T12:00:00.000Z')).toBe(false)
  })

  it('rejects locale formats', () => {
    expect(isValidTravelDate('02-08-2026')).toBe(false)
    expect(isValidTravelDate('02/08/2026')).toBe(false)
    expect(isValidTravelDate('08/02/2026')).toBe(false)
    expect(isValidTravelDate('2026/08/02')).toBe(false)
  })

  it('rejects empty and whitespace strings', () => {
    expect(isValidTravelDate('')).toBe(false)
    expect(isValidTravelDate('   ')).toBe(false)
  })

  it('rejects impossible calendar dates', () => {
    expect(isValidTravelDate('2026-13-01')).toBe(false)
    expect(isValidTravelDate('2026-00-10')).toBe(false)
    expect(isValidTravelDate('2026-02-30')).toBe(false)
    expect(isValidTravelDate('2026-02-29')).toBe(false) // 2026 is not a leap year
  })

  it('accepts leap-day on leap years', () => {
    expect(isValidTravelDate('2028-02-29')).toBe(true)
  })

  it('rejects non-strings', () => {
    expect(isValidTravelDate(20260802 as any)).toBe(false)
    expect(isValidTravelDate(null as any)).toBe(false)
    expect(isValidTravelDate(undefined as any)).toBe(false)
  })
})

describe('normalizeTravelDateRequirement', () => {
  it('reads explicit required-flag fields (booleans)', () => {
    expect(normalizeTravelDateRequirement({ isTravelDateRequired: true })).toBe(true)
    expect(normalizeTravelDateRequirement({ isTravelDateRequired: false })).toBe(false)
    expect(normalizeTravelDateRequirement({ travelDateRequired: true })).toBe(true)
  })

  it('reads string tokens like "Mandatory" / "No Need"', () => {
    expect(normalizeTravelDateRequirement({ travelDateRequired: 'Mandatory' })).toBe(true)
    expect(normalizeTravelDateRequirement({ travelDateRequired: 'No Need' })).toBe(false)
    expect(normalizeTravelDateRequirement({ travelDateRequired: 'Required' })).toBe(true)
    expect(normalizeTravelDateRequirement({ travelDateRequired: 'Optional' })).toBe(false)
  })

  it('reads numeric and yes/no tokens', () => {
    expect(normalizeTravelDateRequirement({ travelDateRequired: 1 })).toBe(true)
    expect(normalizeTravelDateRequirement({ travelDateRequired: 0 })).toBe(false)
    expect(normalizeTravelDateRequirement({ travelDateRequired: 'yes' })).toBe(true)
    expect(normalizeTravelDateRequirement({ travelDateRequired: 'no' })).toBe(false)
  })

  it('does not treat a literal date value on travelDate as a requirement', () => {
    expect(normalizeTravelDateRequirement({ travelDate: '2026-08-02' })).toBe(false)
    expect(normalizeTravelDateRequirement({ travel_date: '2026-08-02' })).toBe(false)
  })

  it('reads ambiguous travelDate keys when the value is a token', () => {
    expect(normalizeTravelDateRequirement({ travelDate: true })).toBe(true)
    expect(normalizeTravelDateRequirement({ travelDate: 'Mandatory' })).toBe(true)
    expect(normalizeTravelDateRequirement({ travel_date: 'No Need' })).toBe(false)
    expect(normalizeTravelDateRequirement({ traveldate: 'no' })).toBe(false)
  })

  it('returns false (never guesses) for unknown fields or values', () => {
    expect(normalizeTravelDateRequirement({ someOtherFlag: 'whatever' })).toBe(false)
    expect(normalizeTravelDateRequirement({ travelDateRequired: 'maybe' })).toBe(false)
    expect(normalizeTravelDateRequirement({ travelDateRequired: 'nonsense' })).toBe(false)
    expect(normalizeTravelDateRequirement(null)).toBe(false)
    expect(normalizeTravelDateRequirement(undefined)).toBe(false)
    expect(normalizeTravelDateRequirement('string')).toBe(false)
  })

  it('round-trips a stored __requiresTravelDate marker', () => {
    expect(normalizeTravelDateRequirement({ __requiresTravelDate: true })).toBe(true)
    expect(normalizeTravelDateRequirement({ __requiresTravelDate: false })).toBe(false)
  })
})

describe('requiresTravelDateForPackage', () => {
  it('reads from providerRawData persisted metadata', () => {
    const pkg = { providerRawData: { planCode: 'X', __requiresTravelDate: true } }
    expect(requiresTravelDateForPackage(pkg)).toBe(true)
  })

  it('reads from providerRawData upstream fields', () => {
    const pkg = { providerRawData: { isTravelDateRequired: 'Mandatory' } }
    expect(requiresTravelDateForPackage(pkg)).toBe(true)
  })

  it('falls back to false for packages with no metadata', () => {
    expect(requiresTravelDateForPackage({ providerRawData: { planCode: 'X' } })).toBe(false)
    expect(requiresTravelDateForPackage(null)).toBe(false)
    expect(requiresTravelDateForPackage(undefined)).toBe(false)
  })
})

describe('withTravelDateMarker', () => {
  it('adds the normalized marker without mutating the raw object', () => {
    const raw = { planCode: 'US-5GB' }
    const out = withTravelDateMarker(raw, true)
    expect(out).toEqual({ planCode: 'US-5GB', __requiresTravelDate: true })
    expect(raw).toEqual({ planCode: 'US-5GB' })
  })
})
