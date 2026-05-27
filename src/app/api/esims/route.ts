import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { stripPackageProviderFields, stripEsimProviderFields, stripPurchaseProviderFields } from '@/lib/analytics/safe-fields'

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.user.role !== 'INTERNAL_ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const businessId = searchParams.get('businessId')
  const status = searchParams.get('status')

  const where: any = {}

  if (businessId) {
    where.purchase = { businessId }
  }

  if (status) {
    where.status = status
  }

  const esims = await prisma.eSIM.findMany({
    where,
    include: {
      purchase: {
        include: {
          business: true,
          package: true,
        },
      },
      usageRecords: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  const sanitized = esims.map(esim => ({
    ...stripEsimProviderFields(esim),
    purchase: esim.purchase ? {
      ...stripPurchaseProviderFields(esim.purchase),
      package: stripPackageProviderFields(esim.purchase.package),
      business: esim.purchase.business ? { id: esim.purchase.business.id, name: esim.purchase.business.name } : undefined,
    } : null,
  }))

  return NextResponse.json(sanitized)
}
