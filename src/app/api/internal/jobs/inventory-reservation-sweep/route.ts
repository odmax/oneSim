export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { sweepExpiredReservations } from '@/lib/services/orders/inventory-reservation'

export async function POST(req: NextRequest) {
  const enabled = process.env.INVENTORY_RESERVATION_SWEEP_ENABLED === 'true'
  if (!enabled) return NextResponse.json({ error: 'Disabled' }, { status: 403 })

  const secret = process.env.INVENTORY_RESERVATION_JOB_SECRET
  if (secret) {
    const auth = req.headers.get('authorization')
    if (!auth || auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const lock = await prisma.systemJobLock.upsert({
    where: { jobName: 'inventory-reservation-sweep' },
    create: { jobName: 'inventory-reservation-sweep', lockedAt: new Date(), lockedUntil: new Date(Date.now() + 600000), owner: `sweep-${process.pid}` },
    update: { lockedAt: new Date(), lockedUntil: new Date(Date.now() + 600000), owner: `sweep-${process.pid}` },
  }).catch(() => null)
  if (!lock) return NextResponse.json({ error: 'Lock failed' }, { status: 409 })

  const result = await sweepExpiredReservations()
  return NextResponse.json(result)
}
