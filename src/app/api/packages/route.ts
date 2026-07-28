export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { createPackageSchema } from '@/lib/validations/package'
import { stripPackageProviderFields } from '@/lib/analytics/safe-fields'

const packagePublicSelect = {
  id: true, name: true, displayName: true, dataGB: true,
  validityDays: true, priceUSD: true, isActive: true,
  source: true, description: true, customerDescription: true,
  sku: true, packageCode: true,
  createdAt: true, updatedAt: true,
} as const

function requireAdmin(session: any): NextResponse | null {
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.user.role !== 'INTERNAL_ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return null
}

export async function GET() {
  const session = await getServerSession(authOptions)
  const authError = requireAdmin(session)
  if (authError) return authError

  const packages = await prisma.eSIMPackage.findMany({
    where: { source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    select: packagePublicSelect,
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json(packages)
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions)
  const authError = requireAdmin(session)
  if (authError) return authError

  try {
    const body = await request.json()
    const validated = createPackageSchema.parse(body)
    const { providerId, ...rest } = validated

    const pkg = await prisma.eSIMPackage.create({
      data: {
        ...rest,
        ...(providerId ? { providerId, providerName: providerId } : {}),
      },
    })

    return NextResponse.json(stripPackageProviderFields(pkg), { status: 201 })
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid request data' },
      { status: 400 }
    )
  }
}
