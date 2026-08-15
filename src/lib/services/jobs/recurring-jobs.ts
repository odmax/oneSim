import { prisma } from '@/lib/prisma'

export const RECURRING_JOBS = [
  { type: 'ESIM_STATUS_SYNC', intervalMs: 60_000, description: 'Auto-sync eSIM statuses' },
  { type: 'ESIM_USAGE_SYNC', intervalMs: 60_000, description: 'Auto-sync eSIM usage data' },
  { type: 'INSTALLATION_RECONCILIATION', intervalMs: 60_000, description: 'QR/installation data reconciliation' },
  { type: 'TOPUP_RECONCILIATION', intervalMs: 60_000, description: 'PENDING_REVIEW top-up outcome reconciliation' },
  { type: 'PROVIDER_SELF_HEAL', intervalMs: 300_000, description: 'Provider health evaluation + safe recovery' },
]

/**
 * Canonical clock rule for raw SQL that touches Prisma `DateTime` columns.
 *
 * These columns are physically `timestamp without time zone`. PostgreSQL `NOW()`
 * returns the server-local wall clock, but Prisma reads such columns back as
 * UTC, so a locally-written value appears offset by the server timezone (e.g.
 * +2h under Africa/Johannesburg → recurring jobs look ~2h in the future and
 * never run). Every raw SQL clock expression against a Prisma timestamp column
 * must therefore use UTC wall-clock time (`NOW() AT TIME ZONE 'UTC'`).
 *
 * JS `new Date()` values are already serialized by Prisma as UTC wall-clock and
 * need no conversion.
 */
const UTC_NOW = `NOW() AT TIME ZONE 'UTC'`

/**
 * Seed recurring background jobs. Idempotent — creates one job per type.
 * Call on startup. `background_jobs` has no unique index on `type`, so the
 * guard is a NOT EXISTS check rather than ON CONFLICT (which would never
 * conflict and would duplicate rows on every cron tick).
 *
 * runAt/createdAt/updatedAt are written with UTC wall-clock semantics so Prisma
 * reads them as due immediately. Also repairs rows seeded by the old local-time
 * convention (see repairRecurringSeedTimestamps).
 */
export async function seedRecurringJobs(): Promise<void> {
  for (const job of RECURRING_JOBS) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO background_jobs ("id", "type", "payload", "status", "attempts", "maxAttempts", "runAt", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), $1::"JobType", '{}'::jsonb, 'PENDING', 0, 999, ${UTC_NOW}, ${UTC_NOW}, ${UTC_NOW}
      WHERE NOT EXISTS (SELECT 1 FROM background_jobs WHERE "type" = $1::"JobType")
    `, job.type as any).catch(() => {})

    await repairRecurringSeedTimestamps(job.type)
  }
}

/**
 * Repair recurring seed rows written under the old `NOW()` (server-local wall
 * clock) convention. Such rows hold runAt/createdAt/updatedAt as the SAME local
 * timestamp, so Prisma reads a future-dated `runAt` and never runs them.
 *
 * The predicate is deliberately narrow and safe:
 *  - a known recurring type (passed per loop iteration)
 *  - maxAttempts = 999 (only seedRecurringJobs uses this; business jobs use 5)
 *  - still PENDING
 *  - never processed: runAt = createdAt = updatedAt (rescheduling always breaks
 *    this equality, so a rescheduled row can never be matched)
 *
 * Idempotent: after repair runAt no longer equals createdAt, so the row is not
 * matched again. Only runAt is touched — payloads, attempts, and status are
 * preserved, and no row is duplicated.
 */
async function repairRecurringSeedTimestamps(type: string): Promise<void> {
  await prisma.$executeRawUnsafe(`
    UPDATE background_jobs
    SET "runAt" = ${UTC_NOW}
    WHERE "type" = $1::"JobType"
      AND "maxAttempts" = 999
      AND "status" = 'PENDING'
      AND "runAt" = "createdAt"
      AND "createdAt" = "updatedAt"
  `, type as any).catch(() => {})
}

/**
 * Claim an eSIM for sync with atomic update. Returns true if claimed.
 * Uses lastAttemptedAt lease with 5-minute expiry for crash recovery.
 * The due check compares the UTC-written statusNextSyncAt/usageNextSyncAt value
 * against UTC wall-clock (`NOW() AT TIME ZONE 'UTC'`); the lease parameter is a
 * JS Date already serialized as UTC wall-clock.
 */
export async function claimEsimForSync(esimId: string, field: 'statusNextSyncAt' | 'usageNextSyncAt'): Promise<boolean> {
  const now = new Date()
  const leaseExpiry = new Date(now.getTime() - 5 * 60 * 1000) // 5 min lease

  const result = await prisma.$executeRawUnsafe(`
    UPDATE esims
    SET "${field}" = $1
    WHERE id = $2
      AND ("${field}" IS NOT NULL AND "${field}" <= ${UTC_NOW})
      AND ("lastStatusSyncAt" IS NULL OR "lastStatusSyncAt" < $3)
  `, new Date(now.getTime() + 24 * 3600 * 1000), esimId, leaseExpiry)

  return result > 0
}

/**
 * Mark a recurring job as due again by updating its runAt.
 */
export async function rescheduleRecurringJob(type: string, intervalMs: number): Promise<void> {
  await prisma.backgroundJob.updateMany({
    where: { type: type as any, status: 'COMPLETED' as any },
    data: { status: 'PENDING' as any, runAt: new Date(Date.now() + intervalMs), attempts: 0 },
  })
}

export async function rescheduleAfterCompletion(type: string) {
  const job = RECURRING_JOBS.find(j => j.type === type)
  if (job) await rescheduleRecurringJob(type, job.intervalMs)
}
