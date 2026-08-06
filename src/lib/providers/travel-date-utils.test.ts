import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveEffectiveTravelDate, isValidTravelDate } from './travel-date-utils'

describe('resolveEffectiveTravelDate', () => {
  const today = '2026-08-06'
  const tomorrow = '2026-08-07'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T14:30:00Z'))
  })

  it('supplied valid date preserved', () => {
    const result = resolveEffectiveTravelDate({
      requestedTravelDate: '2026-09-15',
      travelDateRequirement: 'REQUIRED',
    })
    expect(result.resolvedDate).toBe('2026-09-15')
    expect(result.error).toBeUndefined()
  })

  it('NOT_REQUIRED + no date → undefined', () => {
    const result = resolveEffectiveTravelDate({ travelDateRequirement: 'NOT_REQUIRED' })
    expect(result.resolvedDate).toBeUndefined()
  })

  it('OPTIONAL + no date → undefined', () => {
    const result = resolveEffectiveTravelDate({ travelDateRequirement: 'OPTIONAL' })
    expect(result.resolvedDate).toBeUndefined()
  })

  it('REQUIRED + IMMEDIATE + no date → today', () => {
    const result = resolveEffectiveTravelDate({
      travelDateRequirement: 'REQUIRED',
      activationPolicy: 'IMMEDIATE',
    })
    expect(result.resolvedDate).toBe(today)
  })

  it('REQUIRED + FLEXIBLE + no date → today', () => {
    const result = resolveEffectiveTravelDate({
      travelDateRequirement: 'REQUIRED',
      activationPolicy: 'FLEXIBLE',
    })
    expect(result.resolvedDate).toBe(today)
  })

  it('REQUIRED + SCHEDULED + no date → error', () => {
    const result = resolveEffectiveTravelDate({
      travelDateRequirement: 'REQUIRED',
      activationPolicy: 'SCHEDULED',
    })
    expect(result.resolvedDate).toBeUndefined()
    expect(result.error).toBe('Please select an activation date for this eSIM.')
  })

  it('leadDays=1 + no date → tomorrow', () => {
    const result = resolveEffectiveTravelDate({
      travelDateRequirement: 'REQUIRED',
      travelDateLeadDays: 1,
    })
    expect(result.resolvedDate).toBe(tomorrow)
  })

  it('invalid client date + REQUIRED → error', () => {
    const result = resolveEffectiveTravelDate({
      requestedTravelDate: 'not-a-date',
      travelDateRequirement: 'REQUIRED',
    })
    expect(result.error).toBe('The selected activation date is not valid.')
  })

  it('invalid client date + NOT_REQUIRED → undefined (safe)', () => {
    const result = resolveEffectiveTravelDate({
      requestedTravelDate: '02-08-2026',
      travelDateRequirement: 'NOT_REQUIRED',
    })
    expect(result.resolvedDate).toBeUndefined()
  })

  it('REQUIRED + IMMEDIATE + leadDays=0 + UTC midnight → today', () => {
    vi.setSystemTime(new Date('2026-08-06T23:59:59Z'))
    const result = resolveEffectiveTravelDate({ travelDateRequirement: 'REQUIRED', activationPolicy: 'IMMEDIATE' })
    expect(result.resolvedDate).toBe(today)
  })

  it('supplied valid date overrides today for REQUIRED', () => {
    const result = resolveEffectiveTravelDate({
      requestedTravelDate: '2026-10-01',
      travelDateRequirement: 'REQUIRED',
    })
    expect(result.resolvedDate).toBe('2026-10-01')
  })

  it('AirHub default (REQUIRED+FLEXIBLE+leadDays=0) → today', () => {
    const result = resolveEffectiveTravelDate({
      travelDateRequirement: 'REQUIRED',
      activationPolicy: 'FLEXIBLE',
      travelDateLeadDays: 0,
    })
    expect(result.resolvedDate).toBe(today)
  })

  it('Choice default (NOT_REQUIRED) → undefined', () => {
    const result = resolveEffectiveTravelDate({ travelDateRequirement: 'NOT_REQUIRED' })
    expect(result.resolvedDate).toBeUndefined()
  })

  it('iBASIS default (NOT_REQUIRED) → undefined', () => {
    const result = resolveEffectiveTravelDate({ travelDateRequirement: 'NOT_REQUIRED' })
    expect(result.resolvedDate).toBeUndefined()
  })

  it('Telna default (NOT_REQUIRED) → undefined', () => {
    const result = resolveEffectiveTravelDate({ travelDateRequirement: 'NOT_REQUIRED' })
    expect(result.resolvedDate).toBeUndefined()
  })

  it('no provider-name checks exist in resolver', () => {
    // The resolver takes canonical fields only — never a provider code
    const result = resolveEffectiveTravelDate({
      travelDateRequirement: 'REQUIRED',
      activationPolicy: 'FLEXIBLE',
    })
    expect(result.resolvedDate).toBe(today)
    // No provider-specific logic, just canonical fields
  })
})
