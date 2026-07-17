import { prisma } from '@/lib/prisma'

const LOCK_TIMEOUT_MS = 30000

export async function acquireGroupLock(comparableKey: string, workerId: string): Promise<boolean> {
  const lockKey = `catalog-lock:${comparableKey}`
  const now = new Date()
  const expiresAt = new Date(now.getTime() + LOCK_TIMEOUT_MS)

  try {
    await prisma.maintenanceJob.create({
      data: {
        jobKey: lockKey,
        status: 'LOCKED',
        startedAt: now,
        metadata: { workerId, comparableKey, expiresAt: expiresAt.toISOString() },
      },
    })
    return true
  } catch (err: any) {
    if (err.code === 'P2002') {
      const existing = await prisma.maintenanceJob.findUnique({ where: { jobKey: lockKey } })
      if (!existing) return false
      const expStr = (existing.metadata as any)?.expiresAt
      const expired = expStr ? new Date(expStr) < now : false
      if (existing.status === 'LOCKED' && !expired) return false
      await prisma.maintenanceJob.update({
        where: { jobKey: lockKey },
        data: {
          status: 'LOCKED',
          startedAt: now,
          metadata: { workerId, comparableKey, expiresAt: expiresAt.toISOString() },
        },
      })
      return true
    }
    return false
  }
}

export async function releaseGroupLock(comparableKey: string): Promise<void> {
  const lockKey = `catalog-lock:${comparableKey}`
  await prisma.maintenanceJob.upsert({
    where: { jobKey: lockKey },
    update: { status: 'UNLOCKED', finishedAt: new Date() },
    create: { jobKey: lockKey, status: 'UNLOCKED', startedAt: new Date(), finishedAt: new Date() },
  })
}

export async function extendGroupLock(comparableKey: string, workerId: string): Promise<boolean> {
  const lockKey = `catalog-lock:${comparableKey}`
  const now = new Date()
  const expiresAt = new Date(now.getTime() + LOCK_TIMEOUT_MS)
  try {
    await prisma.maintenanceJob.update({
      where: { jobKey: lockKey, status: 'LOCKED' },
      data: { metadata: { workerId, comparableKey, expiresAt: expiresAt.toISOString() } },
    })
    return true
  } catch {
    return false
  }
}
