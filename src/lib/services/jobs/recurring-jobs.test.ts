import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    backgroundJob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  },
}))

const { prisma } = await import('@/lib/prisma')
const { seedRecurringJobs, claimEsimForSync, rescheduleRecurringJob, RECURRING_JOBS } = await import('./recurring-jobs')

const mockPrisma = vi.mocked(prisma)
const mockExec = vi.mocked(prisma.$executeRawUnsafe)
const mockUpdateMany = vi.mocked(prisma.backgroundJob.updateMany)

beforeEach(() => {
  vi.clearAllMocks()
  mockExec.mockResolvedValue(1)
  mockUpdateMany.mockResolvedValue({ count: 1 })
})

describe('recurring job intervals', () => {
  it('retains 5-minute interval for provider self-heal and 1-minute for the others', () => {
    const byType = Object.fromEntries(RECURRING_JOBS.map(j => [j.type, j.intervalMs]))
    expect(RECURRING_JOBS).toHaveLength(5)
    expect(byType.PROVIDER_SELF_HEAL).toBe(300_000)
    expect(byType.ESIM_STATUS_SYNC).toBe(60_000)
    expect(byType.ESIM_USAGE_SYNC).toBe(60_000)
    expect(byType.INSTALLATION_RECONCILIATION).toBe(60_000)
    expect(byType.TOPUP_RECONCILIATION).toBe(60_000)
  })
})

describe('seedRecurringJobs — UTC semantics', () => {
  it('seeds exactly one INSERT per recurring type', async () => {
    await seedRecurringJobs()
    const inserts = mockExec.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO background_jobs'))
    expect(inserts).toHaveLength(5)
    for (const [sql, param] of inserts) {
      expect(String(param)).toBeTruthy()
    }
  })

  it('writes runAt/createdAt/updatedAt with UTC wall-clock (NOW() AT TIME ZONE)', async () => {
    await seedRecurringJobs()
    const inserts = mockExec.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO background_jobs'))
    for (const [sql] of inserts) {
      const text = String(sql)
      expect(text).not.toMatch(/NOW\(\)\s*(,|\))/) // no bare NOW() for the timestamps
      expect(text.match(/NOW\(\) AT TIME ZONE 'UTC'/g)?.length).toBe(3) // runAt, createdAt, updatedAt
    }
  })

  it('keeps the NOT EXISTS dedupe guard (exactly one row per type)', async () => {
    await seedRecurringJobs()
    for (const [sql] of mockExec.mock.calls) {
      if (String(sql).includes('INSERT INTO background_jobs')) {
        expect(String(sql)).toContain('WHERE NOT EXISTS (SELECT 1 FROM background_jobs WHERE "type" = $1::"JobType")')
      }
    }
  })

  it('repairs stale local-clock seed rows with a narrow, idempotent predicate', async () => {
    await seedRecurringJobs()
    const repairs = mockExec.mock.calls.filter(([sql]) => String(sql).includes('UPDATE background_jobs'))
    expect(repairs).toHaveLength(5)
    for (const [sql, param] of repairs) {
      const text = String(sql)
      expect(text).toContain('"maxAttempts" = 999') // seed-only marker
      expect(text).toContain('"status" = \'PENDING\'')
      expect(text).toContain('"runAt" = "createdAt"')
      expect(text).toContain('"createdAt" = "updatedAt"') // never-processed rows only
      expect(text).toContain('NOW() AT TIME ZONE \'UTC\'') // canonical UTC repair time
      expect(text).toContain('SET "runAt"')
      expect(text).not.toContain('payload') // never touches payloads
      expect(String(param)).toBeTruthy()
    }
  })
})

describe('claimEsimForSync — UTC clock semantics', () => {
  it('compares the due field against UTC wall-clock, not server-local NOW()', async () => {
    mockExec.mockResolvedValue(1)
    await claimEsimForSync('esim-1', 'statusNextSyncAt')
    expect(mockExec).toHaveBeenCalledTimes(1)
    const [sql] = mockExec.mock.calls[0]
    const text = String(sql)
    expect(text).toContain('NOW() AT TIME ZONE \'UTC\'')
    expect(text).not.toContain('NOW())') // no bare NOW() due comparison
    // lease param is a JS Date (UTC wall-clock)
    const lease = mockExec.mock.calls[0][3]
    expect(lease).toBeInstanceOf(Date)
  })

  it('keeps the 5-minute crash-recovery lease', async () => {
    const before = Date.now()
    mockExec.mockResolvedValue(1)
    await claimEsimForSync('esim-2', 'usageNextSyncAt')
    const lease = mockExec.mock.calls[0][3] as Date
    const deltaMs = before - lease.getTime()
    expect(deltaMs).toBeGreaterThanOrEqual(5 * 60_000 - 2000)
    expect(deltaMs).toBeLessThan(5 * 60_000 + 5000)
  })
})

describe('rescheduleRecurringJob — UTC semantics', () => {
  it('reschedules a completed recurring job to now + interval (JS UTC)', async () => {
    const before = Date.now()
    await rescheduleRecurringJob('ESIM_STATUS_SYNC', 60_000)
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { type: 'ESIM_STATUS_SYNC', status: 'COMPLETED' },
      data: { status: 'PENDING', runAt: expect.any(Date), attempts: 0 },
    })
    const runAt = (mockUpdateMany.mock.calls[0][0] as any).data.runAt as Date
    expect(runAt.getTime() - before).toBeGreaterThanOrEqual(60_000 - 2000)
  })
})

describe('regression — Africa/Johannesburg (+02:00) recurring-job scheduling', () => {
  // Model the exact staging reproduction: server local 2026-08-15 07:45:31+02,
  // Node UTC now 2026-08-15 05:52:50Z, delta ≈ +113 minutes.
  const actualUtcNow = new Date('2026-08-15T05:52:50Z')

  it('OLD seed (bare NOW()) stores local wall-clock → Prisma reads it ~113m in the future and never runs it', () => {
    // PostgreSQL NOW() at +02:00 writes '2026-08-15 07:45:31' into the
    // timestamp-without-time-zone column. Prisma parses that value AS UTC.
    const storedLocalWallClock = '2026-08-15 07:45:31'
    const prismaRead = new Date(storedLocalWallClock.replace(' ', 'T') + 'Z')
    expect(prismaRead.getTime() - actualUtcNow.getTime()).toBeGreaterThan(60 * 60 * 1000) // > 1h ahead
    // processDueJobs query: runAt <= now → not due → recurring jobs never fire
    expect(prismaRead.getTime() <= actualUtcNow.getTime()).toBe(false)
  })

  it('FIXED seed (NOW() AT TIME ZONE \'UTC\') stores UTC wall-clock → Prisma reads it as immediately due', () => {
    // UTC wall-clock '2026-08-15 05:45:31' is stored; Prisma parses it as UTC.
    const storedUtcWallClock = '2026-08-15 05:45:31'
    const prismaRead = new Date(storedUtcWallClock.replace(' ', 'T') + 'Z')
    // immediately schedulable by processDueJobs (runAt <= now)
    expect(prismaRead.getTime() <= actualUtcNow.getTime()).toBe(true)
    expect(actualUtcNow.getTime() - prismaRead.getTime()).toBeLessThan(8 * 60 * 1000)
  })
})
