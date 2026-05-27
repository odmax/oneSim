import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { stripPackageProviderFields, stripEsimProviderFields, stripPurchaseProviderFields } from '@/lib/analytics/safe-fields'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const businessId = searchParams.get('businessId')

    if (session.user.role === 'INTERNAL_ADMIN') {
      const where = businessId ? { businessId } : {}
      const purchases = await prisma.eSIMPurchase.findMany({
        where,
        include: {
          business: true,
          package: true,
          esims: true
        },
        orderBy: { createdAt: 'desc' }
      })
      return NextResponse.json(purchases)
    }

    if (session.user.role === 'BUSINESS_USER') {
      const purchases = await prisma.eSIMPurchase.findMany({
        where: { businessId: session.user.businessId! },
        include: {
          package: true,
          esims: true
        },
        orderBy: { createdAt: 'desc' }
      })
      const sanitized = purchases.map(p => ({
        ...stripPurchaseProviderFields(p),
        package: stripPackageProviderFields(p.package),
        esims: p.esims.map(e => stripEsimProviderFields(e)),
      }))
      return NextResponse.json(sanitized)
    }

    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  } catch (error) {
    console.error('Error fetching purchases:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
