import { prisma } from '@/lib/prisma'
import type { JobType, JobStatus } from '@prisma/client'

export type { JobType, JobStatus }

export async function enqueueJob(
  type: JobType,
  payload: Record<string, any>,
  runAt?: Date,
  maxAttempts = 5,
) {
  const job = await prisma.backgroundJob.create({
    data: {
      type,
      payload: payload as any,
      runAt: runAt || new Date(),
      maxAttempts,
      // Populate the indexed provider_id column for provider-execution jobs so
      // provider-local lane admission can count in-flight work per provider
      // without parsing JSON payloads.
      ...(type === 'PROVIDER_OPERATION' && typeof payload?.providerId === 'string'
        ? { providerId: payload.providerId }
        : {}),
    },
  })
  return job
}

export async function processDueJobs(
  limitOrOpts: number | { limit?: number; types?: JobType[]; laneGate?: (job: { id: string; type: string; payload: any; providerId?: string | null }) => Promise<boolean> } = 10,
) {
  const opts = typeof limitOrOpts === 'number' ? { limit: limitOrOpts } : limitOrOpts
  // Recover jobs stranded in PROCESSING by a worker crash (process killed — no
  // catch/finally ran). The lease threshold must exceed the longest possible
  // handler execution (activation HTTP timeouts are ≤60s) so a live worker is
  // never mistaken for a dead one. Requeued jobs re-execute safely: purchase
  // dispatch is guarded by the order-level exactly-once claim in runDispatch.
  await requeueStaleProcessingJobs()

  const jobs = await prisma.backgroundJob.findMany({
    where: {
      status: 'PENDING',
      runAt: { lte: new Date() },
      ...(opts.types && opts.types.length > 0 ? { type: { in: opts.types } } : {}),
    },
    orderBy: { runAt: 'asc' },
    take: opts.limit ?? 10,
  })

  const results: Array<{ id: string; type: string; status: JobStatus; error?: string }> = []

  for (const job of jobs) {
    try {
      // Lane-gated admission (provider-local concurrency) replaces the plain
      // atomic claim when provided. The gate performs the PENDING → PROCESSING
      // claim itself (atomically, distributed-safe) and returns false to leave
      // the job PENDING and schedulable when the provider lane is full.
      if (opts.laneGate) {
        const admitted = await opts.laneGate(job)
        if (!admitted) continue
      } else {
        // Atomically claim the job (PENDING → PROCESSING). If another worker already
        // claimed it, count===0 and we skip — preventing double execution.
        const claimed = await markProcessing(job.id)
        if (!claimed) continue
      }
      const result = await executeJob(job)
      if (result.completed) {
        await markCompleted(job.id)
        results.push({ id: job.id, type: job.type, status: 'COMPLETED' })
      } else {
        const err = (result as any).error || 'Unknown error'
        await markFailedWithRetry(job.id, err)
        results.push({ id: job.id, type: job.type, status: 'FAILED', error: err })
      }
    } catch (error: any) {
      await markFailedWithRetry(job.id, error.message || 'Unknown error')
      results.push({ id: job.id, type: job.type, status: 'FAILED', error: error.message })
    }
  }

  return results
}

async function markProcessing(jobId: string): Promise<boolean> {
  const result = await prisma.backgroundJob.updateMany({
    where: { id: jobId, status: 'PENDING' },
    data: claimJobData(),
  })
  return result.count === 1
}

/** The exact mutable claim payload shared by the plain claim and provider-lane
 *  admissions (keeps the PENDING→PROCESSING transition identical everywhere). */
export function claimJobData(): { status: 'PROCESSING'; attempts: { increment: number }; lockedAt: Date } {
  return { status: 'PROCESSING', attempts: { increment: 1 }, lockedAt: new Date() }
}

/** Atomic PENDING → PROCESSING claim. Returns false if already claimed. */
export async function claimJob(jobId: string): Promise<boolean> {
  return markProcessing(jobId)
}

/** A job may not legitimately run longer than this; beyond it the worker is dead. */
const STALE_PROCESSING_MS = 15 * 60 * 1000

