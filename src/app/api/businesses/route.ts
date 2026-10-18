export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { BusinessStatus } from '@prisma/client'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'

export async function GET() {
  const { allowed, denied } = await adminApiAccess(Permissions.VIEW_BUSINESSES)
  if (!allowed) return denied

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
  const { allowed, denied } = await adminApiAccess(Permissions.MANAGE_BUSINESSES)
  if (!allowed) return denied

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
