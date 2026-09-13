export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  discoverStrandedOrders,
  enqueueRecoveryForOrder,
  type RecoveryDiscoveryContext,
} from '@/lib/services/orders/order-recovery-dispatcher'
import { acquireSystemJobLease } from '@/lib/services/jobs/system-job-lock'

async function acquireRecoveryLock(): Promise<boolean> {
  // Atomic lease (single conditional INSERT ... ON CONFLICT ... WHERE lockedUntil <= now).
  // A concurrent replica holding an unexpired lease fails cleanly; an expired
  // lease (crash) is immediately re-acquirable.
  return acquireSystemJobLease({ jobName: 'order-recovery', owner: `order-recovery-${process.pid}-${Date.now()}`, ttlMs: 15 * 60 * 1000 })
}

export async function POST(req: NextRequest) {
  const enabled = process.env.ORDER_RECOVERY_ENABLED === 'true'
  if (!enabled) return NextResponse.json({ error: 'Order recovery is disabled' }, { status: 403 })

  const secret = process.env.ORDER_RECOVERY_JOB_SECRET
  if (!secret) {
    // Fail closed: an enabled recovery endpoint with no configured secret must
    // never be callable by unauthenticated traffic.
    return NextResponse.json({ error: 'ORDER_RECOVERY_JOB_SECRET is not configured — recovery endpoint locked' }, { status: 500 })
  }
  const auth = req.headers.get('authorization')
  if (!auth || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!(await acquireRecoveryLock())) {
    return NextResponse.json({ message: 'Lock acquisition failed — another job may be running' }, { status: 409 })
  }

  // Optional single-order enqueue (operator/debugging). Otherwise run the
  // canonical discovery pass. This route ONLY enqueues — execution always
  // happens in the worker queue, sharing the exact discovery and P0 safety
  // semantics of the PROVIDER_SELF_HEAL recurring path.
  let orderId: string | null = null
  try {
    const body = await req.json().catch(() => null)
    orderId = typeof body?.orderId === 'string' ? body.orderId : null
  } catch {
    orderId = null
  }
  if (!orderId) orderId = req.nextUrl.searchParams.get('orderId')

  const context: RecoveryDiscoveryContext = { source: 'MANUAL' }
  if (orderId) {
    const { enqueued, reason } = await enqueueRecoveryForOrder(orderId, context)
    return NextResponse.json({ orderId, enqueued, reason })
  }

  const result = await discoverStrandedOrders(context)
  return NextResponse.json(result)
}