async function requeueStaleProcessingJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS)
  const result = await prisma.backgroundJob.updateMany({
    where: { status: 'PROCESSING', lockedAt: { lt: cutoff } },
    data: { status: 'PENDING', lockedAt: null, lastError: 'Requeued: worker lease expired (stale PROCESSING)' },
  })
  return result.count
}

async function markCompleted(jobId: string) {
  const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } })
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: { status: 'COMPLETED' as any },
  })
  // Reschedule recurring jobs
  if (job && ['ESIM_STATUS_SYNC', 'ESIM_USAGE_SYNC', 'INSTALLATION_RECONCILIATION', 'TOPUP_RECONCILIATION', 'PROVIDER_SELF_HEAL'].includes(job.type)) {
    const { rescheduleAfterCompletion } = await import('./recurring-jobs')
    await rescheduleAfterCompletion(job.type)
  }
}

async function markFailedWithRetry(jobId: string, error: string) {
  const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } })
  if (!job) return

  if (job.attempts >= job.maxAttempts) {
    // Exhaustion safety: never let a paid activation poll be silently stranded
    // forever. Move unresolvable activation jobs into reconciliation (wallet
    // held, provider reference preserved) instead of leaving the order at
    // PENDING_PROVIDER.
    if (job.type === 'PROVIDER_OPERATION') {
      const { reconcileExhaustedActivationJob } = await import('./handlers/provider-operation')
      await reconcileExhaustedActivationJob(job.payload)
    }
    await prisma.backgroundJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', lastError: error },
    })
    return
  }

  const backoffDelay = Math.min(
    Math.pow(2, job.attempts) * 30 * 1000, // 30s, 1m, 2m, 4m, 8m
    30 * 60 * 1000, // cap at 30 minutes
  )

  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: {
      status: 'PENDING',
      lastError: error,
      runAt: new Date(Date.now() + backoffDelay),
    },
  })
}

async function executeProviderOperation(payload: any) {
  try {
    const { executeProviderOperation } = await import('./handlers/provider-operation')
    return executeProviderOperation(payload)
  } catch (error: any) {
    return { completed: false, error: error.message || 'Provider operation handler failed' }
  }
}

async function executeJob(job: { id: string; type: string; payload: any }) {
  switch (job.type) {
    case 'ACTIVATION_SYNC':
      return executeActivationSync(job.payload)
    case 'USAGE_SYNC':
      return executeUsageSync(job.payload)
    case 'EMAIL_DELIVERY':
      return { completed: true }
    case 'PROVIDER_OPERATION':
      return executeProviderOperation(job.payload)
    case 'INSTALLATION_RECONCILIATION':
      return (await import('./handlers/installation-reconciliation')).executeInstallationReconciliation()
    case 'TOPUP_RECONCILIATION':
      return (await import('./handlers/top-up-reconciliation')).executeTopUpReconciliation()
    case 'PROVIDER_SELF_HEAL':
      return (await import('./handlers/provider-self-heal')).executeProviderSelfHeal()
    case 'ESIM_STATUS_SYNC':
      return (await import('./handlers/esim-sync-batch')).executeStatusSynchronization().then(r => ({ completed: true, result: r }))
    case 'ESIM_USAGE_SYNC':
      return (await import('./handlers/esim-sync-batch')).executeUsageSynchronization().then(r => ({ completed: true, result: r }))
    default:
      return { completed: false, error: `Unknown job type: ${job.type}` }
  }
}

async function executeActivationSync(payload: any) {
  const { purchaseId } = payload
  if (!purchaseId) return { completed: false, error: 'Missing purchaseId' }

  try {
    const { syncActivationStatus } = await import('./handlers/activation-sync')
    const result = await syncActivationStatus(purchaseId)
    return result
  } catch (error: any) {
    return { completed: false, error: error.message || 'Activation sync failed' }
  }
}

async function executeUsageSync(payload: any) {
  const { businessId, esimId } = payload

  try {
    const { syncUsage } = await import('./handlers/usage-sync')
    const result = await syncUsage(businessId, esimId)
    return result
  } catch (error: any) {
    return { completed: false, error: error.message || 'Usage sync failed' }
  }
}
