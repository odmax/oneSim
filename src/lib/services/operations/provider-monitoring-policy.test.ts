import { describe, it, expect } from 'vitest'
import {
  PROVIDER_MONITORED_STATUSES,
  PROVIDER_SUPPRESSED_STATUSES,
  PROVIDER_EXCLUDED_STATUSES,
  isProviderMonitored,
  isProviderAlertSuppressed,
  isProviderAlertExcluded,
} from './provider-monitoring-policy'

/**
 * Provider monitoring policy:
 *   ACTIVE / DEGRADED / TESTING  → MONITORED  (alerts opened, not suppressed)
 *   MAINTENANCE / INACTIVE        → SUPPRESSED (no new alerts; existing resolve)
 *   ARCHIVED                      → EXCLUDED   (never even evaluated)
 */
describe('provider monitoring policy', () => {
  it('ACTIVE is monitored', () => {
    expect(PROVIDER_MONITORED_STATUSES).toContain('ACTIVE')
    expect(isProviderMonitored('ACTIVE')).toBe(true)
    expect(isProviderAlertSuppressed('ACTIVE')).toBe(false)
  })

  it('DEGRADED is monitored — a degraded provider is still in service and must alert', () => {
    expect(PROVIDER_MONITORED_STATUSES).toContain('DEGRADED')
    expect(isProviderMonitored('DEGRADED')).toBe(true)
    expect(isProviderAlertSuppressed('DEGRADED')).toBe(false)
  })

  it('TESTING is monitored — a testing provider is routable and purchase-eligible, not broadly suppressed', () => {
    expect(PROVIDER_MONITORED_STATUSES).toContain('TESTING')
    expect(isProviderMonitored('TESTING')).toBe(true)
    expect(isProviderAlertSuppressed('TESTING')).toBe(false)
  })

  it('MAINTENANCE is suppressed (auto-resolve) — planned outage noise must not alert', () => {
    expect(PROVIDER_SUPPRESSED_STATUSES).toContain('MAINTENANCE')
    expect(isProviderMonitored('MAINTENANCE')).toBe(false)
    expect(isProviderAlertSuppressed('MAINTENANCE')).toBe(true)
  })

  it('INACTIVE is suppressed — a disabled provider has no runtime alerts', () => {
    expect(PROVIDER_SUPPRESSED_STATUSES).toContain('INACTIVE')
    expect(isProviderMonitored('INACTIVE')).toBe(false)
    expect(isProviderAlertSuppressed('INACTIVE')).toBe(true)
  })

  it('ARCHIVED is excluded from evaluation entirely', () => {
    expect(PROVIDER_EXCLUDED_STATUSES).toContain('ARCHIVED')
    expect(isProviderAlertExcluded('ARCHIVED')).toBe(true)
    expect(isProviderAlertSuppressed('ARCHIVED')).toBe(false)
  })

  it('case-insensitive handling and unknown values are treated as not-monitored', () => {
    expect(isProviderMonitored('active')).toBe(true)
    expect(isProviderMonitored('DEGRADED')).toBe(true)
    expect(isProviderMonitored('SOMETHING_UNKNOWN')).toBe(false)
    expect(isProviderMonitored(null)).toBe(false)
    expect(isProviderAlertSuppressed('SOMETHING_UNKNOWN')).toBe(false)
  })

  it('the policy covers every canonical provider status (no gap)', () => {
    // Every status a provider row can hold is classified in exactly one bucket:
    // monitored OR suppressed OR excluded.
    const unclassified = ['ACTIVE', 'DEGRADED', 'TESTING', 'MAINTENANCE', 'INACTIVE', 'ARCHIVED'].filter(
      (s) => !isProviderMonitored(s) && !isProviderAlertSuppressed(s) && !isProviderAlertExcluded(s),
    )
    expect(unclassified).toEqual([])
  })
})