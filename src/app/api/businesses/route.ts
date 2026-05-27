import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { BusinessStatus } from '@prisma/client'

function requireAdmin(session: any): NextResponse | null {
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.user.role !== 'INTERNAL_ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return null
}

export async function GET() {
  const session = await getServerSession(authOptions)
  const authError = requireAdmin(session)
  if (authError) return authError

  const businesses = await prisma.business.findMany({
    include: {
      users: {
        include: { user: true },
      },
      _count: {
        select: { purchases: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json(businesses)
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions)
  const authError = requireAdmin(session)
  if (authError) return authError

  try {
    const body = await request.json()
    const { name, regNumber, taxId, contactEmail, contactPhone, address, country } = body

    const business = await prisma.business.create({
      data: {
        name,
        regNumber,
        taxId,
        contactEmail,
        contactPhone,
        address,
        country,
        status: BusinessStatus.PENDING,
      },
    })

    return NextResponse.json(business, { status: 201 })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to create business' },
      { status: 400 }
    )
  }
}
