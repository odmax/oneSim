'use server'

import { prisma } from '@/lib/prisma'
import type { JobType, JobStatus } from '@prisma/client'

export async function enqueueJob(
  type: JobType,
  payload: Record<string, unknown>,
  providerId?: string,
  trigger?: string,
  idempotencyKey?: string,
): Promise<{ id: string }> {
  if (idempotencyKey) {
    const existing = await prisma.backgroundJob.findUnique({ where: { idempotencyKey } })
    if (existing) {
      if (existing.status === 'COMPLETED' || existing.status === 'FAILED' || existing.status === 'CANCELLED') {
        // Re-enqueue: reset the job
        await prisma.backgroundJob.update({
          where: { id: existing.id },
          data: { status: 'PENDING', runAt: new Date(), attempts: 0, workerId: null, lockedAt: null },
        })
        return { id: existing.id }
      }
      // Job still active — return existing
      return { id: existing.id }
    }
  }

  const job = await prisma.backgroundJob.create({
    data: {
      type,
      status: 'PENDING',
      payload: payload as any,
      providerId: providerId || null,
      triggerSource: trigger || 'MANUAL',
      maxAttempts: 3,
      idempotencyKey: idempotencyKey || null,
      runAt: new Date(),
    },
  })
  return { id: job.id }
}

export async function startJob(jobId: string): Promise<boolean> {
  try {
    await prisma.backgroundJob.update({
      where: { id: jobId, status: 'PENDING' },
      data: { status: 'PROCESSING', startedAt: new Date(), attempts: { increment: 1 } },
    })
    return true
  } catch { return false }
}

export async function completeJob(jobId: string, resultsData?: Record<string, unknown>): Promise<void> {
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: { status: 'COMPLETED', finishedAt: new Date(), progress: 100, resultsData: resultsData as any || undefined },
  })
}

export async function failJob(jobId: string, error: string): Promise<void> {
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: { status: 'FAILED', finishedAt: new Date(), lastError: error },
  })
}

export async function cancelJob(jobId: string): Promise<boolean> {
  try {
    await prisma.backgroundJob.update({
      where: { id: jobId, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    })
    return true
  } catch { return false }
}

export async function updateJobProgress(jobId: string, progress: number, metricsData?: Record<string, unknown>): Promise<void> {
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: { progress: Math.min(100, Math.max(0, progress)), metricsData: metricsData as any || undefined },
  })
}

export async function getJobs(params: { status?: string; type?: string; limit?: number }): Promise<any[]> {
  const where: any = {}
  if (params.status) where.status = params.status
  if (params.type) where.type = params.type

  return prisma.backgroundJob.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: params.limit || 20,
  })
}

export async function getJobStats(): Promise<{
  running: number; pending: number; failed: number; completed: number;
  avgDurationMs: number | null; successRate: number | null;
}> {
  const [running, pending, failed, completed] = await Promise.all([
    prisma.backgroundJob.count({ where: { status: 'PROCESSING' } }),
    prisma.backgroundJob.count({ where: { status: 'PENDING' } }),
    prisma.backgroundJob.count({ where: { status: 'FAILED' } }),
    prisma.backgroundJob.count({ where: { status: 'COMPLETED' } }),
  ])

  const durations = await prisma.backgroundJob.findMany({
    where: { status: 'COMPLETED', startedAt: { not: null }, finishedAt: { not: null } },
    select: { startedAt: true, finishedAt: true },
    take: 100,
    orderBy: { finishedAt: 'desc' },
  })

  const totalDuration = durations.reduce((sum, j) => {
    if (j.startedAt && j.finishedAt) return sum + (j.finishedAt.getTime() - j.startedAt.getTime())
    return sum
  }, 0)
  const avgDurationMs = durations.length > 0 ? Math.round(totalDuration / durations.length) : null

  const total = running + completed + failed
  const successRate = total > 0 ? Math.round((completed / total) * 100) : null

  return { running, pending, failed, completed, avgDurationMs, successRate }
}
