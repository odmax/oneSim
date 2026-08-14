import { prisma } from '@/lib/prisma'

const RECURRING_JOBS = [
  { type: 'ESIM_STATUS_SYNC', intervalMs: 60_000, description: 'Auto-sync eSIM statuses' },
  { type: 'ESIM_USAGE_SYNC', intervalMs: 60_000, description: 'Auto-sync eSIM usage data' },
  { type: 'INSTALLATION_RECONCILIATION', intervalMs: 60_000, description: 'QR/installation data reconciliation' },
  { type: 'TOPUP_RECONCILIATION', intervalMs: 60_000, description: 'PENDING_REVIEW top-up outcome reconciliation' },
  { type: 'PROVIDER_SELF_HEAL', intervalMs: 300_000, description: 'Provider health evaluation + safe recovery' },
]

/**
 * Seed recurring background jobs. Idempotent — creates one job per type.
 * Call on startup. `background_jobs` has no unique index on `type`, so the
 * guard is a NOT EXISTS check rather than ON CONFLICT (which would never
 * conflict and would duplicate rows on every cron tick).
 */
export async function seedRecurringJobs(): Promise<void> {
  for (const job of RECURRING_JOBS) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO background_jobs ("id", "type", "payload", "status", "attempts", "maxAttempts", "runAt", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), $1::"JobType", '{}'::jsonb, 'PENDING', 0, 999, NOW(), NOW(), NOW()
      WHERE NOT EXISTS (SELECT 1 FROM background_jobs WHERE "type" = $1::"JobType")
    `, job.type as any).catch(() => {})
  }
}

/**
 * Claim an eSIM for sync with atomic update. Returns true if claimed.
 * Uses lastAttemptedAt lease with 5-minute expiry for crash recovery.
 */
export async function claimEsimForSync(esimId: string, field: 'statusNextSyncAt' | 'usageNextSyncAt'): Promise<boolean> {
  const now = new Date()
  const leaseExpiry = new Date(now.getTime() - 5 * 60 * 1000) // 5 min lease

  const result = await prisma.$executeRawUnsafe(`
    UPDATE esims
    SET "${field}" = $1
    WHERE id = $2
      AND ("${field}" IS NOT NULL AND "${field}" <= NOW())
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
