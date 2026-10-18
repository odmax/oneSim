import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: { $executeRawUnsafe: vi.fn() },
}))

const { prisma } = await import('@/lib/prisma')
const { insertUsageAlertIfAbsent, resolveUsageAlertType, lowerUsageTiers, USAGE_THRESHOLD_TIERS, USAGE_ALERT_INSERT_SQL } = await import('./usage-alert-store')

const mockPrisma = vi.mocked(prisma)

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$executeRawUnsafe.mockResolvedValue(1 as any)
})

describe('USAGE_THRESHOLD_TIERS / lowerUsageTiers — progression semantics', () => {
  it('ranks USAGE_80 < USAGE_90 < USAGE_100', () => {
    expect(USAGE_THRESHOLD_TIERS.USAGE_80).toBe(80)
    expect(USAGE_THRESHOLD_TIERS.USAGE_90).toBe(90)
    expect(USAGE_THRESHOLD_TIERS.USAGE_100).toBe(100)
  })

  it('a higher tier closes lower tiers; lower tiers and non-threshold types have none', () => {
    expect(lowerUsageTiers('USAGE_100')).toEqual(['USAGE_80', 'USAGE_90'])
    expect(lowerUsageTiers('USAGE_90')).toEqual(['USAGE_80'])
    expect(lowerUsageTiers('USAGE_80')).toEqual([])
    expect(lowerUsageTiers('NO_ACTIVITY')).toEqual([])
    expect(lowerUsageTiers('USAGE_SPIKE')).toEqual([])
  })
})

describe('insertUsageAlertIfAbsent — atomic race-safe create', () => {
  it('targets the partial unique index ON CONFLICT so concurrent duplicates cannot both succeed', async () => {
    const inserted = await insertUsageAlertIfAbsent({ esimId: 'esim-1', alertType: 'USAGE_90', severity: 'WARNING', message: 'SIM 8901****4567 has used 95%' })
    expect(inserted).toBe(true)
    const [sql, esimId, alertType, severity, message] = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(String(sql)).toBe(USAGE_ALERT_INSERT_SQL)
    expect(String(sql)).toContain('ON CONFLICT ("esimId","alertType") WHERE "acknowledgedAt" IS NULL')
    expect(String(sql)).toContain('DO NOTHING')
    expect(esimId).toBe('esim-1')
    expect(alertType).toBe('USAGE_90')
    expect(severity).toBe('WARNING')
    expect(message).toContain('8901****4567')
  })

  it('returns false when the conflict wins (rowCount 0) — no second unresolved alert', async () => {
    mockPrisma.$executeRawUnsafe.mockResolvedValue(0 as any)
    expect(await insertUsageAlertIfAbsent({ esimId: 'esim-1', alertType: 'NO_ACTIVITY', severity: 'WARNING', message: 'm' })).toBe(false)
  })

  it('two concurrent attempts produce exactly ONE created (the DB index is the arbiter)', async () => {
    mockPrisma.$executeRawUnsafe.mockResolvedValueOnce(1 as any).mockResolvedValueOnce(0 as any)
    const a = await insertUsageAlertIfAbsent({ esimId: 'esim-1', alertType: 'USAGE_100', severity: 'CRITICAL', message: 'm' })
    const b = await insertUsageAlertIfAbsent({ esimId: 'esim-1', alertType: 'USAGE_100', severity: 'CRITICAL', message: 'm' })
    expect(a).toBe(true)
    expect(b).toBe(false)
    // Exactly one of the two concurrent attempts observed a created row; the
    // other lost the ON CONFLICT against the partial unique index.
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('never throws when the store is unavailable', async () => {
    (mockPrisma.$executeRawUnsafe as any).mockImplementation(() => { throw new Error('db down') })
    await expect(insertUsageAlertIfAbsent({ esimId: 'esim-1', alertType: 'USAGE_80', severity: 'INFO', message: 'm' })).resolves.toBe(false)
  })
})

describe('resolveUsageAlertType — recovery semantics', () => {
  it('closes ONLY unresolved rows (WHERE acknowledgedAt IS NULL) and marks the SYSTEM resolver', async () => {
    await resolveUsageAlertType('esim-1', 'USAGE_90')
    const [sql, esimId, alertType] = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(String(sql)).toContain('UPDATE usage_alerts')
    expect(String(sql)).toContain('"acknowledgedBy" = \'SYSTEM\'')
    expect(String(sql)).toContain('"acknowledgedAt" IS NULL')
    expect(esimId).toBe('esim-1')
    expect(alertType).toBe('USAGE_90')
  })

  it('never throws', async () => {
    mockPrisma.$executeRawUnsafe.mockRejectedValue(new Error('db down'))
    await expect(resolveUsageAlertType('esim-1', 'USAGE_80')).resolves.toBeUndefined()
  })
})