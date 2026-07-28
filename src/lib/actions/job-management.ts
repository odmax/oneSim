'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { revalidatePath } from 'next/cache'
import { enqueueJob, startJob, completeJob, failJob, cancelJob, updateJobProgress, getJobs, getJobStats } from '@/lib/jobs/job-queue'
import { executeProviderSync, executeCatalogPipelineJob } from '@/lib/jobs/provider-sync-runner'
import { claimJob, processJob } from '@/lib/jobs/worker'
import { createScheduledJobs, getSchedules, updateSchedule } from '@/lib/jobs/scheduler'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')
  return session.user.id
}

export async function triggerProviderSyncJob(providerId: string): Promise<{ success: boolean; jobId?: string; error?: string }> {
  const userId = await requireAdmin()
  try {
    const { id } = await enqueueJob('PROVIDER_SYNC', { providerId }, providerId, 'MANUAL')
    await startJob(id)
    updateJobProgress(id, 10)

    const result = await executeProviderSync(providerId, userId)
    await completeJob(id, result)
    revalidatePath('/admin/jobs')
    return { success: true, jobId: id }
  } catch (e: any) {
    return { success: false, error: e.message || 'Sync job failed' }
  }
}

export async function triggerCatalogPipelineJob(providerId?: string): Promise<{ success: boolean; jobId?: string; error?: string }> {
  const userId = await requireAdmin()
  try {
    const { id } = await enqueueJob('CATALOG_PIPELINE', { providerId }, providerId, 'MANUAL')
    await startJob(id)
    updateJobProgress(id, 10)

    const result = await executeCatalogPipelineJob(providerId, userId)

    // Simulate progress through pipeline stages
    updateJobProgress(id, 30, { stage: 'automation' })
    await new Promise(r => setTimeout(r, 100))
    updateJobProgress(id, 60, { stage: 'pipeline' })
    await new Promise(r => setTimeout(r, 100))
    updateJobProgress(id, 90, { stage: 'review' })

    await completeJob(id, result)
    revalidatePath('/admin/jobs')
    return { success: true, jobId: id }
  } catch (e: any) {
    return { success: false, error: e.message || 'Pipeline job failed' }
  }
}

export async function cancelJobAction(jobId: string): Promise<{ success: boolean; error?: string }> {
  await requireAdmin()
  const ok = await cancelJob(jobId)
  if (!ok) return { success: false, error: 'Job not found or already completed' }
  revalidatePath('/admin/jobs')
  return { success: true }
}

export async function getJobsAction(params: { status?: string; type?: string }): Promise<any[]> {
  await requireAdmin()
  return getJobs(params)
}

export async function getJobStatsAction() {
  await requireAdmin()
  return getJobStats()
}

export async function runWorkerAction(): Promise<{ claimed: boolean; jobId?: string }> {
  await requireAdmin()
  const job = await claimJob()
  if (!job) return { claimed: false }
  await processJob(job)
  revalidatePath('/admin/jobs')
  return { claimed: true, jobId: job.id }
}

export async function retryJobAction(jobId: string): Promise<{ success: boolean }> {
  await requireAdmin()
  await enqueueJob('PROVIDER_SYNC' as any, {}, undefined, 'MANUAL')
  const { updateJobProgress } = await import('@/lib/jobs/job-queue')
  await updateJobProgress(jobId, 0)
  revalidatePath('/admin/jobs')
  return { success: true }
}

export async function createScheduledJobsAction(): Promise<{ created: number }> {
  await requireAdmin()
  const result = await createScheduledJobs()
  revalidatePath('/admin/jobs')
  return result
}

export async function getSchedulesAction() {
  await requireAdmin()
  return getSchedules()
}

export async function updateScheduleAction(
  providerId: string,
  data: { enabled?: boolean; frequency?: string },
) {
  await requireAdmin()
  const result = await updateSchedule(providerId, data as any)
  revalidatePath('/admin/jobs')
  return result
}

export async function requestCancellationAction(jobId: string): Promise<{ success: boolean }> {
  await requireAdmin()
  const { prisma } = await import('@/lib/prisma')
  await (prisma as any).backgroundJob.update({
    where: { id: jobId },
    data: { cancellationRequested: true },
  })
  revalidatePath('/admin/jobs')
  return { success: true }
}
