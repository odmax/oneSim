export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createPackageSchema } from '@/lib/validations/package'
import { stripPackageProviderFields } from '@/lib/analytics/safe-fields'
import { adminApiAccess } from '@/lib/auth/admin-api-gate'
import { Permissions } from '@/lib/auth/permissions'

const packagePublicSelect = {
  id: true, name: true, displayName: true, dataGB: true,
  validityDays: true, priceUSD: true, isActive: true,
  source: true, description: true, customerDescription: true,
  sku: true, packageCode: true,
  createdAt: true, updatedAt: true,
} as const

export async function GET() {
  const { allowed, denied } = await adminApiAccess(Permissions.VIEW_PACKAGES)
  if (!allowed) return denied

  const packages = await prisma.eSIMPackage.findMany({
    where: { source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    select: packagePublicSelect,
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json(packages)
}

export async function POST(request: NextRequest) {
  const { allowed, denied } = await adminApiAccess(Permissions.MANAGE_PACKAGES)
  if (!allowed) return denied

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
