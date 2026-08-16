import { describe, it, expect } from 'vitest'
import { deriveUsageMetrics } from './usage-metrics'

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
