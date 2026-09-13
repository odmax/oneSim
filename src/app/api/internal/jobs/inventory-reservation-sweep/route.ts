export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { sweepExpiredReservations } from '@/lib/services/orders/inventory-reservation'
import { acquireSystemJobLease } from '@/lib/services/jobs/system-job-lock'

export async function POST(req: NextRequest) {
  const enabled = process.env.INVENTORY_RESERVATION_SWEEP_ENABLED === 'true'
  if (!enabled) return NextResponse.json({ error: 'Disabled' }, { status: 403 })

  const secret = process.env.INVENTORY_RESERVATION_JOB_SECRET
  if (!secret) {
    // Fail closed: enabled endpoint with no configured secret must never be callable.
    return NextResponse.json({ error: 'INVENTORY_RESERVATION_JOB_SECRET is not configured — sweep locked' }, { status: 500 })
  }
  const auth = req.headers.get('authorization')
  if (!auth || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const lock = await acquireSystemJobLease({ jobName: 'inventory-reservation-sweep', owner: `sweep-${process.pid}-${Date.now()}`, ttlMs: 600000 })
  if (!lock) return NextResponse.json({ error: 'Lock held by another process' }, { status: 409 })

  const result = await sweepExpiredReservations()
  return NextResponse.json(result)
}
