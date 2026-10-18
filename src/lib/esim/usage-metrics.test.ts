import { describe, it, expect } from 'vitest'
import { deriveUsageMetrics, getUsageStaleness, USAGE_STALE_AFTER_MS, usageUsedLabel, usageRemainingLabel } from './usage-metrics'

describe('deriveUsageMetrics (neutral usage contract)', () => {
  it('no total and no remaining => hasSnapshot false (never a fake zero snapshot)', () => {
    const m = deriveUsageMetrics(0, null, null)
    expect(m.hasSnapshot).toBe(false)
    expect(m).toMatchObject({ used: 0, total: 0, remaining: 0, percentage: 0 })
  })

  it('valid zero usage with a real total is a KNOWN snapshot (0 MB, not unavailable)', () => {
    const m = deriveUsageMetrics(0, 1024, 1024)
    expect(m.hasSnapshot).toBe(true)
    expect(m).toMatchObject({ used: 0, total: 1024, remaining: 1024, percentage: 0 })
  })

  it('derives the total from used + remaining when only remaining is recorded', () => {
    const m = deriveUsageMetrics(512, null, 512)
    expect(m.hasSnapshot).toBe(true)
    expect(m).toMatchObject({ used: 512, total: 1024, remaining: 512, percentage: 50 })
  })

  it('remaining never goes below zero and percentage clamps to 100', () => {
    const m = deriveUsageMetrics(1500, 1024, null)
    expect(m).toMatchObject({ remaining: 0, percentage: 100 })
  })

  it('clamps percentage to 0 when usage is 0 and total is present', () => {
    const m = deriveUsageMetrics(0, 1024, 1024)
    expect(m.percentage).toBe(0)
  })

  it('dataTotalMB alone provides the total (remaining derived)', () => {
    const m = deriveUsageMetrics(800, 10240, null)
    expect(m).toMatchObject({ hasSnapshot: true, used: 800, total: 10240, remaining: 9440 })
  })

  it('live US-Matrix snapshot: 800 / 10240 / 9440 MB', () => {
    const m = deriveUsageMetrics(800, 10240, 9440)
    expect(m.hasSnapshot).toBe(true)
    expect(m.used).toBe(800)
    expect(m.total).toBe(10240)
    expect(m.remaining).toBe(9440)
    // 800/10240 = 7.8125% → rounded whole percent = 8
    expect(m.percentage).toBe(8)
  })
})

describe('deriveUsageMetrics — usedKnown/remainingKnown (zero preserved, missing unknown)', () => {
  it('a real used zero is marked known', () => {
    const m = deriveUsageMetrics(0, 1024, 1024)
    expect(m.hasSnapshot).toBe(true)
    expect(m.usedKnown).toBe(true)
    expect(m.remainingKnown).toBe(true)
    expect(m.used).toBe(0)
    expect(m.remaining).toBe(1024)
  })

  it('missing used stays unknown (never presented as zero)', () => {
    const m = deriveUsageMetrics(undefined, 1024, 1024)
    expect(m.hasSnapshot).toBe(true)
    expect(m.usedKnown).toBe(false)
    expect(m.used).toBe(0)
  })

  it('remaining-only snapshot has remainingKnown true and unknown used', () => {
    const m = deriveUsageMetrics(undefined, undefined, 500)
    expect(m.hasSnapshot).toBe(true)
    expect(m.remainingKnown).toBe(true)
    expect(m.usedKnown).toBe(false)
    expect(m.remaining).toBe(500)
  })

  it('no snapshot is unavailable and both known flags false', () => {
    const m = deriveUsageMetrics(null, null, null)
    expect(m.hasSnapshot).toBe(false)
    expect(m.usedKnown).toBe(false)
    expect(m.remainingKnown).toBe(false)
  })
})

describe('usage-metrics — final customer-facing unavailable rendering', () => {
  it('an eSIM without an authoritative snapshot renders the literal "Usage unavailable"', () => {
    const m = deriveUsageMetrics(undefined, undefined, undefined)
    expect(usageUsedLabel(m)).toBe('Usage unavailable')
    expect(usageUsedLabel(m)).not.toContain('0 used')
    expect(usageUsedLabel(m)).not.toContain('0.00 GB')
    expect(usageRemainingLabel(m)).toBe('—') // never the package allowance as remaining
  })

  it('a partial snapshot with unknown used still renders "Usage unavailable" (never 0 used / full remaining)', () => {
    const m = deriveUsageMetrics(undefined, 1024, 1024)
    expect(usageUsedLabel(m)).toBe('Usage unavailable')
    expect(usageRemainingLabel(m)).toBe('1.00 GB') // 1024 MB = 1.00 GB
  })

  it('a real zero snapshot renders 0.00 GB used (zero preserved, not fabricated)', () => {
    const m = deriveUsageMetrics(0, 1024, 1024)
    expect(usageUsedLabel(m)).toBe('0.00 GB')
    expect(usageRemainingLabel(m)).toBe('1.00 GB')
    expect(usageUsedLabel(m)).not.toBe('Usage unavailable')
  })

  it('never renders a fabricated zero snapshot or a fake "100% remaining"', () => {
    const m = deriveUsageMetrics(undefined, undefined, undefined)
    expect(usageUsedLabel(m)).toBe('Usage unavailable')
    expect(usageRemainingLabel(m)).toBe('—')
    expect(`${usageUsedLabel(m)} / ${usageRemainingLabel(m)}`).not.toContain('100%')
    expect(`${usageUsedLabel(m)} ${usageRemainingLabel(m)}`).not.toContain('0.00 GB')
  })
})

describe('getUsageStaleness — 12-hour boundary (default threshold)', () => {
  const start = new Date('2026-01-01T00:00:00Z')

  it('missing successful-sync timestamp ⇒ never synchronized / unavailable', () => {
    expect(getUsageStaleness(null, new Date(start))).toEqual({ synchronized: false, stale: false, ageMs: null })
  })

  it('exactly 12 hours is FRESH (<= threshold)', () => {
    const s = getUsageStaleness(start, new Date('2026-01-01T12:00:00Z'))
    expect(s.synchronized).toBe(true)
    expect(s.stale).toBe(false)
    expect(s.ageMs).toBe(12 * 3600 * 1000)
  })

  it('13 hours is STALE (> threshold)', () => {
    const s = getUsageStaleness(start, new Date('2026-01-01T13:00:00Z'))
    expect(s.stale).toBe(true)
    expect(s.ageMs).toBe(13 * 3600 * 1000)
  })

  it('a normal 6-hour cadence snapshot is comfortably fresh', () => {
    const s = getUsageStaleness(start, new Date('2026-01-01T06:00:00Z'))
    expect(s.stale).toBe(false)
  })

  it('respects a custom threshold', () => {
    expect(getUsageStaleness(start, new Date('2026-01-01T12:00:00Z'), 24 * 3600 * 1000).stale).toBe(false)
    expect(getUsageStaleness(start, new Date('2026-01-01T12:00:00Z'), 2 * 3600 * 1000).stale).toBe(true)
  })
})

describe('getUsageStaleness — documented threshold value', () => {
  it('default customer-facing stale threshold is 12 hours', () => {
    expect(USAGE_STALE_AFTER_MS).toBe(12 * 3600 * 1000)
  })
})