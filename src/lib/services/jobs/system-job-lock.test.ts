import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM JOB LEASE — concurrency contract tests (A–E)
//
// acquireSystemJobLease must behave as an ATOMIC lease: the outcome is decided
// by the single guarded SQL statement at the PostgreSQL level, never by
// client-side read-then-write or an in-memory mutex. These tests:
//   1. assert the emitted SQL is exactly the atomic guarded single statement;
//   2. run the function end-to-end against a stateful harness that emulates the
//      DB guard semantics (acquire iff no row OR existing lockedUntil <= now),
//      so A–E are demonstrated through the real function.
//
// Limitation: the harness replays the DB decision in JS. True cross-process
// atomicity is guaranteed by the single-statement INSERT ... ON CONFLICT
// ("jobName") ... WHERE lockedUntil <= now guarded by the unique index — that
// is asserted on the emitted SQL below (and additionally verified in the
// optional real-PostgreSQL concurrency check, when available).
// ─────────────────────────────────────────────────────────────────────────────

const harness = vi.hoisted(() => {
  type LockRow = { owner: string; lockedUntil: number }
  const lockStore = new Map<string, LockRow>()

  /** Emulates the eligibility guards of the single-statement SQL:
   *  acquire iff no row exists OR existing "lockedUntil" <= now. */
  function dbAcquire(jobName: string, owner: string, ttlMs: number, nowIso: string): number {
    const now = new Date(nowIso).getTime()
    const existing = lockStore.get(jobName)
    if (!existing || existing.lockedUntil <= now) {
      lockStore.set(jobName, { owner, lockedUntil: now + ttlMs })
      return 1
    }
    return 0
  }

  /** Emulates DELETE ... WHERE jobName = $1 AND owner = $2. */
  function dbRelease(jobName: string, owner: string): number {
    const existing = lockStore.get(jobName)
    if (existing && existing.owner === owner) {
      lockStore.delete(jobName)
      return 1
    }
    return 0
  }

  return {
    lockStore,
    dbAcquire,
    dbRelease,
    mockExecRaw: vi.fn(),
    mockDeleteMany: vi.fn(),
  }
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $executeRawUnsafe: harness.mockExecRaw,
    systemJobLock: { deleteMany: harness.mockDeleteMany },
  },
}))

import { acquireSystemJobLease, releaseSystemJobLease } from './system-job-lock'

beforeEach(() => {
  harness.lockStore.clear()
  harness.mockExecRaw.mockReset().mockImplementation(
    (_sql: unknown, jobName: unknown, ttlMs: unknown, owner: unknown, nowIso: unknown) =>
      Promise.resolve(harness.dbAcquire(String(jobName), String(owner), Number(ttlMs), String(nowIso))),
  )
  harness.mockDeleteMany.mockReset().mockImplementation(
    (args: { where: { jobName: string; owner: string } }) =>
      Promise.resolve({ count: harness.dbRelease(args.where.jobName, args.where.owner) }),
  )
})

describe('system-job-lock — emitted SQL contract', () => {
  it('acquisition is a single, guarded, parameterized statement — no client-side read/write, no transaction', async () => {
    await acquireSystemJobLease({ jobName: 'order-recovery', owner: 'worker-A', ttlMs: 60_000 })
    expect(harness.mockExecRaw).toHaveBeenCalledTimes(1)
    const sql = String(harness.mockExecRaw.mock.calls[0][0])

    // Conditional insert-or-update only when the lease is free or expired.
    expect(sql).toContain('INSERT INTO system_job_locks')
    expect(sql).toContain('ON CONFLICT ("jobName") DO UPDATE')
    expect(sql).toContain('WHERE system_job_locks."lockedUntil" <= $4::timestamp')
    expect(sql).toContain('"lockedUntil" > $4::timestamp')

    // No in-memory/naive-client unlock path: no SELECT ... FOR UPDATE, no
    // explicit transaction flow, no bare NOW() (UTC clock rule for Prisma
    // timestamp columns — see recurring-jobs.ts).
    expect(sql).not.toMatch(/FOR UPDATE/i)
    expect(sql).not.toMatch(/BEGIN|COMMIT|ROLLBACK/i)
    expect(sql).not.toMatch(/NOW\(\)/i)
  })

  it('passes the clock as a JS-UTC parameter and the ttl as an interval multiplier', async () => {
    await acquireSystemJobLease({ jobName: 'order-recovery', owner: 'worker-A', ttlMs: 60_000 })
    const [, jobName, ttlMs, owner, nowIso] = harness.mockExecRaw.mock.calls[0]
    expect(String(jobName)).toBe('order-recovery')
    expect(Number(ttlMs)).toBe(60_000)
    expect(String(owner)).toBe('worker-A')
    expect(new Date(String(nowIso)).toISOString()).toBe(String(nowIso)) // UTC wall-clock, never bare NOW()
  })

  it('guards empty jobName/owner and non-positive ttl without touching the DB', async () => {
    expect(await acquireSystemJobLease({ jobName: '', owner: 'a' })).toBe(false)
    expect(await acquireSystemJobLease({ jobName: 'x', owner: '' })).toBe(false)
    expect(await acquireSystemJobLease({ jobName: 'x', owner: 'a', ttlMs: 0 })).toBe(false)
    expect(await releaseSystemJobLease('', 'a')).toBe(0)
    expect(harness.mockExecRaw).not.toHaveBeenCalled()
  })
})

