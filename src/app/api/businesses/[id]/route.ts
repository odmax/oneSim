export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { stripPackageProviderFields, stripPurchaseProviderFields } from '@/lib/analytics/safe-fields'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (session.user.role === 'BUSINESS_USER') {
    if (params.id !== session.user.businessId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  } else if (session.user.role === 'INTERNAL_ADMIN') {
    const { allowed, denied } = await adminApiAccess(Permissions.VIEW_BUSINESSES)
    if (!allowed) return denied
  } else {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const business = await prisma.business.findUnique({
    where: { id: params.id },
    include: {
      users: {
        include: { user: true },
      },
      purchases: {
        include: { package: true },
      },
      transactions: true,
    },
  })

  if (!business) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 })
  }

  const sanitized = {
    ...business,
    purchases: business.purchases.map(p => ({
      ...stripPurchaseProviderFields(p),
      package: stripPackageProviderFields(p.package),
    })),
  }

  return NextResponse.json(sanitized)
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { allowed, denied } = await adminApiAccess(Permissions.MANAGE_BUSINESSES)
  if (!allowed) return denied

  const data = await request.json()

  const business = await prisma.business.update({
    where: { id: params.id },
    data,
  })

  return NextResponse.json(business)
}
