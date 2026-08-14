export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'

/**
 * Admin visibility for top-ups requiring review (ESIMTopUp.PENDING_REVIEW).
 * Exposes only safe operational fields — never the raw provider payload or
 * credentials, and never a blind top-up re-dispatch action.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const escalatedOnly = url.searchParams.get('escalated') === '1'
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
  const PAGE_SIZE = 50

  const where: any = { status: 'PENDING_REVIEW' }
  if (escalatedOnly) where.reconciliationEscalatedAt = { not: null }
  else where.reconciliationEscalatedAt = null

  const [rows, total] = await Promise.all([
    prisma.eSIMTopUp.findMany({
      where,
      include: {
        business: { select: { id: true, name: true } },
        esim: { select: { id: true, iccid: true } },
      },
      orderBy: escalatedOnly
        ? [{ reconciliationEscalatedAt: 'desc' }]
        : [{ reconciliationAttempts: 'asc' }, { createdAt: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.eSIMTopUp.count({ where }),
  ])

  const now = Date.now()

  return NextResponse.json({
    total,
    page,
    pageSize: PAGE_SIZE,
    escalatedOnly,
    topUps: rows.map(r => ({
      topUpId: r.id,
      business: { id: r.business?.id, name: r.business?.name },
      esim: { id: r.esim?.id, iccid: r.esim?.iccid },
      amount: Number(r.amount),
      currency: r.currency,
      status: r.status,
      ageMs: now - r.createdAt.getTime(),
      ageMinutes: Math.floor((now - r.createdAt.getTime()) / 60000),
      reconciliationAttempts: r.reconciliationAttempts,
      nextReconcileAt: r.nextReconcileAt?.toISOString() || null,
      lastReconcileAt: r.lastReconcileAt?.toISOString() || null,
      lastErrorCode: r.lastReconcileErrorCode,
      escalated: !!r.reconciliationEscalatedAt,
      escalatedAt: r.reconciliationEscalatedAt?.toISOString() || null,
      locked: !!r.reconcileLockedAt,
    })),
  })
}
