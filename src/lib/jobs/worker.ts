/**
 * OneSIM Job Worker — Phase 4B
 * =============================
 *
 * Atomic claim + execute with cooperative cancellation.
 */

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

const WORKER_ID = `worker-${process.pid || 1}-${Math.random().toString(36).slice(2, 8)}`
const STALE_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Atomically claim one eligible PENDING job.
 * Uses updateMany with status=PENDING filter to prevent
 * concurrent workers from claiming the same job.
 */
export async function claimJob(): Promise<any | null> {
  const now = new Date()

  // First: recover stale jobs
  await recoverStaleJobs(now)

  // Claim a PENDING job atomically
  const result = await prisma.backgroundJob.updateMany({
    where: {
      status: 'PENDING',
      runAt: { lte: now },
      OR: [
        { workerId: null },
        { workerId: '' },
      ],
      cancellationRequested: false,
    },
    data: {
      status: 'PROCESSING',
      workerId: WORKER_ID,
      lockedAt: now,
    },
  })

  if (result.count === 0) return null

  // Fetch the claimed job
  const job = await prisma.backgroundJob.findFirst({
    where: { workerId: WORKER_ID, status: 'PROCESSING' },
    orderBy: { lockedAt: 'asc' },
  })

  if (job) {
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { startedAt: now, attempts: { increment: 1 } },
    })
  }

  return job
}

/**
 * Process a claimed job by routing to the correct executor.
 */
export async function processJob(job: any): Promise<void> {
  const { executeProviderSync, executeCatalogPipelineJob } = await import('./provider-sync-runner')

  // Check for cooperative cancellation
  if (await isCancellationRequested(job.id)) {
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    })
    return
  }

  try {
    let result: any

    if (job.type === 'PROVIDER_SYNC') {
      const providerId = (job.payload as any)?.providerId || job.providerId
      result = await executeProviderSync(providerId, 'system')
    } else if (job.type === 'CATALOG_PIPELINE') {
      const providerId = (job.payload as any)?.providerId || job.providerId
      result = await executeCatalogPipelineJob(providerId, 'system')
    } else {
      await failJob(job.id, `Unknown job type: ${job.type}`)
      return
    }

    await completeJob(job.id, result)
  } catch (e: any) {
    await handleJobFailure(job, e)
  }
}

/**
 * Handle job failure with retry logic.
 */
async function handleJobFailure(job: any, error: Error): Promise<void> {
  const classification = classifyError(error)
  const isRetryable = classification === 'RETRYABLE'
  const attempts = (job.attempts || 0) + 1

  if (!isRetryable || attempts >= job.maxAttempts) {
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        lastError: error.message,
        retryClassification: classification,
      },
    })
    return
  }

  // Exponential backoff: 2^attempt * 1000ms, max 5 minutes
  const backoffMs = Math.min(Math.pow(2, attempts) * 1000, 5 * 60 * 1000)

  await prisma.backgroundJob.update({
    where: { id: job.id },
    data: {
      status: 'PENDING',
      attempts,
      lastError: error.message,
      retryClassification: classification,
      nextRetryAt: new Date(Date.now() + backoffMs),
      retryBackoffMs: backoffMs,
      runAt: new Date(Date.now() + backoffMs),
      workerId: null,
      lockedAt: null,
    },
  })
}

function classifyError(error: Error): string {
  const msg = error.message?.toLowerCase() || ''
  if (msg.includes('unauthorized') || msg.includes('authentication') || msg.includes('invalid credential')) return 'NON_RETRYABLE'
  if (msg.includes('disabled') || msg.includes('not found') || msg.includes('missing config')) return 'NON_RETRYABLE'
  if (msg.includes('validation') || msg.includes('invalid')) return 'NON_RETRYABLE'
  return 'RETRYABLE'
}

async function completeJob(jobId: string, resultsData?: any): Promise<void> {
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: { status: 'COMPLETED', finishedAt: new Date(), progress: 100, resultsData },
  })
}

async function failJob(jobId: string, error: string): Promise<void> {
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: { status: 'FAILED', finishedAt: new Date(), lastError: error },
  })
}

async function isCancellationRequested(jobId: string): Promise<boolean> {
  const job = await prisma.backgroundJob.findUnique({ where: { id: jobId }, select: { cancellationRequested: true } })
  return job?.cancellationRequested === true
}

/**
 * Recover jobs stuck in PROCESSING beyond the stale timeout.
 */
async function recoverStaleJobs(now: Date): Promise<void> {
  const staleTime = new Date(now.getTime() - STALE_TIMEOUT_MS)

  const stale = await prisma.backgroundJob.findMany({
    where: {
      status: 'PROCESSING',
      lockedAt: { lte: staleTime },
      cancellationRequested: false,
    },
  })

  for (const job of stale) {
    if (job.attempts < job.maxAttempts) {
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: {
          status: 'PENDING',
          workerId: null,
          lockedAt: null,
          staleReason: `Stuck in PROCESSING for > ${STALE_TIMEOUT_MS / 60000}min — reset to PENDING (attempt ${job.attempts + 1}/${job.maxAttempts})`,
          runAt: now,
        },
      })
    } else {
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          finishedAt: now,
          staleReason: `Stuck in PROCESSING — max attempts (${job.maxAttempts}) exhausted`,
          lastError: 'Job recovery: max attempts exhausted after stale detection',
        },
      })
    }
  }

  if (stale.length > 0) {
    revalidatePath('/admin/jobs')
  }
}

export { WORKER_ID, STALE_TIMEOUT_MS }
