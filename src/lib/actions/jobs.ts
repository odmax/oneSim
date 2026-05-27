'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { processDueJobs } from '@/lib/services/jobs/queue'

export async function runDueJobs() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const results = await processDueJobs(20)

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'JOBS_PROCESSED',
      entity: 'BackgroundJob',
      details: `Processed ${results.length} due jobs: ${results.filter(r => r.status === 'COMPLETED').length} completed, ${results.filter(r => r.status === 'FAILED').length} failed`,
    },
  })

  revalidatePath('/admin/jobs')
  return results
}

export async function getJobs(page = 1, pageSize = 50) {
  const skip = (page - 1) * pageSize
  const [jobs, total] = await Promise.all([
    prisma.backgroundJob.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.backgroundJob.count(),
  ])
  return { jobs, total, page, pageSize }
}

export async function getJobsSummary() {
  const [pending, processing, completed, failed] = await Promise.all([
    prisma.backgroundJob.count({ where: { status: 'PENDING', runAt: { lte: new Date() } } }),
    prisma.backgroundJob.count({ where: { status: 'PROCESSING' } }),
    prisma.backgroundJob.count({ where: { status: 'COMPLETED' } }),
    prisma.backgroundJob.count({ where: { status: 'FAILED' } }),
  ])
  return { pending, processing, completed, failed }
}
