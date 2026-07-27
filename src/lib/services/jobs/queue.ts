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
    },
  })
  return job
}

export async function processDueJobs(limit = 10) {
  const jobs = await prisma.backgroundJob.findMany({
    where: {
      status: 'PENDING',
      runAt: { lte: new Date() },
    },
    orderBy: { runAt: 'asc' },
    take: limit,
  })

  const results: Array<{ id: string; type: string; status: JobStatus; error?: string }> = []

  for (const job of jobs) {
    try {
      await markProcessing(job.id)
      const result = await executeJob(job)
      if (result.completed) {
        await markCompleted(job.id)
        results.push({ id: job.id, type: job.type, status: 'COMPLETED' })
      } else {
        await markFailedWithRetry(job.id, result.error || 'Unknown error')
        results.push({ id: job.id, type: job.type, status: 'FAILED', error: result.error })
      }
    } catch (error: any) {
      await markFailedWithRetry(job.id, error.message || 'Unknown error')
      results.push({ id: job.id, type: job.type, status: 'FAILED', error: error.message })
    }
  }

  return results
}

async function markProcessing(jobId: string) {
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: { status: 'PROCESSING', attempts: { increment: 1 } },
  })
}

async function markCompleted(jobId: string) {
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: { status: 'COMPLETED' },
  })
}

async function markFailedWithRetry(jobId: string, error: string) {
  const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } })
  if (!job) return

  if (job.attempts >= job.maxAttempts) {
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
