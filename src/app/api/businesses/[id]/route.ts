import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { stripPackageProviderFields, stripPurchaseProviderFields } from '@/lib/analytics/safe-fields'

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
  } else if (session.user.role !== 'INTERNAL_ADMIN') {
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
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.user.role !== 'INTERNAL_ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const data = await request.json()

  const business = await prisma.business.update({
    where: { id: params.id },
    data,
  })

  return NextResponse.json(business)
}
