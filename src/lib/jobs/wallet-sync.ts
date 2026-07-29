/**
 * Airhub Wallet Scheduled Sync — Phase 5C
 * =========================================
 *
 * Runs every 15 minutes for enabled Airhub providers.
 * Prevents overlapping syncs via idempotency keys.
 */

import { prisma } from '@/lib/prisma'
import { fetchAirhubWallet } from '@/lib/actions/airhub-wallet'

export async function syncAllAirhubWallets(): Promise<{ synced: number; failed: number; skipped: number }> {
  const now = new Date()
  const windowKey = `wallet-sync-${now.toISOString().slice(0, 16)}` // minute-level key

  // Idempotency: skip if already run in this minute window
  const existing = await prisma.backgroundJob.findUnique({ where: { idempotencyKey: windowKey } }).catch(() => null)
  if (existing) return { synced: 0, failed: 0, skipped: 0 }

  await prisma.backgroundJob.create({
    data: {
      type: 'PROVIDER_SYNC',
      status: 'PROCESSING',
      payload: { task: 'wallet-sync' },
      idempotencyKey: windowKey,
      triggerSource: 'SCHEDULED',
      maxAttempts: 1,
      startedAt: now,
      progress: 0,
    },
  }).catch(() => {})

  const providers = await prisma.provider.findMany({
    where: { code: 'AIRHUB', status: { in: ['ACTIVE', 'TESTING'] } },
    select: { id: true, name: true, config: true },
  })

  const configured = providers.filter(p => !!(p.config as any)?.partnerCode)

  if (configured.length === 0) {
    await prisma.backgroundJob.update({
      where: { idempotencyKey: windowKey },
      data: { status: 'COMPLETED', finishedAt: now, progress: 100, resultsData: { synced: 0, reason: 'No configured Airhub providers' } },
    }).catch(() => {})
    return { synced: 0, failed: 0, skipped: 0 }
  }

  let synced = 0, failed = 0
  const total = configured.length

  for (let i = 0; i < configured.length; i++) {
    const p = configured[i]
    await prisma.backgroundJob.update({
      where: { idempotencyKey: windowKey },
      data: { progress: Math.round(((i + 1) / total) * 90) },
    }).catch(() => {})

    try {
      const result = await fetchAirhubWallet(p.id, 'SCHEDULED')
      if (result.success) synced++ 
      else failed++
    } catch {
      failed++
    }
  }

  await prisma.backgroundJob.update({
    where: { idempotencyKey: windowKey },
    data: { status: 'COMPLETED', finishedAt: new Date(), progress: 100, resultsData: { synced, failed, total } },
  }).catch(() => {})

  return { synced, failed, skipped: 0 }
}
