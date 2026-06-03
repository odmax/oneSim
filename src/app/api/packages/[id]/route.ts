import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
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

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  const authError = requireAdmin(session)
  if (authError) return authError

  const pkg = await prisma.eSIMPackage.findUnique({
    where: { id: params.id },
    select: packagePublicSelect,
  })

  if (!pkg) {
    return NextResponse.json({ error: 'Package not found' }, { status: 404 })
  }

  return NextResponse.json(pkg)
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  const authError = requireAdmin(session)
  if (authError) return authError

  const data = await request.json()

  const pkg = await prisma.eSIMPackage.update({
    where: { id: params.id },
    data,
  })

  return NextResponse.json(stripPackageProviderFields(pkg))
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  const authError = requireAdmin(session)
  if (authError) return authError

  const pkg = await prisma.eSIMPackage.findUnique({
    where: { id: params.id },
    include: { _count: { select: { purchases: true, topUpRecords: true } } },
  })
  if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })

  const esimCount = await prisma.eSIM.count({
    where: { purchase: { packageId: params.id } },
  })
  const hasDependents = pkg._count.purchases > 0 || pkg._count.topUpRecords > 0 || esimCount > 0

  if (hasDependents) {
    await prisma.eSIMPackage.update({
      where: { id: params.id },
      data: { isActive: false, hiddenFromCatalog: true, archivedAt: new Date() },
    })
    return NextResponse.json({ success: true, archived: true, message: 'Package has existing purchased eSIMs. Archived instead of deleted.' })
  }

  try {
    await prisma.eSIMPackage.delete({ where: { id: params.id } })
    return NextResponse.json({ success: true, deleted: true })
  } catch (err: any) {
    if (err.code === 'P2003') {
      await prisma.eSIMPackage.update({
        where: { id: params.id },
        data: { isActive: false, hiddenFromCatalog: true, archivedAt: new Date() },
      })
      return NextResponse.json({ success: true, archived: true, message: 'Package has dependent records. Archived instead of deleted.' })
    }
    throw err
  }
}