describe('system-job-lock — concurrency behavior (A–E)', () => {
  it('A: the first caller acquires the lease', async () => {
    const ok = await acquireSystemJobLease({ jobName: 'order-recovery', owner: 'worker-A', ttlMs: 60_000 })
    expect(ok).toBe(true)
    const row = harness.lockStore.get('order-recovery')
    expect(row?.owner).toBe('worker-A')
    expect(row!.lockedUntil).toBeGreaterThan(Date.now())
  })

  it('B: a concurrent second caller cannot acquire an unexpired lease — fails cleanly, owner unchanged', async () => {
    expect(await acquireSystemJobLease({ jobName: 'inventory-reservation-sweep', owner: 'replica-1', ttlMs: 60_000 })).toBe(true)
    const ok2 = await acquireSystemJobLease({ jobName: 'inventory-reservation-sweep', owner: 'replica-2', ttlMs: 60_000 })
    expect(ok2).toBe(false)
    expect(harness.lockStore.get('inventory-reservation-sweep')?.owner).toBe('replica-1')
  })

  it('C: an expired (crashed-worker) lease is immediately re-acquirable', async () => {
    expect(await acquireSystemJobLease({ jobName: 'order-recovery', owner: 'crashed-worker', ttlMs: 60_000 })).toBe(true)
    // Simulate the prior worker dying after its TTL passed.
    harness.lockStore.get('order-recovery')!.lockedUntil = Date.now() - 5_000
    const ok = await acquireSystemJobLease({ jobName: 'order-recovery', owner: 'new-worker', ttlMs: 120_000 })
    expect(ok).toBe(true)
    expect(harness.lockStore.get('order-recovery')?.owner).toBe('new-worker')
  })

  it('D: different job names do not block each other', async () => {
    expect(await acquireSystemJobLease({ jobName: 'order-recovery', owner: 'A', ttlMs: 60_000 })).toBe(true)
    expect(await acquireSystemJobLease({ jobName: 'inventory-reservation-sweep', owner: 'B', ttlMs: 60_000 })).toBe(true)
    expect(harness.lockStore.size).toBe(2)
    // Both leases stay held independently.
    expect(await acquireSystemJobLease({ jobName: 'order-recovery', owner: 'A2', ttlMs: 60_000 })).toBe(false)
    expect(harness.lockStore.get('inventory-reservation-sweep')?.owner).toBe('B')
  })

  it('E: release is idempotent and ownership-scoped', async () => {
    expect(await acquireSystemJobLease({ jobName: 'order-recovery', owner: 'worker-A', ttlMs: 60_000 })).toBe(true)
    // A different owner cannot release the lease.
    expect(await releaseSystemJobLease('order-recovery', 'worker-B')).toBe(0)
    expect(harness.lockStore.has('order-recovery')).toBe(true)
    // The owning process releases.
    expect(await releaseSystemJobLease('order-recovery', 'worker-A')).toBe(1)
    expect(harness.lockStore.has('order-recovery')).toBe(false)
    // Releasing an already-released (or never-held) lease is a safe no-op.
    expect(await releaseSystemJobLease('order-recovery', 'worker-A')).toBe(0)
  })

  it('E2: an expired lease needs no explicit release — it is simply acquirable again', async () => {
    expect(await acquireSystemJobLease({ jobName: 'order-recovery', owner: 'crashed-worker', ttlMs: 60_000 })).toBe(true)
    harness.lockStore.get('order-recovery')!.lockedUntil = Date.now() - 1
    expect(await acquireSystemJobLease({ jobName: 'order-recovery', owner: 'worker-B', ttlMs: 60_000 })).toBe(true)
  })
})