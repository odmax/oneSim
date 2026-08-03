export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recoverOrder } from '@/lib/services/orders/recovery'

async function acquireRecoveryLock(): Promise<boolean> {
  try {
    const now = new Date()
    const lockUntil = new Date(now.getTime() + 15 * 60 * 1000)
    const owner = `order-recovery-${process.pid}-${Date.now()}`
    await prisma.systemJobLock.upsert({
      where: { jobName: 'order-recovery' },
      create: { jobName: 'order-recovery', lockedAt: now, lockedUntil: lockUntil, owner },
      update: { lockedAt: now, lockedUntil: lockUntil, owner },
    })
    return true
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const enabled = process.env.ORDER_RECOVERY_ENABLED === 'true'
  if (!enabled) return NextResponse.json({ error: 'Order recovery is disabled' }, { status: 403 })

  const secret = process.env.ORDER_RECOVERY_JOB_SECRET
  if (secret) {
    const auth = req.headers.get('authorization')
    if (!auth || auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  if (!(await acquireRecoveryLock())) {
    return NextResponse.json({ message: 'Lock acquisition failed — another job may be running' }, { status: 409 })
  }

  const STALE_MINUTES = parseInt(process.env.ORDER_RECOVERY_STALE_MINUTES || '10', 10)
  const BATCH_SIZE = parseInt(process.env.ORDER_RECOVERY_BATCH_SIZE || '50', 10)
  const MAX_ATTEMPTS = parseInt(process.env.ORDER_RECOVERY_MAX_ATTEMPTS || '5', 10)
  const staleThreshold = new Date(Date.now() - STALE_MINUTES * 60 * 1000)

  // Find orders that are stuck or have expired nextRetryAt
  const stuckOrders = await prisma.eSIMPurchase.findMany({
    where: {
      status: { notIn: ['FULFILLED', 'REFUNDED', 'CANCELLED', 'EXPIRED'] },
      OR: [
        { nextRetryAt: { lte: new Date() } },
        {
          status: { in: ['PENDING_PROVIDER', 'PROVIDER_ACCEPTED', 'RESERVED', 'FULFILLING', 'CREATED', 'PAYMENT_RESERVED', 'FAILED', 'PROVIDER_RECONCILIATION'] },
          updatedAt: { lt: staleThreshold },
          nextRetryAt: null,
        },
      ],
      retryCount: { lt: MAX_ATTEMPTS + 1 },
    },
    take: BATCH_SIZE,
    orderBy: { updatedAt: 'asc' },
    select: { id: true, status: true, retryCount: true },
  })

  let resumed = 0, polled = 0, redispatched = 0, reconciliationRequired = 0, skipped = 0, failed = 0, alreadyComplete = 0

  for (const order of stuckOrders) {
    try {
      const result = await recoverOrder(order.id)
      switch (result.action) {
        case 'RESUME_LOCAL_FINALIZATION': result.success ? resumed++ : failed++; break
        case 'POLL_PROVIDER': result.success ? polled++ : skipped++; break
        case 'REDISPATCH_PROVIDER': result.success ? redispatched++ : failed++; break
        case 'RECONCILIATION_REQUIRED': reconciliationRequired++; break
        case 'NOT_RETRYABLE': skipped++; break
        case 'ALREADY_COMPLETE': alreadyComplete++; break
      }
    } catch {
      failed++
    }
  }

  return NextResponse.json({
    scanned: stuckOrders.length,
    resumed, polled, redispatched, reconciliationRequired, skipped, failed, alreadyComplete,
  })
}
