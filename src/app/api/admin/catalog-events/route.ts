import { NextRequest, NextResponse } from 'next/server'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { allowed, denied } = await adminApiAccess(Permissions.VIEW_AUDIT_LOGS)
  if (!allowed) return denied

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const limit = parseInt(searchParams.get('limit') || '50')
  const offset = parseInt(searchParams.get('offset') || '0')

  const where: any = {}
  if (status && ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'].includes(status)) {
    where.status = status
  }

  const [events, total] = await Promise.all([
    prisma.catalogEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      skip: offset,
    }),
    prisma.catalogEvent.count({ where }),
  ])

  return NextResponse.json({ events, total })
}
