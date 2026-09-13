import { prisma } from '@/lib/prisma'

/**
 * Canonical, ATOMIC SystemJobLock lease acquisition.
 *
 * The previous pattern (prisma.systemJobLock.upsert) could OVERWRITE an
 * unexpired lock, so two ECS replicas running the same cron/internal job could
 * both proceed. This helper makes acquisition a single conditional
 * INSERT ... ON CONFLICT ("jobName") DO UPDATE WHERE "lockedUntil" <= now.
 *
 * Semantics (all enforced by PostgreSQL, not by client logic):
 *   - acquired only when no row exists OR the existing lease has expired;
 *   - atomic single-statement: no read-then-write race, no in-memory mutex,
 *     no open transaction (callers never hold a DB transaction across
 *     provider/network work);
 *   - a concurrent caller for an active (unexpired) lease gets affected=0 and
 *     fails cleanly;
 *   - crash-safe: an expired lease becomes acquirable (crash recovery);
 *   - release/expiry are idempotent and safe if the process dies.
 *
 * Clock rule: the Prisma DateTime columns are `timestamp without time zone`
 * and are read/written as UTC wall-clock (see recurring-jobs.ts). The clock
 * parameter here is `new Date().toISOString()` — a JS UTC wall-clock value —
 * cast explicitly with `::timestamp`. Bare `NOW()` must NEVER be used against
 * these columns (server-local time offset under non-UTC DB timezones).
 *
 * `gen_random_uuid()` requires PostgreSQL 13+ (already used by the repository's
 * raw SQL, e.g. recurring-jobs seed).
 */

export const SYSTEM_JOB_LEASE_DEFAULT_TTL_MS = 15 * 60 * 1000

export interface AcquireSystemJobLeaseInput {
  jobName: string
  owner: string
  ttlMs?: number
}

export async function acquireSystemJobLease(input: AcquireSystemJobLeaseInput): Promise<boolean> {
  const { jobName, owner, ttlMs = SYSTEM_JOB_LEASE_DEFAULT_TTL_MS } = input
  if (!jobName || !owner) return false
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false

  const nowIso = new Date().toISOString()
  const affected = await prisma.$executeRawUnsafe(`
    INSERT INTO system_job_locks ("id", "jobName", "lockedAt", "lockedUntil", "owner", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), $1::text, $4::timestamp, $4::timestamp + ($2::int * interval '1 millisecond'), $3::text, $4::timestamp, $4::timestamp
    WHERE NOT EXISTS (SELECT 1 FROM system_job_locks WHERE "jobName" = $1::text AND "lockedUntil" > $4::timestamp)
    ON CONFLICT ("jobName") DO UPDATE SET
      "lockedAt" = $4::timestamp,
      "lockedUntil" = $4::timestamp + ($2::int * interval '1 millisecond'),
      "owner" = $3::text,
      "updatedAt" = $4::timestamp
    WHERE system_job_locks."lockedUntil" <= $4::timestamp
  `, jobName, ttlMs, owner, nowIso)

  return affected > 0
}

/**
 * Idempotent, ownership-scoped release. Only the owning process may release;
 * deleting a non-existent lock returns 0 and is a safe no-op. Expired leases
 * are also automatically re-acquirable without an explicit release, so a crash
 * never strands a job name.
 */
export async function releaseSystemJobLease(jobName: string, owner: string): Promise<number> {
  if (!jobName || !owner) return 0
  const res = await prisma.systemJobLock.deleteMany({ where: { jobName, owner } })
  return res.count
}